import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import type { ApiCaller } from "@/lib/public-api.server";
import { MAX_DOCUMENT_MB } from "@/lib/public-api";
import type { TemplateComponent } from "@/lib/templates";
import { parseMediaInput, type MediaInput } from "@/lib/public-api-media.server";

/**
 * POST /api/v1/messages/template — one approved template to one customer,
 * from the merchant's own software.
 *
 * Batch 34 sent a template with a DOCUMENT header (an invoice PDF). Batch 37
 * (v1.1) sends any approved template: a header that is none, text (its own
 * values), an image, a video, a document or a map pin; the body's values; and
 * the values its buttons take (a link's {{1}}, a quick reply's payload, a
 * coupon code, a one-time code). Everything is checked against the
 * template's own stored components before anything is sent. A Batch 34
 * request ({ document, body_params }) works exactly as it did, byte for byte
 * — the same Meta request, the same answers, the same idempotency check.
 *
 * Nothing here is a second sender. The message leaves through
 * sendCampaignTemplate (the one-message template sender flows and the
 * platform's own invoices use), with a file uploaded to Meta first and sent
 * by media id; the row it writes is an ordinary messages row (type template)
 * carrying metadata.source "api", so the inbox, analytics and the wallet
 * (priced and debited on delivery by the same database triggers as every
 * send) treat it like any other template. Phone formatting is normalizePhone /
 * toWaId, the opt-out rule is the inbox's (contactOptedOut +
 * optedOutMayReceive: never a marketing template to someone who opted out),
 * the template is read through templateVariableSpec /
 * buildTemplatePayloadComponents, the credit check is creditsCover with the
 * workspace's client rate, files are read by readMediaFile (SSRF-safe).
 *
 * Every refusal happens before anything is sent. Never logs a key or a file.
 */

export const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_MB * 1024 * 1024;
/** A base64 PDF of 16 MB is ~21.4 MB of JSON. */
export const MAX_REQUEST_BYTES = 23 * 1024 * 1024;
export const DOCUMENT_FETCH_TIMEOUT_MS = 15_000;
const MAX_PARAM_CHARS = 1024;
const MAX_BUTTON_PARAM_CHARS = 2000;
const MAX_PAYLOAD_CHARS = 256;
/** WhatsApp's own limit for a coupon / one-time code. */
const MAX_CODE_CHARS = 15;

export type ApiAnswer = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

const fail = (status: number, code: string, error: string): ApiAnswer => ({
  status,
  body: { error, code },
});

export type HeaderInput =
  | { type: "text"; params: string[] }
  | { type: "image" | "video" | "document"; media: MediaInput }
  | {
      type: "location";
      latitude: number;
      longitude: number;
      name: string | null;
      address: string | null;
    };

export type ButtonInput = {
  index: number;
  type: "url" | "quick_reply" | "copy_code";
  value: string;
};

export type SendRequest = {
  to: string;
  templateName: string;
  language: string | null;
  /** Batch 34's field: the PDF for a document header. Null when not given. */
  document: { url: string | null; base64: string | null; filename: string } | null;
  /** Batch 37: the header, in its general form. */
  header: HeaderInput | null;
  bodyParams: string[];
  buttons: ButtonInput[];
  /** When a limited-time offer's countdown ends (ISO time). */
  offerExpiresAt: string | null;
  idempotencyKey: string | null;
  /** Only Batch 34 fields were used: the idempotency fingerprint is Batch 34's. */
  legacy: boolean;
};

/** One template value, checked as WhatsApp checks it. Null when fine, else why not. */
function paramProblem(value: string, label: string): string | null {
  if (!value) return `${label} is empty.`;
  if (value.length > MAX_PARAM_CHARS)
    return `${label} is longer than ${MAX_PARAM_CHARS} characters.`;
  // WhatsApp refuses a template value with a new line, a tab or more than four spaces in a row.
  if (/[\n\r\t]| {5,}/.test(value))
    return `${label} can't contain a new line, a tab or more than four spaces in a row.`;
  return null;
}

function parseParams(raw: unknown, field: string, code: string): string[] | ApiAnswer {
  if (!Array.isArray(raw)) return fail(400, code, `\`${field}\` must be an array of strings.`);
  const out: string[] = [];
  for (const [i, p] of raw.entries()) {
    if (typeof p !== "string" && typeof p !== "number") {
      return fail(400, code, `${field}[${i}] must be a string.`);
    }
    const value = String(p).trim();
    const problem = paramProblem(value, `${field}[${i}]`);
    if (problem) return fail(400, code, problem);
    out.push(value);
  }
  return out;
}

/** Fields Batch 34 didn't have: a request with none of them is a Batch 34 request. */
const V11_FIELDS = ["header", "buttons", "offer_expires_at"];

/** The request body, checked for shape. Never reads anything else. */
export function parseSendRequest(raw: unknown, headerKey: string | null): SendRequest | ApiAnswer {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail(400, "invalid_json", "The request body must be a JSON object.");
  const body = raw as Record<string, unknown>;

  const to =
    typeof body["to"] === "string" || typeof body["to"] === "number"
      ? String(body["to"]).trim()
      : "";
  if (!to)
    return fail(
      400,
      "invalid_to",
      "`to` is required: the customer's WhatsApp number with its country code.",
    );

  const templateName =
    typeof body["template_name"] === "string" ? body["template_name"].trim() : "";
  if (!templateName) return fail(400, "invalid_template_name", "`template_name` is required.");

  const language =
    typeof body["language"] === "string" && body["language"].trim()
      ? body["language"].trim()
      : null;

  // ---- Batch 34's document ----
  let document: SendRequest["document"] = null;
  if (body["document"] !== undefined && body["document"] !== null) {
    const media = parseMediaInput(body["document"], {
      kind: "document",
      field: "document",
      invalid: "invalid_document",
      required: "`document` is required: { url } (https) or { base64 }, with a filename.",
    });
    if ("status" in media) return media;
    document = {
      url: media.url,
      base64: media.base64,
      filename: cleanFilename(media.filename ?? ""),
    };
  }

  // ---- Batch 37's header ----
  let header: HeaderInput | null = null;
  const rawHeader = body["header"];
  if (rawHeader !== undefined && rawHeader !== null) {
    if (document) {
      return fail(
        400,
        "invalid_header",
        "Send the document either as `document` or as `header`, not both.",
      );
    }
    if (typeof rawHeader !== "object" || Array.isArray(rawHeader))
      return fail(400, "invalid_header", "`header` must be an object with a `type`.");
    const h = rawHeader as Record<string, unknown>;
    const type = String(h["type"] ?? "").toLowerCase();
    if (type === "text") {
      const params = parseParams(h["params"] ?? [], "header.params", "invalid_header");
      if ("status" in params) return params;
      header = { type: "text", params };
    } else if (type === "image" || type === "video" || type === "document") {
      const media = parseMediaInput(h, {
        kind: type,
        field: "header",
        invalid: type === "document" ? "invalid_document" : "invalid_header",
        required: "`header` must be an object.",
      });
      if ("status" in media) return media;
      header = { type, media };
    } else if (type === "location") {
      const latitude = Number(h["latitude"]);
      const longitude = Number(h["longitude"]);
      if (
        h["latitude"] === undefined ||
        h["longitude"] === undefined ||
        !Number.isFinite(latitude) ||
        !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 ||
        Math.abs(longitude) > 180
      ) {
        return fail(
          400,
          "invalid_header",
          "A location header needs `header.latitude` (-90 to 90) and `header.longitude` (-180 to 180).",
        );
      }
      const text = (k: string) =>
        typeof h[k] === "string" && (h[k] as string).trim()
          ? (h[k] as string).trim().slice(0, 1000)
          : null;
      header = {
        type: "location",
        latitude,
        longitude,
        name: text("name"),
        address: text("address"),
      };
    } else {
      return fail(
        400,
        "invalid_header",
        "`header.type` must be one of: text, image, video, document, location.",
      );
    }
  }

  const bodyParams = parseParams(body["body_params"] ?? [], "body_params", "invalid_body_params");
  if ("status" in bodyParams) return bodyParams;

  // ---- buttons ----
  const buttons: ButtonInput[] = [];
  const rawButtons = body["buttons"] ?? [];
  if (!Array.isArray(rawButtons))
    return fail(400, "invalid_buttons", "`buttons` must be an array.");
  if (rawButtons.length > 10)
    return fail(400, "invalid_buttons", "A template has at most 10 buttons.");
  for (const [i, raw] of rawButtons.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return fail(400, "invalid_buttons", `buttons[${i}] must be an object.`);
    const b = raw as Record<string, unknown>;
    const index = Number(b["index"]);
    if (!Number.isInteger(index) || index < 0 || index > 9)
      return fail(
        400,
        "invalid_buttons",
        `buttons[${i}].index must be the button's position, 0 to 9.`,
      );
    if (buttons.some((x) => x.index === index))
      return fail(400, "invalid_buttons", `buttons has index ${index} twice.`);
    const type = String(b["type"] ?? "").toLowerCase();
    const field =
      type === "url"
        ? "url_param"
        : type === "quick_reply"
          ? "payload"
          : type === "copy_code"
            ? "code"
            : null;
    if (!field)
      return fail(
        400,
        "invalid_buttons",
        `buttons[${i}].type must be one of: url, quick_reply, copy_code.`,
      );
    const value =
      typeof b[field] === "string" || typeof b[field] === "number" ? String(b[field]).trim() : "";
    if (!value) return fail(400, "invalid_buttons", `buttons[${i}].${field} is required.`);
    const max =
      type === "url"
        ? MAX_BUTTON_PARAM_CHARS
        : type === "copy_code"
          ? MAX_CODE_CHARS
          : MAX_PAYLOAD_CHARS;
    if (value.length > max)
      return fail(
        400,
        "invalid_buttons",
        `buttons[${i}].${field} is longer than ${max} characters.`,
      );
    if (/[\n\r\t]/.test(value))
      return fail(
        400,
        "invalid_buttons",
        `buttons[${i}].${field} can't contain a new line or a tab.`,
      );
    buttons.push({ index, type: type as ButtonInput["type"], value });
  }

  // ---- a limited-time offer's end ----
  let offerExpiresAt: string | null = null;
  const rawOffer = body["offer_expires_at"];
  if (rawOffer !== undefined && rawOffer !== null && rawOffer !== "") {
    const at = typeof rawOffer === "number" ? rawOffer : Date.parse(String(rawOffer));
    if (!Number.isFinite(at) || at <= 0)
      return fail(
        400,
        "invalid_offer",
        "`offer_expires_at` must be a time (ISO 8601, e.g. 2026-11-30T18:29:00Z) or milliseconds since 1970.",
      );
    offerExpiresAt = new Date(at).toISOString();
  }

  const keyRaw = body["idempotency_key"] ?? headerKey;
  let idempotencyKey: string | null = null;
  if (keyRaw !== undefined && keyRaw !== null && keyRaw !== "") {
    if (typeof keyRaw !== "string" || !/^[A-Za-z0-9_\-.:]{1,255}$/.test(keyRaw)) {
      return fail(
        400,
        "invalid_idempotency_key",
        "`idempotency_key` must be 1–255 letters, digits or _ - . :",
      );
    }
    idempotencyKey = keyRaw;
  }

  return {
    to,
    templateName,
    language,
    document,
    header,
    bodyParams,
    buttons,
    offerExpiresAt,
    idempotencyKey,
    legacy: Boolean(document) && V11_FIELDS.every((k) => body[k] === undefined),
  };
}

// Control characters are exactly what a file name must lose.
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f"<>|*?]/g;

/** A file name the customer sees: no path, no control characters, ending in .pdf. */
export function cleanFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(UNSAFE_FILENAME_CHARS, "").trim().slice(0, 120);
  if (!clean) return "document.pdf";
  return /\.pdf$/i.test(clean) ? clean : `${clean}.pdf`;
}

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
}

type TemplateRow = {
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: unknown;
};

/** What the send needs from a request, once the template has checked it. */
export type TemplatePlan = {
  template: TemplateRow;
  variables: (params: string[]) => Record<string, string>;
  /** The header's own values ({{1}}… of a text header), else null. */
  headerValues: Record<string, string> | null;
  /** The file to read and upload for a media header, else null (none, or the template's own). */
  headerMedia: MediaInput | null;
  headerLocation: { latitude: string; longitude: string; name?: string; address?: string } | null;
  buttonParams: Record<number, string>;
  quickReplyPayloads: Record<number, string>;
  couponCode: string | null;
};

const BUTTON_WORDS: Record<string, string> = {
  URL: "link",
  QUICK_REPLY: "quick reply",
  COPY_CODE: "copy code",
  OTP: "one-time code",
  PHONE_NUMBER: "call",
  FLOW: "form",
};

/**
 * The request held against the template's own components: every value the
 * template takes is given, nothing it doesn't take is. A refusal names the
 * part and what to send.
 */
export function planTemplateSend(
  template: TemplateRow,
  request: Pick<SendRequest, "document" | "header" | "bodyParams" | "buttons" | "offerExpiresAt">,
  helpers: {
    templateVariableSpec: typeof import("@/lib/templates").templateVariableSpec;
    templateBodyText: typeof import("@/lib/templates").templateBodyText;
    templateButtons: typeof import("@/lib/templates").templateButtons;
    extractVariables: typeof import("@/lib/templates").extractVariables;
  },
): { ok: true; plan: TemplatePlan } | { ok: false; answer: ApiAnswer } {
  const no = (code: string, error: string) => ({
    ok: false as const,
    answer: fail(400, code, error),
  });
  const name = template.name;
  const components = (template.components ?? []) as TemplateComponent[];
  const spec = helpers.templateVariableSpec(components);
  const headerFormat = spec.headerMedia?.format ?? null;

  // Batch 34's question first, in its own words: a PDF needs a document header.
  if (request.document && headerFormat !== "DOCUMENT") {
    return no(
      "template_not_document",
      `Template "${name}" has no document header, so it can't carry a PDF.`,
    );
  }
  if (/\{\{\s*[A-Za-z_][\w]*\s*\}\}/.test(helpers.templateBodyText(components))) {
    return no(
      "template_unsupported",
      `Template "${name}" uses named values; the API fills numbered ones ({{1}}, {{2}}…).`,
    );
  }
  if (spec.cards.length) {
    return no(
      "template_unsupported",
      `Template "${name}" is a carousel; the API doesn't send carousel templates yet.`,
    );
  }
  const templateButtons = helpers.templateButtons(components);
  for (const b of templateButtons) {
    const t = String(b["type"] ?? "").toUpperCase();
    if (t === "CATALOG" || t === "MPM" || t === "SPM" || t === "ORDER_DETAILS") {
      return no(
        "template_unsupported",
        `Template "${name}" has a ${t.toLowerCase()} button, which the API doesn't send yet.`,
      );
    }
  }

  // ---- header ----
  let headerValues: Record<string, string> | null = null;
  let headerMedia: MediaInput | null = null;
  let headerLocation: TemplatePlan["headerLocation"] = null;
  const given = request.header;
  if (headerFormat === "DOCUMENT") {
    if (request.document) {
      headerMedia = {
        kind: "document",
        url: request.document.url,
        base64: request.document.base64,
        filename: request.document.filename,
        caption: null,
        field: "document",
      };
    } else if (given?.type === "document") {
      headerMedia = given.media;
    } else if (given) {
      return no(
        "header_mismatch",
        `Template "${name}" has a document header; \`header.type\` is "${given.type}".`,
      );
    } else {
      // Never the template's sample file: a document is each customer's own.
      return no(
        "invalid_document",
        "`document` is required: { url } (https) or { base64 }, with a filename.",
      );
    }
  } else if (headerFormat === "IMAGE" || headerFormat === "VIDEO") {
    const kind = headerFormat === "IMAGE" ? "image" : "video";
    if (given?.type === kind) headerMedia = given.media;
    else if (given)
      return no(
        "header_mismatch",
        `Template "${name}" has ${kind === "image" ? "an image" : "a video"} header; \`header.type\` is "${given.type}".`,
      );
    else if (!spec.headerMedia?.url)
      return no(
        "header_required",
        `Template "${name}" has ${kind === "image" ? "an image" : "a video"} header: send \`header: { "type": "${kind}", "url": "https://…" }\` (or "base64").`,
      );
    // else: the template's own picture / video, as campaigns send it.
  } else if (headerFormat === "LOCATION") {
    if (given?.type !== "location")
      return no(
        given ? "header_mismatch" : "header_required",
        `Template "${name}" has a location header: send \`header: { "type": "location", "latitude": …, "longitude": … }\`.`,
      );
    headerLocation = {
      latitude: String(given.latitude),
      longitude: String(given.longitude),
      ...(given.name ? { name: given.name } : {}),
      ...(given.address ? { address: given.address } : {}),
    };
  } else if (spec.header.length) {
    const params = given?.type === "text" ? given.params : null;
    if (given && !params)
      return no(
        "header_mismatch",
        `Template "${name}" has a text header; \`header.type\` is "${given.type}".`,
      );
    if (!params || params.length !== spec.header.length)
      return no(
        "param_count_mismatch",
        `Template "${name}"'s header takes ${spec.header.length} value(s); header.params has ${params?.length ?? 0}.`,
      );
    headerValues = Object.fromEntries(spec.header.map((n, i) => [String(n), params[i]!]));
  } else if (given) {
    return no(
      "header_mismatch",
      given.type === "text"
        ? `Template "${name}"'s header has no values to fill; leave \`header\` out.`
        : `Template "${name}" has no ${given.type} header; leave \`header\` out.`,
    );
  }

  // ---- body ----
  if (spec.body.length !== request.bodyParams.length) {
    return no(
      "param_count_mismatch",
      `Template "${name}" takes ${spec.body.length} body value(s); body_params has ${request.bodyParams.length}.`,
    );
  }

  // ---- buttons ----
  const buttonParams: Record<number, string> = {};
  const quickReplyPayloads: Record<number, string> = {};
  let couponCode: string | null = null;
  const givenAt = new Map(request.buttons.map((b) => [b.index, b]));
  for (const [index, b] of templateButtons.entries()) {
    const t = String(b["type"] ?? "").toUpperCase();
    const label = `button ${index} (${BUTTON_WORDS[t] ?? t.toLowerCase()} "${String(b["text"] ?? "")}")`;
    const mine = givenAt.get(index);
    givenAt.delete(index);
    const takesUrl =
      (t === "URL" && helpers.extractVariables(String(b["url"] ?? "")).length > 0) || t === "OTP";
    const wants = takesUrl
      ? "url"
      : t === "COPY_CODE"
        ? "copy_code"
        : t === "QUICK_REPLY"
          ? "quick_reply"
          : null;
    const field = wants === "url" ? "url_param" : wants === "copy_code" ? "code" : "payload";
    if (!wants) {
      if (mine)
        return no(
          "invalid_buttons",
          `Template "${name}"'s ${label} takes no value; leave it out of \`buttons\`.`,
        );
      continue;
    }
    if (mine && mine.type !== wants)
      return no(
        "invalid_buttons",
        `Template "${name}"'s ${label} is a ${wants} button; buttons with index ${index} says "${mine.type}".`,
      );
    if (!mine) {
      if (wants === "quick_reply") continue; // a payload is optional
      return no(
        "invalid_buttons",
        `Template "${name}"'s ${label} needs a value: send \`buttons: [{ "index": ${index}, "type": "${wants}", "${field}": "…" }]\`.`,
      );
    }
    if (t === "OTP" && mine.value.length > MAX_CODE_CHARS)
      return no(
        "invalid_buttons",
        `Template "${name}"'s ${label} takes a code of at most ${MAX_CODE_CHARS} characters; url_param is longer than that.`,
      );
    if (wants === "url") buttonParams[index] = mine.value;
    else if (wants === "copy_code") couponCode = mine.value;
    else quickReplyPayloads[index] = mine.value;
  }
  const extra = [...givenAt.keys()][0];
  if (extra !== undefined)
    return no("invalid_buttons", `Template "${name}" has no button ${extra}.`);

  // ---- a limited-time offer ----
  if (spec.offerExpiration && !request.offerExpiresAt)
    return no(
      "invalid_offer",
      `Template "${name}" counts down to the offer's end: send \`offer_expires_at\`.`,
    );

  return {
    ok: true,
    plan: {
      template,
      variables: (params) => Object.fromEntries(spec.body.map((n, i) => [String(n), params[i]!])),
      headerValues,
      headerMedia,
      headerLocation,
      buttonParams,
      quickReplyPayloads,
      couponCode,
    },
  };
}

/**
 * The workspace's approved template for this request, on the number's
 * business account (one language, or the one asked for), checked against
 * the request (planTemplateSend). `request` left out: a Batch 34 request — a
 * document and `paramCount` body values.
 */
export async function resolveApiTemplate(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    wabaId: string;
    name: string;
    language: string | null;
    paramCount: number;
    request?: Pick<
      SendRequest,
      "document" | "header" | "bodyParams" | "buttons" | "offerExpiresAt"
    >;
  },
): Promise<({ ok: true } & TemplatePlan) | { ok: false; answer: ApiAnswer }> {
  const templates = await import("@/lib/templates");
  const { data, error } = await supabase
    .from("message_templates")
    .select("name, language, category, status, components")
    .eq("organization_id", input.organizationId)
    .eq("waba_id", input.wabaId)
    .eq("name", input.name)
    .limit(20);
  if (error)
    return {
      ok: false,
      answer: fail(503, "unavailable", "We couldn't read your templates. Please try again."),
    };
  const rows = (data ?? []) as TemplateRow[];
  const named = rows.filter((r) => !input.language || r.language === input.language);
  if (!named.length) {
    return {
      ok: false,
      answer: fail(
        400,
        "template_not_found",
        input.language && rows.length
          ? `Template "${input.name}" has no "${input.language}" version. It has: ${rows.map((r) => r.language).join(", ")}.`
          : `There is no template named "${input.name}" on this workspace's WhatsApp number.`,
      ),
    };
  }
  const approved = named.filter((r) => r.status === "APPROVED");
  if (!approved.length) {
    return {
      ok: false,
      answer: fail(
        400,
        "template_not_approved",
        `Template "${input.name}" isn't approved by Meta yet (status ${named[0]!.status}).`,
      ),
    };
  }
  if (approved.length > 1) {
    return {
      ok: false,
      answer: fail(
        400,
        "language_required",
        `Template "${input.name}" is approved in ${approved.map((r) => r.language).join(", ")} — say which with \`language\`.`,
      ),
    };
  }
  const request = input.request ?? {
    document: { url: null, base64: "", filename: "document.pdf" },
    header: null,
    bodyParams: Array.from({ length: input.paramCount }, () => "x"),
    buttons: [],
    offerExpiresAt: null,
  };
  const planned = planTemplateSend(approved[0]!, request, templates);
  if (!planned.ok) return planned;
  return { ok: true, ...planned.plan };
}

const RATE_COUNTRY_TTL_MS = 10 * 60_000;
let dialCodes: { at: number; rows: Array<{ dial_code: string; country_code: string }> } | null =
  null;

/** The phone's country from the rate card's dial codes (longest match), as the debit itself finds it. */
export async function countryForPhone(supabase: SupabaseClient, digits: string): Promise<string> {
  if (!dialCodes || Date.now() - dialCodes.at > RATE_COUNTRY_TTL_MS) {
    const { data } = await supabase
      .from("message_rates")
      .select("dial_code, country_code")
      .limit(2000);
    const rows = ((data ?? []) as Array<{ dial_code: string | null; country_code: string | null }>)
      .filter((r) => r.dial_code && r.country_code)
      .map((r) => ({ dial_code: String(r.dial_code), country_code: String(r.country_code) }))
      .sort((a, b) => b.dial_code.length - a.dial_code.length);
    dialCodes = { at: Date.now(), rows };
  }
  return dialCodes.rows.find((r) => digits.startsWith(r.dial_code))?.country_code ?? "IN";
}

/** Test hook. */
export function resetDialCodeCache(): void {
  dialCodes = null;
}

/** The idempotency fingerprint: Batch 34's own for a Batch 34 request, else every field. */
async function sendFingerprint(parsed: SendRequest, waId: string): Promise<string> {
  const lib = await import("@/lib/public-api.server");
  if (parsed.legacy && parsed.document) {
    return lib.requestFingerprint({
      to: waId,
      template_name: parsed.templateName,
      language: parsed.language,
      body_params: parsed.bodyParams,
      document_url: parsed.document.url,
      document_sha256: parsed.document.base64
        ? createHash("sha256").update(parsed.document.base64).digest("hex")
        : null,
      filename: parsed.document.filename,
    });
  }
  const { mediaFingerprint } = await import("@/lib/public-api-media.server");
  const header = parsed.header;
  return lib.requestFingerprint({
    v: "1.1",
    to: waId,
    template_name: parsed.templateName,
    language: parsed.language,
    body_params: parsed.bodyParams,
    document: parsed.document
      ? {
          url: parsed.document.url,
          sha256: parsed.document.base64
            ? createHash("sha256").update(parsed.document.base64).digest("hex")
            : null,
          filename: parsed.document.filename,
        }
      : null,
    header: !header
      ? null
      : header.type === "text"
        ? { type: "text", params: header.params }
        : header.type === "location"
          ? header
          : { type: header.type, media: mediaFingerprint(header.media) },
    buttons: [...parsed.buttons].sort((a, b) => a.index - b.index),
    offer_expires_at: parsed.offerExpiresAt,
  });
}

/**
 * The whole send, for one authenticated caller (the route checked the key,
 * the flag and the rate limit). `raw` is the parsed JSON body.
 */
export async function sendTemplateViaApi(
  supabase: SupabaseClient,
  caller: ApiCaller,
  raw: unknown,
  options: { idempotencyHeader?: string | null } = {},
): Promise<ApiAnswer> {
  const parsed = parseSendRequest(raw, options.idempotencyHeader ?? null);
  if ("status" in parsed) return parsed;
  const orgId = caller.organizationId;
  const { normalizePhone, toWaId, logServerActivity } = await import("@/lib/whatsapp-api.server");

  const phone = normalizePhone(parsed.to);
  const waId = toWaId(phone);
  if (waId.length < 8 || waId.length > 15) {
    return fail(
      400,
      "invalid_to",
      "`to` isn't a valid WhatsApp number. Include the country code, e.g. +919812345678.",
    );
  }

  // ---- reserve the idempotency key first: a repeat gets the first answer,
  // whatever changed since (a template paused, a plan lapsed) ----
  const lib = await import("@/lib/public-api.server");
  let requestId: string | null = null;
  if (parsed.idempotencyKey) {
    const reserved = await lib.reserveIdempotency(supabase, caller, {
      key: parsed.idempotencyKey,
      requestHash: await sendFingerprint(parsed, waId),
    });
    if ("status" in reserved) return reserved;
    requestId = reserved.id;
  }
  // Refused before sending: the key is free again for a corrected retry.
  const refuse = async (answer: ApiAnswer): Promise<ApiAnswer> => {
    if (requestId) await lib.releaseIdempotency(supabase, requestId);
    return answer;
  };
  // Once the send starts Meta may have the message: from then on a reserved
  // key stays reserved, whatever happens.
  let sendStarted = false;
  try {
    // A locked or paused workspace spends nothing until a plan is chosen (as the inbox).
    const { data: org } = await supabase
      .from("organizations")
      .select("plan_status")
      .eq("id", orgId)
      .maybeSingle();
    const planStatus = (org as { plan_status?: string | null } | null)?.plan_status ?? null;
    if (planStatus === "locked" || planStatus === "paused") {
      return refuse(
        fail(
          402,
          "workspace_locked",
          "This workspace is locked — choose a plan in AiDwar to send again.",
        ),
      );
    }

    const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
    const { connection, error: connectionError } = await getWhatsAppConnection(
      supabase,
      orgId,
      null,
    );
    if (!connection)
      return refuse(
        fail(
          400,
          "no_whatsapp_number",
          connectionError ?? "Connect a WhatsApp number in AiDwar first.",
        ),
      );

    const resolved = await resolveApiTemplate(supabase, {
      organizationId: orgId,
      wabaId: connection.wabaId,
      name: parsed.templateName,
      language: parsed.language,
      paramCount: parsed.bodyParams.length,
      request: parsed,
    });
    if (!resolved.ok) return refuse(resolved.answer);
    const template = resolved.template;
    const category = String(template.category ?? "utility").toLowerCase();

    // ---- the customer: never a marketing template to someone who opted out
    // (the inbox's rule, Batch 35: utility and authentication still go) ----
    const { contactOptedOut, optedOutMayReceive } = await import("@/lib/opt-out.server");
    const optOut = await contactOptedOut(supabase, orgId, { phone });
    if (optOut.error)
      return refuse(
        fail(503, "unavailable", "We couldn't confirm this customer's opt-in. Please try again."),
      );
    if (optOut.optedOut && !optedOutMayReceive(template.category)) {
      return refuse(
        fail(
          409,
          "contact_opted_out",
          "This customer has opted out of marketing messages from this business, so a marketing template can't be sent (utility and authentication templates still can). Nothing was sent.",
        ),
      );
    }

    // ---- credits: the same sum a campaign hold checks, at this customer's rate ----
    const billing = await import("@/lib/billing.server");
    if (await billing.billingEnabled(supabase, orgId)) {
      const country = await countryForPhone(supabase, waId);
      const { rate } = await billing.rateFor(
        supabase,
        orgId,
        category as import("@/lib/billing").MessageCategory,
        country,
      );
      const cover = await billing.creditsCover(supabase, orgId, rate);
      if (!cover.covers) {
        return refuse(
          fail(
            402,
            "insufficient_credits",
            "There aren't enough credits in this workspace's AiDwar wallet to send this message. Top up and send again. Nothing was sent.",
          ),
        );
      }
    }

    // ---- the header's file, then Meta's copy of it, by media id ----
    let file: import("@/lib/public-api-media.server").MediaFile | null = null;
    let headerMediaId: string | null = null;
    if (resolved.headerMedia) {
      const { readMediaFile } = await import("@/lib/public-api-media.server");
      const read = await readMediaFile(resolved.headerMedia, {
        // A template's document header carries a PDF.
        ...(resolved.headerMedia.kind === "document" ? { only: ["application/pdf"] } : {}),
      });
      if ("status" in read) return refuse(read);
      file = {
        ...read,
        // Batch 34: the document's name is the one the request gave, as cleaned then.
        filename:
          resolved.headerMedia.kind === "document"
            ? cleanFilename(resolved.headerMedia.filename ?? "")
            : read.filename,
      };
      const { uploadMessageMedia } = await import("@/lib/whatsapp-api.server");
      const uploaded = await uploadMessageMedia(connection.phoneNumberId, connection.accessToken, {
        bytes: file.bytes,
        mime: file.mime,
        filename: file.filename,
      });
      if (!uploaded.ok) {
        return refuse(
          fail(
            502,
            "whatsapp_upload_failed",
            `WhatsApp didn't accept the ${resolved.headerMedia.kind}: ${uploaded.error} Nothing was sent.`,
          ),
        );
      }
      headerMediaId = uploaded.id;
    }
    const isDocument = resolved.headerMedia?.kind === "document";

    // ---- the contact (first touch: source "api"; an existing contact keeps its own) ----
    await supabase
      .from("contacts")
      .upsert(
        { organization_id: orgId, phone, wa_id: waId, source: "api" },
        { onConflict: "organization_id,phone", ignoreDuplicates: true },
      );
    const { data: contact } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("phone", phone)
      .maybeSingle();
    const contactId = (contact as { id?: string } | null)?.id ?? null;

    // ---- the send: the one-message template sender ----
    const metadata = {
      source: "api",
      api_key_id: caller.keyId,
      idempotency_key: parsed.idempotencyKey,
      ...(requestId ? { api_request_id: requestId } : {}),
      ...(isDocument && file ? { document_filename: file.filename } : {}),
      to: phone,
    };
    const { sendCampaignTemplate } = await import("@/lib/campaigns.server");
    sendStarted = true;
    const outcome = await sendCampaignTemplate(
      supabase,
      orgId,
      {
        accountId: connection.accountId,
        wabaId: connection.wabaId,
        phoneNumberId: connection.phoneNumberId,
        accessToken: connection.accessToken,
      },
      { contactId, phone: waId, variables: resolved.variables(parsed.bodyParams) },
      {
        name: template.name,
        language: template.language,
        variableOrder: [],
        components: (template.components ?? null) as TemplateComponent[] | null,
      },
      {
        campaignId: null,
        category,
        ...(headerMediaId
          ? {
              headerMediaId,
              ...(isDocument && file ? { headerFileName: file.filename } : {}),
            }
          : {}),
        ...(resolved.headerLocation ? { headerLocation: resolved.headerLocation } : {}),
        ...(resolved.headerValues ? { headerValues: resolved.headerValues } : {}),
        ...(Object.keys(resolved.buttonParams).length
          ? { buttonParams: resolved.buttonParams }
          : {}),
        ...(Object.keys(resolved.quickReplyPayloads).length
          ? { quickReplyPayloads: resolved.quickReplyPayloads }
          : {}),
        ...(resolved.couponCode ? { couponCode: resolved.couponCode } : {}),
        ...(parsed.offerExpiresAt ? { offerExpiresAt: parsed.offerExpiresAt } : {}),
        messageMetadata: metadata,
      },
    );

    const messageId = outcome.messageId;
    let wamid: string | null = null;
    if (messageId && file) {
      const { keepMediaCopy } = await import("@/lib/public-api-media.server");
      ({ wamid } = await keepMediaCopy(supabase, {
        organizationId: orgId,
        messageId,
        bytes: file.bytes,
        mime: file.mime,
      }));
    } else if (messageId) {
      const { data: sentRow } = await supabase
        .from("messages")
        .select("meta_message_id")
        .eq("id", messageId)
        .maybeSingle();
      wamid = (sentRow as { meta_message_id?: string | null } | null)?.meta_message_id ?? null;
    }

    if (outcome.error) {
      // Meta refused it at once: the merchant's webhook hears message.failed
      // too, as for a failure Meta reports later.
      if (messageId) {
        const { enqueueApiWebhookEvent } = await import("@/lib/public-api-webhooks.server");
        const { data: failedRow } = await supabase
          .from("messages")
          .select("error_detail")
          .eq("id", messageId)
          .maybeSingle();
        await enqueueApiWebhookEvent(supabase, {
          organizationId: orgId,
          messageId,
          event: "message.failed",
          occurredAt: new Date().toISOString(),
          metadata,
          error:
            (failedRow as { error_detail?: string | null } | null)?.error_detail ?? outcome.error,
        });
      }
      const answer: ApiAnswer = {
        status: 502,
        body: {
          error: `WhatsApp rejected the message: ${outcome.error}`,
          code: "whatsapp_rejected",
          message_id: messageId,
          status: "failed",
        },
      };
      if (requestId)
        await lib.finishIdempotency(supabase, requestId, {
          status: answer.status,
          body: answer.body,
          messageId,
        });
      return answer;
    }

    await logServerActivity(supabase, orgId, null, "message_sent", {
      message_type: "template",
      source: "api",
      api_key_id: caller.keyId,
      template_name: template.name,
      whatsapp_account_id: connection.accountId,
    });

    const answer: ApiAnswer = {
      status: 202,
      body: {
        message_id: messageId,
        status: "queued",
        wamid,
        idempotency_key: parsed.idempotencyKey,
      },
    };
    if (requestId)
      await lib.finishIdempotency(supabase, requestId, {
        status: answer.status,
        body: answer.body,
        messageId,
      });
    return answer;
  } catch (error) {
    if (requestId && !sendStarted) await lib.releaseIdempotency(supabase, requestId);
    throw error;
  }
}
