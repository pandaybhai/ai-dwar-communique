import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import type { ApiCaller } from "@/lib/public-api.server";
import { MAX_DOCUMENT_MB } from "@/lib/public-api";

/**
 * Batch 34: POST /api/v1/messages/template — one approved template with a
 * DOCUMENT header (an invoice PDF, say) to one customer, from the merchant's
 * own software.
 *
 * Nothing here is a second sender. The message leaves through
 * sendCampaignTemplate (the one-message template sender flows and the
 * platform's own invoices use), with the PDF uploaded to Meta first and sent
 * by media id; the row it writes is an ordinary messages row (type template)
 * carrying metadata.source "api", so the inbox, analytics and the wallet
 * (priced and debited on delivery by the same database triggers as every
 * send) treat it like any other template. Phone formatting is normalizePhone /
 * toWaId, the opt-out check is contactOptedOut, the template is read through
 * templateVariableSpec / buildTemplatePayloadComponents, the credit check is
 * creditsCover with the workspace's client rate.
 *
 * Every refusal happens before anything is sent. Never logs a key or a document.
 */

export const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_MB * 1024 * 1024;
/** A base64 PDF of 16 MB is ~21.4 MB of JSON. */
export const MAX_REQUEST_BYTES = 23 * 1024 * 1024;
export const DOCUMENT_FETCH_TIMEOUT_MS = 15_000;
const MAX_PARAM_CHARS = 1024;

export type ApiAnswer = {
  status: number;
  body: Record<string, unknown>;
  headers?: Record<string, string>;
};

const fail = (status: number, code: string, error: string): ApiAnswer => ({
  status,
  body: { error, code },
});

export type SendRequest = {
  to: string;
  templateName: string;
  language: string | null;
  document: { url: string | null; base64: string | null; filename: string };
  bodyParams: string[];
  idempotencyKey: string | null;
};

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

  const doc = body["document"];
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return fail(
      400,
      "invalid_document",
      "`document` is required: { url } (https) or { base64 }, with a filename.",
    );
  }
  const d = doc as Record<string, unknown>;
  const url = typeof d["url"] === "string" && d["url"].trim() ? d["url"].trim() : null;
  const base64 = typeof d["base64"] === "string" && d["base64"].trim() ? d["base64"].trim() : null;
  if ((url ? 1 : 0) + (base64 ? 1 : 0) !== 1) {
    return fail(
      400,
      "invalid_document",
      "Send the document as exactly one of `document.url` (https) or `document.base64`.",
    );
  }
  if (url && !/^https:\/\//i.test(url))
    return fail(400, "document_url_not_https", "`document.url` must be an https:// address.");
  const filename = cleanFilename(typeof d["filename"] === "string" ? d["filename"] : "");

  const rawParams = body["body_params"] ?? [];
  if (!Array.isArray(rawParams))
    return fail(400, "invalid_body_params", "`body_params` must be an array of strings.");
  const bodyParams: string[] = [];
  for (const [i, p] of rawParams.entries()) {
    if (typeof p !== "string" && typeof p !== "number") {
      return fail(400, "invalid_body_params", `body_params[${i}] must be a string.`);
    }
    const value = String(p).trim();
    if (!value) return fail(400, "invalid_body_params", `body_params[${i}] is empty.`);
    if (value.length > MAX_PARAM_CHARS)
      return fail(
        400,
        "invalid_body_params",
        `body_params[${i}] is longer than ${MAX_PARAM_CHARS} characters.`,
      );
    // WhatsApp refuses a template value with a new line, a tab or more than four spaces in a row.
    if (/[\n\r\t]| {5,}/.test(value)) {
      return fail(
        400,
        "invalid_body_params",
        `body_params[${i}] can't contain a new line, a tab or more than four spaces in a row.`,
      );
    }
    bodyParams.push(value);
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
    document: { url, base64, filename },
    bodyParams,
    idempotencyKey,
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

/** base64 (optionally a data: URL) -> bytes, refusing anything over the limit before decoding it. */
export function decodeBase64Document(raw: string): Uint8Array | ApiAnswer {
  const text = raw.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!text || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(text))
    return fail(400, "invalid_document", "`document.base64` isn't valid base64.");
  if (Math.floor((text.length * 3) / 4) > MAX_DOCUMENT_BYTES + 2) {
    return fail(
      413,
      "document_too_large",
      "The document is larger than 16 MB, the most WhatsApp accepts.",
    );
  }
  const bytes = new Uint8Array(
    Buffer.from(text, text.includes("-") || text.includes("_") ? "base64url" : "base64"),
  );
  if (bytes.byteLength > MAX_DOCUMENT_BYTES)
    return fail(
      413,
      "document_too_large",
      "The document is larger than 16 MB, the most WhatsApp accepts.",
    );
  return bytes;
}

type TemplateRow = {
  name: string;
  language: string;
  category: string | null;
  status: string;
  components: unknown;
};

/**
 * The workspace's template for this request: it exists on the number's
 * business account, is APPROVED, has a DOCUMENT header, takes exactly the
 * body values given — and nothing else the API doesn't fill (link or code
 * buttons, a carousel, an offer countdown, named values).
 */
export async function resolveApiTemplate(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    wabaId: string;
    name: string;
    language: string | null;
    paramCount: number;
  },
): Promise<
  | { ok: true; template: TemplateRow; variables: (params: string[]) => Record<string, string> }
  | { ok: false; answer: ApiAnswer }
> {
  const { templateVariableSpec, templateBodyText } = await import("@/lib/templates");
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
  const template = approved[0]!;
  const components = (template.components ?? []) as import("@/lib/templates").TemplateComponent[];
  const spec = templateVariableSpec(components);
  if (spec.headerMedia?.format !== "DOCUMENT") {
    return {
      ok: false,
      answer: fail(
        400,
        "template_not_document",
        `Template "${input.name}" has no document header, so it can't carry a PDF.`,
      ),
    };
  }
  if (
    spec.urlButtons.length ||
    spec.copyCodeButtons.length ||
    spec.cards.length ||
    spec.offerExpiration
  ) {
    return {
      ok: false,
      answer: fail(
        400,
        "template_unsupported",
        `Template "${input.name}" needs link, code or card values the API doesn't send. Use a template with a document header and body text only.`,
      ),
    };
  }
  if (/\{\{\s*[A-Za-z_][\w]*\s*\}\}/.test(templateBodyText(components))) {
    return {
      ok: false,
      answer: fail(
        400,
        "template_unsupported",
        `Template "${input.name}" uses named values; the API fills numbered ones ({{1}}, {{2}}…).`,
      ),
    };
  }
  if (spec.body.length !== input.paramCount) {
    return {
      ok: false,
      answer: fail(
        400,
        "param_count_mismatch",
        `Template "${input.name}" takes ${spec.body.length} body value(s); body_params has ${input.paramCount}.`,
      ),
    };
  }
  return {
    ok: true,
    template,
    variables: (params) => Object.fromEntries(spec.body.map((n, i) => [String(n), params[i]!])),
  };
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
    const fingerprint = lib.requestFingerprint({
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
    const claim = await lib.claimIdempotency(supabase, {
      organizationId: orgId,
      apiKeyId: caller.keyId,
      key: parsed.idempotencyKey,
      requestHash: fingerprint,
    });
    if (claim.kind === "replay")
      return { status: claim.status, body: claim.body, headers: { "Idempotent-Replayed": "true" } };
    if (claim.kind === "in_progress") {
      return {
        ...fail(
          409,
          "idempotency_in_progress",
          "A request with this idempotency_key is still being sent. Ask again in a few seconds.",
        ),
        headers: { "Retry-After": "5" },
      };
    }
    if (claim.kind === "mismatch") {
      return fail(
        409,
        "idempotency_key_reused",
        "This idempotency_key was already used for a different request in the last 24 hours.",
      );
    }
    if (claim.kind === "error")
      return fail(503, "unavailable", "We couldn't reserve the idempotency_key. Please try again.");
    requestId = claim.id;
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
    });
    if (!resolved.ok) return refuse(resolved.answer);
    const template = resolved.template;
    const category = String(template.category ?? "utility").toLowerCase();

    // ---- the customer: never someone who opted out ----
    const { contactOptedOut } = await import("@/lib/opt-out.server");
    const optOut = await contactOptedOut(supabase, orgId, { phone });
    if (optOut.error)
      return refuse(
        fail(503, "unavailable", "We couldn't confirm this customer's opt-in. Please try again."),
      );
    if (optOut.optedOut) {
      return refuse(
        fail(
          409,
          "contact_opted_out",
          "This customer has opted out of messages from this business. Nothing was sent.",
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

    // ---- the document ----
    let bytes: Uint8Array;
    if (parsed.document.url) {
      const { fetchPublicFile } = await import("@/lib/safe-fetch.server");
      const file = await fetchPublicFile(parsed.document.url, {
        maxBytes: MAX_DOCUMENT_BYTES,
        timeoutMs: DOCUMENT_FETCH_TIMEOUT_MS,
      });
      if (!file.ok) {
        if (file.code === "too_large")
          return refuse(
            fail(
              413,
              "document_too_large",
              "The document is larger than 16 MB, the most WhatsApp accepts.",
            ),
          );
        if (file.code === "blocked") {
          return refuse(
            fail(
              400,
              "document_url_blocked",
              "`document.url` must be a public https address (no private or internal hosts, also after redirects).",
            ),
          );
        }
        if (file.code === "timeout")
          return refuse(
            fail(400, "document_unreachable", "We couldn't download `document.url` in 15 seconds."),
          );
        return refuse(
          fail(
            400,
            "document_unreachable",
            `We couldn't download \`document.url\` (${file.detail}).`,
          ),
        );
      }
      bytes = file.bytes;
    } else {
      const decoded = decodeBase64Document(parsed.document.base64!);
      if (!(decoded instanceof Uint8Array)) return refuse(decoded);
      bytes = decoded;
    }
    if (!bytes.byteLength) return refuse(fail(400, "document_empty", "The document is empty."));
    if (!isPdf(bytes)) return refuse(fail(400, "document_not_pdf", "The document must be a PDF."));

    // ---- Meta's copy, by media id ----
    const { uploadMessageMedia } = await import("@/lib/whatsapp-api.server");
    const uploaded = await uploadMessageMedia(connection.phoneNumberId, connection.accessToken, {
      bytes,
      mime: "application/pdf",
      filename: parsed.document.filename,
    });
    if (!uploaded.ok) {
      return refuse(
        fail(
          502,
          "whatsapp_upload_failed",
          `WhatsApp didn't accept the document: ${uploaded.error} Nothing was sent.`,
        ),
      );
    }

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
      document_filename: parsed.document.filename,
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
        components: (template.components ?? null) as
          import("@/lib/templates").TemplateComponent[] | null,
      },
      {
        campaignId: null,
        category,
        headerMediaId: uploaded.id,
        headerFileName: parsed.document.filename,
        messageMetadata: metadata,
      },
    );

    const messageId = outcome.messageId;
    const kept = messageId
      ? await keepDocumentCopy(supabase, { organizationId: orgId, messageId, bytes })
      : null;

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
        wamid: kept?.wamid ?? null,
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

/**
 * Our copy of the PDF in the private chat-media bucket (Batch 32), at
 * {org}/{conversation}/{message}.pdf, so the inbox shows the file the
 * customer got (served only through /api/whatsapp/chat-media/$messageId).
 * Never fails the send: the message has already gone. Gives back Meta's id
 * for the message (the wamid) from the same read.
 */
async function keepDocumentCopy(
  supabase: SupabaseClient,
  input: { organizationId: string; messageId: string; bytes: Uint8Array },
): Promise<{ wamid: string | null }> {
  let wamid: string | null = null;
  try {
    const { CHAT_MEDIA_BUCKET, STORAGE_PREFIX, chatMediaObjectPath } =
      await import("@/lib/chat-media.server");
    const { data: row } = await supabase
      .from("messages")
      .select("conversation_id, meta_message_id")
      .eq("id", input.messageId)
      .maybeSingle();
    const read = row as { conversation_id?: string | null; meta_message_id?: string | null } | null;
    wamid = read?.meta_message_id ?? null;
    const conversationId = read?.conversation_id;
    if (!conversationId) return { wamid };
    const path = chatMediaObjectPath({
      organizationId: input.organizationId,
      conversationId,
      messageId: input.messageId,
      mime: "application/pdf",
    });
    const { error } = await supabase.storage
      .from(CHAT_MEDIA_BUCKET)
      .upload(path, input.bytes, { contentType: "application/pdf", upsert: true });
    if (error) throw new Error(error.message);
    const { error: rowError } = await supabase
      .from("messages")
      .update({ media_url: `${STORAGE_PREFIX}${path}`, media_mime: "application/pdf" })
      .eq("id", input.messageId)
      .eq("organization_id", input.organizationId);
    if (rowError) throw new Error(rowError.message);
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "public_api",
        step: "document_copy",
        message_id: input.messageId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  return { wamid };
}
