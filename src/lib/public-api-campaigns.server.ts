import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import type { ApiCaller } from "@/lib/public-api.server";
import type { AudienceContact } from "@/lib/campaigns.server";
import { resolveAllVariables, type VariableMapping, type VariableMappings } from "@/lib/campaigns";
import {
  decodeCursor,
  encodeCursor,
  fail,
  validId,
  type ApiReply,
} from "@/lib/public-api-route.server";

/**
 * Batch 38 item 1: campaigns from the merchant's own software.
 *
 *   POST /api/v1/campaigns                     create and launch
 *   POST /api/v1/campaigns/estimate            recipients + cost, nothing created
 *   GET  /api/v1/campaigns                     list (status filter, cursor)
 *   GET  /api/v1/campaigns/{id}                one, with its counts
 *   POST /api/v1/campaigns/{id}/cancel         only before sending finishes
 *
 * Nothing here is a second launch: a campaign is created by launchCampaign
 * (campaign-launch.server.ts) — the very code behind the app's Launch
 * button — and sent by the campaign worker, which takes the wallet hold
 * before the first message (runCampaignDispatch). The audience is the
 * workspace's own opted-in contacts: a segment (resolveAudienceContacts), a
 * tag (tags / contact_tags), or a list of phones; a phone that isn't an
 * opted-in contact is listed in `skipped` and gets nothing. A cancel is the
 * app's cancelCampaign. Every read and write is scoped to the key's own
 * workspace; another workspace's campaign is the same 404 as one that
 * doesn't exist. Never logs a key or a body.
 */

export const MAX_CAMPAIGN_REQUEST_BYTES = 4 * 1024 * 1024;
export const MAX_AUDIENCE_PHONES = 10_000;
export const DEFAULT_LIST = 25;
export const MAX_LIST = 100;
const MAX_NAME = 120;
const MAX_VALUE_CHARS = 1024;
const MAX_TAG_CHARS = 64;

const CAMPAIGN_COLUMNS =
  "id, organization_id, name, status, template_name, template_language, segment_id, scheduled_at, started_at, completed_at, created_at, total_recipients, sent_count, delivered_count, read_count, failed_count, replied_count, estimated_cost, charged_amount, pause_reason";

export const FINISHED_STATUSES = ["completed", "cancelled", "failed"];

type CampaignRow = Record<string, unknown>;

const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);

/** A campaign as the API shows it. */
export function publicCampaign(row: CampaignRow): Record<string, unknown> {
  return {
    campaign_id: row["id"],
    name: row["name"] ?? null,
    status: row["status"] ?? null,
    template_name: row["template_name"] ?? null,
    language: row["template_language"] ?? null,
    segment_id: row["segment_id"] ?? null,
    scheduled_at: row["scheduled_at"] ?? null,
    started_at: row["started_at"] ?? null,
    completed_at: row["completed_at"] ?? null,
    created_at: row["created_at"] ?? null,
    counts: {
      recipients: num(row["total_recipients"]),
      sent: num(row["sent_count"]),
      delivered: num(row["delivered_count"]),
      read: num(row["read_count"]),
      failed: num(row["failed_count"]),
      replied: num(row["replied_count"]),
    },
    estimated_cost: numOrNull(row["estimated_cost"]),
    charged_amount: numOrNull(row["charged_amount"]),
    pause_reason: row["pause_reason"] ?? null,
  };
}

// ------------------------------------------------------------ the request

type PhoneEntry = { phone: string; values: string[] | Record<string, string> | null };

export type CampaignRequest = {
  name: string;
  templateName: string;
  language: string | null;
  audience:
    | { kind: "segment"; segmentId: string }
    | { kind: "tag"; tag: string }
    | { kind: "phones"; phones: PhoneEntry[] }
    | { kind: "all" };
  variables: Record<string, VariableMapping>;
  sendSettings: Record<string, unknown>;
  scheduleAt: Date | null;
  idempotencyKey: string | null;
};

function valueProblem(value: string, label: string): string | null {
  if (!value) return `${label} is empty.`;
  if (value.length > MAX_VALUE_CHARS)
    return `${label} is longer than ${MAX_VALUE_CHARS} characters.`;
  // WhatsApp refuses a template value with a new line, a tab or more than four spaces in a row.
  if (/[\n\r\t]| {5,}/.test(value))
    return `${label} can't contain a new line, a tab or more than four spaces in a row.`;
  return null;
}

/** A campaign-wide value: "text" (the same for everyone) or { source: name | phone | attribute, key }. */
function parseMapping(raw: unknown, label: string): VariableMapping | string {
  if (typeof raw === "string" || typeof raw === "number") {
    const value = String(raw).trim();
    return valueProblem(value, label) ?? { source: "static", value };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return `${label} must be a text or { "source": "name" | "phone" | "attribute" }.`;
  const m = raw as Record<string, unknown>;
  const source = String(m["source"] ?? "");
  if (source === "name" || source === "phone") return { source };
  if (source === "attribute") {
    const key = typeof m["key"] === "string" ? m["key"].trim() : "";
    if (!key) return `${label}: an attribute value needs its \`key\`.`;
    return { source: "attribute", key };
  }
  if (source === "static") {
    const value = typeof m["value"] === "string" ? m["value"].trim() : "";
    return valueProblem(value, label) ?? { source: "static", value };
  }
  return `${label}: \`source\` must be name, phone, attribute or static.`;
}

function parseRecipientValues(
  raw: unknown,
  label: string,
): string[] | Record<string, string> | string {
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const [i, v] of raw.entries()) {
      if (typeof v !== "string" && typeof v !== "number") return `${label}[${i}] must be a text.`;
      const value = String(v).trim();
      const problem = valueProblem(value, `${label}[${i}]`);
      if (problem) return problem;
      out.push(value);
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!/^\d{1,2}$/.test(k))
        return `${label}: keys are the template's value numbers ("1", "2"…).`;
      if (typeof v !== "string" && typeof v !== "number") return `${label}["${k}"] must be a text.`;
      const value = String(v).trim();
      const problem = valueProblem(value, `${label}["${k}"]`);
      if (problem) return problem;
      out[String(Number(k))] = value;
    }
    return out;
  }
  return `${label} must be an array of texts (in the template's order) or an object keyed by value number.`;
}

export function parseCampaignRequest(
  raw: unknown,
  options: { forEstimate: boolean; idempotencyHeader?: string | null },
): CampaignRequest | ApiReply {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail(400, "invalid_json", "The request body must be a JSON object.");
  const body = raw as Record<string, unknown>;

  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (!options.forEstimate && !name)
    return fail(400, "invalid_name", "`name` is required: what the campaign is called in AiDwar.");
  if (name.length > MAX_NAME)
    return fail(400, "invalid_name", `\`name\` is longer than ${MAX_NAME} characters.`);

  const templateName =
    typeof body["template_name"] === "string" ? body["template_name"].trim() : "";
  if (!templateName) return fail(400, "invalid_template_name", "`template_name` is required.");
  const language =
    typeof body["language"] === "string" && body["language"].trim()
      ? body["language"].trim()
      : null;

  // ---- the audience: exactly one of segment_id, tag, phones (or all: true) ----
  const a = body["audience"];
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    return fail(
      400,
      "invalid_audience",
      "`audience` is required: { segment_id }, { tag }, { phones: [...] } or { all: true }.",
    );
  }
  const aud = a as Record<string, unknown>;
  const given = ["segment_id", "tag", "phones", "all"].filter(
    (k) => aud[k] !== undefined && aud[k] !== null && aud[k] !== false,
  );
  if (given.length !== 1) {
    return fail(
      400,
      "invalid_audience",
      "Give exactly one of `audience.segment_id`, `audience.tag`, `audience.phones` or `audience.all`.",
    );
  }
  let audience: CampaignRequest["audience"];
  if (given[0] === "segment_id") {
    const id = typeof aud["segment_id"] === "string" ? aud["segment_id"].trim() : "";
    if (!validId(id))
      return fail(400, "invalid_audience", "`audience.segment_id` isn't a segment id.");
    audience = { kind: "segment", segmentId: id };
  } else if (given[0] === "tag") {
    const tag = typeof aud["tag"] === "string" ? aud["tag"].trim() : "";
    if (!tag || tag.length > MAX_TAG_CHARS)
      return fail(
        400,
        "invalid_audience",
        `\`audience.tag\` must be a tag name of 1–${MAX_TAG_CHARS} characters.`,
      );
    audience = { kind: "tag", tag };
  } else if (given[0] === "all") {
    if (aud["all"] !== true) return fail(400, "invalid_audience", "`audience.all` must be true.");
    audience = { kind: "all" };
  } else {
    const list = aud["phones"];
    if (!Array.isArray(list) || !list.length)
      return fail(400, "invalid_audience", "`audience.phones` must be a non-empty array.");
    if (list.length > MAX_AUDIENCE_PHONES) {
      return fail(
        400,
        "invalid_audience",
        `\`audience.phones\` holds at most ${MAX_AUDIENCE_PHONES} numbers; use a segment or a tag for more.`,
      );
    }
    const phones: PhoneEntry[] = [];
    for (const [i, entry] of list.entries()) {
      if (typeof entry === "string" || typeof entry === "number") {
        phones.push({ phone: String(entry), values: null });
        continue;
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return fail(
          400,
          "invalid_audience",
          `audience.phones[${i}] must be a number or { phone, variables }.`,
        );
      const e = entry as Record<string, unknown>;
      const phone =
        typeof e["phone"] === "string" || typeof e["phone"] === "number" ? String(e["phone"]) : "";
      if (!phone) return fail(400, "invalid_audience", `audience.phones[${i}].phone is required.`);
      let values: PhoneEntry["values"] = null;
      if (e["variables"] !== undefined && e["variables"] !== null) {
        const parsed = parseRecipientValues(e["variables"], `audience.phones[${i}].variables`);
        if (typeof parsed === "string") return fail(400, "invalid_variables", parsed);
        values = parsed;
      }
      phones.push({ phone, values });
    }
    audience = { kind: "phones", phones };
  }

  // ---- campaign-wide values ----
  const variables: Record<string, VariableMapping> = {};
  const rawVars = body["variables"];
  if (rawVars !== undefined && rawVars !== null) {
    if (Array.isArray(rawVars)) {
      for (const [i, v] of rawVars.entries()) {
        const m = parseMapping(v, `variables[${i}]`);
        if (typeof m === "string") return fail(400, "invalid_variables", m);
        variables[String(i + 1)] = m;
      }
    } else if (typeof rawVars === "object") {
      for (const [k, v] of Object.entries(rawVars as Record<string, unknown>)) {
        if (!/^\d{1,2}$/.test(k))
          return fail(
            400,
            "invalid_variables",
            '`variables` keys are the template\'s value numbers ("1", "2"…).',
          );
        const m = parseMapping(v, `variables["${k}"]`);
        if (typeof m === "string") return fail(400, "invalid_variables", m);
        variables[String(Number(k))] = m;
      }
    } else {
      return fail(
        400,
        "invalid_variables",
        "`variables` must be an array or an object keyed by value number.",
      );
    }
  }

  // ---- what the app's launch also takes: a header file link, a coupon, an offer end ----
  for (const [field, check] of [
    ["header_media_url", (v: unknown) => typeof v === "string" && /^https:\/\//i.test(v.trim())],
    [
      "coupon_code",
      (v: unknown) => typeof v === "string" && v.trim().length >= 1 && v.trim().length <= 15,
    ],
    ["offer_expires_at", (v: unknown) => typeof v === "string" && !Number.isNaN(Date.parse(v))],
  ] as const) {
    if (body[field] !== undefined && body[field] !== null && !check(body[field])) {
      const what =
        field === "header_media_url"
          ? "an https:// link"
          : field === "coupon_code"
            ? "a code of 1–15 characters"
            : "an ISO date and time";
      return fail(400, `invalid_${field}`, `\`${field}\` must be ${what}.`);
    }
  }

  let scheduleAt: Date | null = null;
  const rawSchedule = body["schedule_at"];
  if (rawSchedule !== undefined && rawSchedule !== null && rawSchedule !== "") {
    if (typeof rawSchedule !== "string" || Number.isNaN(Date.parse(rawSchedule)))
      return fail(
        400,
        "invalid_schedule_at",
        "`schedule_at` must be an ISO date and time, e.g. 2026-11-01T10:00:00+05:30.",
      );
    scheduleAt = new Date(rawSchedule);
    if (scheduleAt.getTime() > Date.now() + 90 * 24 * 60 * 60_000)
      return fail(400, "invalid_schedule_at", "`schedule_at` can be at most 90 days ahead.");
  }

  const keyRaw = body["idempotency_key"] ?? options.idempotencyHeader ?? null;
  let idempotencyKey: string | null = null;
  if (!options.forEstimate && keyRaw !== undefined && keyRaw !== null && keyRaw !== "") {
    if (typeof keyRaw !== "string" || !/^[A-Za-z0-9_\-.:]{1,255}$/.test(keyRaw))
      return fail(
        400,
        "invalid_idempotency_key",
        "`idempotency_key` must be 1–255 letters, digits or _ - . :",
      );
    idempotencyKey = keyRaw;
  }

  return {
    name,
    templateName,
    language,
    audience,
    variables,
    sendSettings: {
      header_media_url: body["header_media_url"],
      coupon_code: body["coupon_code"],
      offer_expires_at: body["offer_expires_at"],
    },
    scheduleAt,
    idempotencyKey,
  };
}

// ------------------------------------------------------------ the template

type TemplateRow = { name: string; language: string; category: string | null; components: unknown };

/**
 * The approved template on the workspace's sending number, checked for what
 * a campaign can fill: numbered values, a header file (given, or the one
 * saved with the template), a coupon. Link buttons and carousels need a
 * per-message destination a campaign doesn't have: refused here, before
 * anything is created.
 */
async function resolveCampaignTemplate(
  supabase: SupabaseClient,
  organizationId: string,
  req: CampaignRequest,
): Promise<
  | { ok: true; template: TemplateRow; accountId: string; variableOrder: number[] }
  | { ok: false; answer: ApiReply }
> {
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection, error: connectionError } = await getWhatsAppConnection(
    supabase,
    organizationId,
    null,
  );
  if (!connection)
    return {
      ok: false,
      answer: fail(
        400,
        "no_whatsapp_number",
        connectionError ?? "Connect a WhatsApp number in AiDwar first.",
      ),
    };
  const { data, error } = await supabase
    .from("message_templates")
    .select("name, language, category, status, components")
    .eq("organization_id", organizationId)
    .eq("waba_id", connection.wabaId)
    .eq("name", req.templateName)
    .limit(20);
  if (error)
    return {
      ok: false,
      answer: fail(503, "unavailable", "We couldn't read your templates. Please try again."),
    };
  const rows = (data ?? []) as Array<TemplateRow & { status: string }>;
  const named = rows.filter((r) => !req.language || r.language === req.language);
  if (!named.length)
    return {
      ok: false,
      answer: fail(
        400,
        "template_not_found",
        `There is no template named "${req.templateName}"${req.language ? ` in "${req.language}"` : ""} on this workspace's WhatsApp number.`,
      ),
    };
  const approved = named.filter((r) => r.status === "APPROVED");
  if (!approved.length)
    return {
      ok: false,
      answer: fail(
        400,
        "template_not_approved",
        `Template "${req.templateName}" isn't approved by Meta yet (status ${named[0]!.status}).`,
      ),
    };
  if (approved.length > 1)
    return {
      ok: false,
      answer: fail(
        400,
        "language_required",
        `Template "${req.templateName}" is approved in ${approved.map((r) => r.language).join(", ")} — say which with \`language\`.`,
      ),
    };
  const template = approved[0]!;
  const { templateVariableSpec, templateBodyText, extractVariables } =
    await import("@/lib/templates");
  const components = (template.components ?? []) as import("@/lib/templates").TemplateComponent[];
  const spec = templateVariableSpec(components);
  if (spec.urlButtons.length || spec.cards.length || spec.headerMedia?.format === "LOCATION") {
    return {
      ok: false,
      answer: fail(
        400,
        "template_unsupported",
        `Template "${req.templateName}" has a link button, cards or a map pin, which a campaign from the API can't fill yet. Launch it from AiDwar, or use another template.`,
      ),
    };
  }
  if (/\{\{\s*[A-Za-z_][\w]*\s*\}\}/.test(templateBodyText(components)))
    return {
      ok: false,
      answer: fail(
        400,
        "template_unsupported",
        `Template "${req.templateName}" uses named values; the API fills numbered ones ({{1}}, {{2}}…).`,
      ),
    };
  if (spec.headerMedia && !spec.headerMedia.url && !req.sendSettings["header_media_url"])
    return {
      ok: false,
      answer: fail(
        400,
        "header_media_required",
        `Template "${req.templateName}" has a ${spec.headerMedia.format.toLowerCase()} header: give its https link as \`header_media_url\`.`,
      ),
    };
  if (spec.copyCodeButtons.length && !req.sendSettings["coupon_code"])
    return {
      ok: false,
      answer: fail(
        400,
        "coupon_code_required",
        `Template "${req.templateName}" has a copy-code button: give the code as \`coupon_code\`.`,
      ),
    };
  const variableOrder = Array.from(
    new Set([...extractVariables(templateBodyText(components)), ...spec.header]),
  ).sort((x, y) => x - y);
  return { ok: true, template, accountId: connection.accountId, variableOrder };
}

// ------------------------------------------------------------ the audience

export type Skipped = {
  phone: string;
  reason: "invalid_phone" | "duplicate" | "not_a_contact" | "not_opted_in" | "opted_out";
};

const CONTACT_COLUMNS = "id, name, phone, attributes, opt_in_status";

async function contactsByIds(
  supabase: SupabaseClient,
  organizationId: string,
  ids: string[],
): Promise<AudienceContact[]> {
  const out: AudienceContact[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("contacts")
      .select(CONTACT_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("opt_in_status", "opted_in")
      .in("id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as AudienceContact[]));
  }
  return out;
}

export type ResolvedAudience = {
  contacts: AudienceContact[];
  skipped: Skipped[];
  values: Map<string, string[] | Record<string, string>>;
  segmentId: string | null;
};

/** The opted-in contacts the request names, in this workspace only. */
export async function resolveApiAudience(
  supabase: SupabaseClient,
  organizationId: string,
  audience: CampaignRequest["audience"],
): Promise<ResolvedAudience | ApiReply> {
  const empty = {
    skipped: [] as Skipped[],
    values: new Map<string, string[] | Record<string, string>>(),
  };
  if (audience.kind === "segment" || audience.kind === "all") {
    const { resolveAudienceContacts, isSegmentNotFound } = await import("@/lib/campaigns.server");
    const segmentId = audience.kind === "segment" ? audience.segmentId : null;
    try {
      return {
        ...empty,
        contacts: await resolveAudienceContacts(supabase, organizationId, segmentId),
        segmentId,
      };
    } catch (error) {
      if (isSegmentNotFound(error))
        return fail(
          404,
          "segment_not_found",
          "There is no segment with this id in this workspace.",
        );
      return fail(503, "unavailable", "We couldn't work out this audience. Please try again.");
    }
  }

  if (audience.kind === "tag") {
    const { data: tags, error } = await supabase
      .from("tags")
      .select("id, name")
      .eq("organization_id", organizationId)
      .ilike(
        "name",
        audience.tag.replace(/[\\%_]/g, (c) => `\\${c}`),
      )
      .limit(5);
    if (error) return fail(503, "unavailable", "We couldn't read your tags. Please try again.");
    const tag = ((tags ?? []) as Array<{ id: string; name: string }>).find(
      (t) => t.name.toLowerCase() === audience.tag.toLowerCase(),
    );
    if (!tag)
      return fail(404, "tag_not_found", `There is no tag "${audience.tag}" in this workspace.`);
    const ids: string[] = [];
    for (let from = 0; from < 50_000; from += 1000) {
      const { data, error: linkError } = await supabase
        .from("contact_tags")
        .select("contact_id")
        .eq("organization_id", organizationId)
        .eq("tag_id", tag.id)
        .order("contact_id")
        .range(from, from + 999);
      if (linkError)
        return fail(503, "unavailable", "We couldn't read this tag's contacts. Please try again.");
      const rows = (data ?? []) as Array<{ contact_id: string }>;
      ids.push(...rows.map((r) => r.contact_id));
      if (rows.length < 1000) break;
    }
    try {
      return {
        ...empty,
        contacts: await contactsByIds(supabase, organizationId, Array.from(new Set(ids))),
        segmentId: null,
      };
    } catch {
      return fail(503, "unavailable", "We couldn't read this tag's contacts. Please try again.");
    }
  }

  // ---- a list of phones ----
  const { normalizePhone, toWaId } = await import("@/lib/phone");
  const skipped: Skipped[] = [];
  const wanted = new Map<string, PhoneEntry>();
  for (const entry of audience.phones) {
    const phone = normalizePhone(entry.phone);
    const digits = toWaId(phone);
    if (digits.length < 8 || digits.length > 15) {
      skipped.push({ phone: String(entry.phone), reason: "invalid_phone" });
      continue;
    }
    if (wanted.has(phone)) {
      skipped.push({ phone, reason: "duplicate" });
      continue;
    }
    wanted.set(phone, entry);
  }
  const phones = Array.from(wanted.keys());
  const found = new Map<string, AudienceContact & { opt_in_status?: string | null }>();
  for (let i = 0; i < phones.length; i += 200) {
    const { data, error } = await supabase
      .from("contacts")
      .select(CONTACT_COLUMNS)
      .eq("organization_id", organizationId)
      .in("phone", phones.slice(i, i + 200));
    if (error) return fail(503, "unavailable", "We couldn't read your contacts. Please try again.");
    for (const c of (data ?? []) as Array<AudienceContact & { opt_in_status?: string | null }>)
      found.set(c.phone, c);
  }
  const contacts: AudienceContact[] = [];
  const values = new Map<string, string[] | Record<string, string>>();
  for (const phone of phones) {
    const c = found.get(phone);
    if (!c) {
      skipped.push({ phone, reason: "not_a_contact" });
      continue;
    }
    if (c.opt_in_status !== "opted_in") {
      skipped.push({
        phone,
        reason: c.opt_in_status === "opted_out" ? "opted_out" : "not_opted_in",
      });
      continue;
    }
    contacts.push({ id: c.id, name: c.name, phone: c.phone, attributes: c.attributes });
    const v = wanted.get(phone)!.values;
    if (v) values.set(c.id, v);
  }
  return { contacts, skipped, values, segmentId: null };
}

/**
 * Every template value for every recipient: from the recipient's own
 * values, else the campaign-wide one. A value nobody gives is refused
 * (the app would fill it with "there").
 */
export function recipientValueMap(
  variableOrder: number[],
  mappings: Record<string, VariableMapping>,
  audience: ResolvedAudience,
): Map<string, Record<string, string>> | ApiReply {
  const out = new Map<string, Record<string, string>>();
  const missing = new Set<number>();
  for (const c of audience.contacts) {
    const given = audience.values.get(c.id);
    const own: Record<string, string> = {};
    if (Array.isArray(given)) {
      if (given.length > variableOrder.length)
        return fail(
          400,
          "invalid_variables",
          `${c.phone}: the template takes ${variableOrder.length} value(s); ${given.length} were given.`,
        );
      given.forEach((v, i) => (own[String(variableOrder[i])] = v));
    } else if (given) {
      for (const k of Object.keys(given)) {
        if (!variableOrder.includes(Number(k)))
          return fail(400, "invalid_variables", `${c.phone}: the template has no value {{${k}}}.`);
      }
      Object.assign(own, given);
    }
    for (const n of variableOrder) if (!own[String(n)] && !mappings[String(n)]) missing.add(n);
    // Every value (a header's too), the campaign-wide ones resolved for this contact.
    out.set(c.id, { ...resolveAllVariables(variableOrder, mappings, c), ...own });
  }
  for (const k of Object.keys(mappings)) {
    if (!variableOrder.includes(Number(k)))
      return fail(400, "invalid_variables", `The template has no value {{${k}}}.`);
  }
  if (missing.size) {
    const list = Array.from(missing)
      .sort((a, b) => a - b)
      .map((n) => `{{${n}}}`)
      .join(", ");
    return fail(
      400,
      "missing_variables",
      `Nothing fills ${list} for every recipient: give it in \`variables\` (for everyone) or in each phone's own \`variables\`.`,
    );
  }
  return out;
}

// ------------------------------------------------------------ estimate

/** POST /api/v1/campaigns/estimate: who it would reach and what it would cost. Nothing is created. */
export async function estimateCampaignViaApi(
  supabase: SupabaseClient,
  caller: ApiCaller,
  raw: unknown,
): Promise<ApiReply> {
  const req = parseCampaignRequest(raw, { forEstimate: true });
  if ("status" in req) return req;
  const orgId = caller.organizationId;
  const resolved = await resolveCampaignTemplate(supabase, orgId, req);
  if (!resolved.ok) return resolved.answer;
  const audience = await resolveApiAudience(supabase, orgId, req.audience);
  if ("status" in audience) return audience;
  const values = recipientValueMap(resolved.variableOrder, req.variables, audience);
  if ("status" in values) return values;

  const { campaignCostEstimate } = await import("@/lib/billing.server");
  const { campaignCategory } = await import("@/lib/campaign-launch.server");
  const estimate = await campaignCostEstimate(supabase, {
    organizationId: orgId,
    recipients: audience.contacts.length,
    category: campaignCategory(resolved.template.category),
    whatsappAccountId: resolved.accountId,
  });
  return {
    status: 200,
    body: {
      recipients: audience.contacts.length,
      skipped: audience.skipped,
      template_name: resolved.template.name,
      language: resolved.template.language,
      category: estimate.category,
      cost: estimate.enabled
        ? {
            currency: estimate.currency,
            rate: estimate.rate,
            estimate: estimate.estimate,
            available: estimate.available,
            can_send: estimate.can_send,
            needs_approval: estimate.needs_approval,
          }
        : null,
    },
  };
}

// ------------------------------------------------------------ create

/** POST /api/v1/campaigns. */
export async function createCampaignViaApi(
  supabase: SupabaseClient,
  caller: ApiCaller,
  raw: unknown,
  options: { idempotencyHeader?: string | null } = {},
): Promise<ApiReply> {
  const req = parseCampaignRequest(raw, {
    forEstimate: false,
    idempotencyHeader: options.idempotencyHeader ?? null,
  });
  if ("status" in req) return req;
  const orgId = caller.organizationId;
  const lib = await import("@/lib/public-api.server");

  // ---- the idempotency key first: a repeat gets the first answer, never a second campaign ----
  let requestId: string | null = null;
  if (req.idempotencyKey) {
    const fingerprint = lib.requestFingerprint({
      kind: "campaign",
      body: createHash("sha256").update(JSON.stringify(raw)).digest("hex"),
    });
    const claim = await lib.claimIdempotency(supabase, {
      organizationId: orgId,
      apiKeyId: caller.keyId,
      key: req.idempotencyKey,
      requestHash: fingerprint,
    });
    if (claim.kind === "replay")
      return { status: claim.status, body: claim.body, headers: { "Idempotent-Replayed": "true" } };
    if (claim.kind === "in_progress")
      return {
        ...fail(
          409,
          "idempotency_in_progress",
          "A request with this idempotency_key is still being worked on. Ask again in a few seconds.",
        ),
        headers: { "Retry-After": "5" },
      };
    if (claim.kind === "mismatch")
      return fail(
        409,
        "idempotency_key_reused",
        "This idempotency_key was already used for a different request in the last 24 hours.",
      );
    if (claim.kind === "error")
      return fail(503, "unavailable", "We couldn't reserve the idempotency_key. Please try again.");
    requestId = claim.id;
  }
  const refuse = async (answer: ApiReply): Promise<ApiReply> => {
    if (requestId) await lib.releaseIdempotency(supabase, requestId);
    return answer;
  };

  let launchStarted = false;
  try {
    const { workspaceLocked, launchCampaign } = await import("@/lib/campaign-launch.server");
    if (await workspaceLocked(supabase, orgId))
      return refuse(
        fail(
          402,
          "workspace_locked",
          "This workspace is locked — choose a plan in AiDwar to send again.",
        ),
      );
    const resolved = await resolveCampaignTemplate(supabase, orgId, req);
    if (!resolved.ok) return refuse(resolved.answer);
    const audience = await resolveApiAudience(supabase, orgId, req.audience);
    if ("status" in audience) return refuse(audience);
    const values = recipientValueMap(resolved.variableOrder, req.variables, audience);
    if ("status" in values) return refuse(values);

    const { sanitizeSendSettings } = await import("@/lib/campaigns");
    launchStarted = true;
    const result = await launchCampaign(supabase, {
      organizationId: orgId,
      userId: null,
      name: req.name,
      templateName: resolved.template.name,
      templateLanguage: resolved.template.language,
      whatsappAccountId: resolved.accountId,
      segmentId: audience.segmentId,
      contacts: audience.contacts,
      mappings: req.variables as VariableMappings,
      recipientValues: values,
      sendSettings: sanitizeSendSettings(req.sendSettings),
      scheduledAt: req.scheduleAt,
      activityDetails: { source: "api", api_key_id: caller.keyId },
      eventProperties: { source: "api" },
    });
    if (!result.ok) {
      // Nothing is sent: a campaign whose list failed is marked failed, so the key may be used again.
      return refuse(fail(result.status === 500 ? 503 : result.status, result.code, result.error));
    }
    const { data: row } = await supabase
      .from("campaigns")
      .select(CAMPAIGN_COLUMNS)
      .eq("id", result.campaignId)
      .eq("organization_id", orgId)
      .maybeSingle();
    const answer: ApiReply = {
      status: 201,
      body: {
        campaign: row
          ? publicCampaign(row as CampaignRow)
          : { campaign_id: result.campaignId, status: result.status },
        needs_approval: result.needsApproval,
        skipped: audience.skipped,
        idempotency_key: req.idempotencyKey,
      },
    };
    if (requestId)
      await lib.finishIdempotency(supabase, requestId, {
        status: answer.status,
        body: answer.body,
        messageId: null,
      });
    return answer;
  } catch (error) {
    if (requestId && !launchStarted) await lib.releaseIdempotency(supabase, requestId);
    throw error;
  }
}

// ------------------------------------------------------------ read, list, cancel

const notFound = () =>
  fail(404, "not_found", "There is no campaign with this id in this workspace.");

async function readCampaign(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<CampaignRow | null> {
  if (!validId(campaignId)) return null;
  const { data, error } = await supabase
    .from("campaigns")
    .select(CAMPAIGN_COLUMNS)
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  // A malformed id is a database error too: answered as not found.
  if (error || !data) return null;
  return data as CampaignRow;
}

export async function getCampaignViaApi(
  supabase: SupabaseClient,
  caller: ApiCaller,
  campaignId: string,
): Promise<ApiReply> {
  const row = await readCampaign(supabase, caller.organizationId, campaignId);
  return row ? { status: 200, body: { campaign: publicCampaign(row) } } : notFound();
}

const STATUSES = [
  "draft",
  "scheduled",
  "awaiting_approval",
  "sending",
  "paused",
  "completed",
  "cancelled",
  "failed",
];

/** GET /api/v1/campaigns?status=&limit=&cursor= — newest first. */
export async function listCampaignsViaApi(
  supabase: SupabaseClient,
  caller: ApiCaller,
  params: URLSearchParams,
): Promise<ApiReply> {
  const status = params.get("status");
  if (status && !STATUSES.includes(status))
    return fail(400, "invalid_status", `\`status\` must be one of ${STATUSES.join(", ")}.`);
  const limitRaw = params.get("limit");
  const limit = limitRaw ? Number(limitRaw) : DEFAULT_LIST;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST)
    return fail(400, "invalid_limit", `\`limit\` must be 1–${MAX_LIST}.`);
  const cursor = decodeCursor(params.get("cursor"));
  if (cursor === "invalid") return fail(400, "invalid_cursor", "`cursor` isn't one this API gave.");

  let query = supabase
    .from("campaigns")
    .select(CAMPAIGN_COLUMNS)
    .eq("organization_id", caller.organizationId);
  if (status) query = query.eq("status", status);
  if (cursor)
    query = query.or(
      `created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`,
    );
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) return fail(503, "unavailable", "We couldn't read your campaigns. Please try again.");
  const rows = (data ?? []) as CampaignRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    status: 200,
    body: {
      campaigns: page.map(publicCampaign),
      next_cursor:
        rows.length > limit && last
          ? encodeCursor(String(last["created_at"]), String(last["id"]))
          : null,
    },
  };
}

/** POST /api/v1/campaigns/{id}/cancel — only while it hasn't finished sending. */
export async function cancelCampaignViaApi(
  supabase: SupabaseClient,
  caller: ApiCaller,
  campaignId: string,
): Promise<ApiReply> {
  const orgId = caller.organizationId;
  const row = await readCampaign(supabase, orgId, campaignId);
  if (!row) return notFound();
  const finished = () =>
    fail(
      409,
      "campaign_finished",
      "This campaign has already finished sending, so it can't be cancelled.",
    );
  if (FINISHED_STATUSES.includes(String(row["status"]))) return finished();
  const { cancelCampaign } = await import("@/lib/campaign-launch.server");
  const cancelled = await cancelCampaign(supabase, orgId, String(row["id"]));
  if (!cancelled.ok)
    return cancelled.finished ? finished() : fail(503, "unavailable", cancelled.error);
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(supabase, orgId, null, "campaign_cancelled", {
    campaign_id: row["id"],
    source: "api",
    api_key_id: caller.keyId,
  });
  const after = await readCampaign(supabase, orgId, String(row["id"]));
  return {
    status: 200,
    body: { campaign: publicCampaign(after ?? { ...row, status: "cancelled" }) },
  };
}

// ------------------------------------------------------------ campaign.completed

/** The webhook body for a finished campaign. */
export function campaignCompletedPayload(
  row: CampaignRow,
  occurredAt: string,
): Record<string, unknown> {
  const c = publicCampaign(row);
  return {
    event: "campaign.completed",
    campaign_id: c["campaign_id"],
    name: c["name"],
    status: c["status"],
    template_name: c["template_name"],
    counts: c["counts"],
    completed_at: c["completed_at"],
    timestamp: occurredAt,
  };
}

/**
 * The campaign worker's hook (completeIfDone, after the run that flipped the
 * campaign to completed): campaign.completed on the merchant's webhook queue,
 * once per campaign (dedupe_key), through queueAccountEvent. Never throws.
 * Before 20261160 is applied the event CHECK refuses it and nothing is queued.
 */
export async function queueCampaignCompleted(
  supabase: SupabaseClient,
  input: { organizationId: string; campaignId: string },
): Promise<void> {
  const row = await readCampaign(supabase, input.organizationId, input.campaignId).catch(
    () => null,
  );
  if (!row) return;
  const occurredAt = String(row["completed_at"] ?? new Date().toISOString());
  const { queueAccountEvent } = await import("@/lib/public-api-webhooks.server");
  await queueAccountEvent(supabase, {
    organizationId: input.organizationId,
    event: "campaign.completed",
    payload: campaignCompletedPayload(row, occurredAt),
    occurredAt,
    dedupeKey: `campaign.completed:${input.campaignId}`,
  });
}
