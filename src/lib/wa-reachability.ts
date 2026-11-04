/**
 * Batch 63 (B): "Not on WhatsApp" — a customer number WhatsApp says can't
 * receive messages. Client-safe (badges, the Sent report, the API).
 *
 * The mark lives on contacts.wa_unreachable (20261350_batch63.sql), null when
 * the number is fine:
 *   { since, last_at, code, reason, template, message_id, failures }
 * Written only by noteSendStatus (wa-reachability.server.ts) from Meta's
 * status webhook: a template message that failed with one of
 * UNREACHABLE_CODES sets it; any later delivered/read message to the contact
 * clears it. It never stops a send.
 */

/**
 * Meta's "this number can't receive" errors.
 *  - 131026 Message undeliverable: not on WhatsApp, an old WhatsApp version,
 *    or the customer hasn't accepted the latest terms (Cloud API).
 *  - 1013   User is not valid / not a WhatsApp user (the On-Premises API's
 *    code for the same thing; still seen on numbers moved from a BSP).
 * Not included: 131049 (marketing cap — the number is fine), 131047 (24-hour
 * window), 131030 (test-number allow list), 131021 (recipient is the sender),
 * 13xxxx template/parameter errors — the number can receive those messages.
 */
export const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["131026", "1013"]);

/** The 202 answer's warning while the customer's number is marked. */
export const UNREACHABLE_WARNING = "number_not_on_whatsapp_recently";

/** A mark older than this no longer warns (the number may have joined since). */
export const UNREACHABLE_WARN_DAYS = 30;

export type Unreachable = {
  since: string;
  last_at: string;
  code: string;
  reason: string;
  template: string | null;
  message_id: string | null;
  failures: number;
};

export type MetaError = {
  code: string | null;
  title: string | null;
  message: string | null;
  details: string | null;
};

/** messages.error_detail (the JSON Meta sent, or our own text) → its first error. */
export function parseErrorDetail(detail: unknown): MetaError {
  const empty: MetaError = { code: null, title: null, message: null, details: null };
  if (detail == null || detail === "") return empty;
  let value: unknown = detail;
  if (typeof detail === "string") {
    try {
      value = JSON.parse(detail);
    } catch {
      return { ...empty, message: detail.slice(0, 300) };
    }
  }
  const first = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | null;
  if (!first || typeof first !== "object")
    return { ...empty, message: String(detail).slice(0, 300) };
  const data = (first["error_data"] ?? {}) as Record<string, unknown>;
  return {
    code: first["code"] != null ? String(first["code"]) : null,
    title: first["title"] != null ? String(first["title"]) : null,
    message: first["message"] != null ? String(first["message"]) : null,
    details: data["details"] != null ? String(data["details"]) : null,
  };
}

export function isUnreachableCode(code: string | number | null | undefined): boolean {
  return code != null && UNREACHABLE_CODES.has(String(code));
}

const REASONS: Record<string, string> = {
  "131026": "Not on WhatsApp (or can't receive messages)",
  "1013": "Not on WhatsApp",
  "131049": "WhatsApp held back this marketing message for this customer",
  "131047": "More than 24 hours since the customer last wrote",
  "131050": "The customer stopped marketing messages",
  "131051": "Message type not supported",
  "131053": "WhatsApp couldn't take the file",
  "132000": "Template values don't match the template",
  "132001": "Template doesn't exist in this language",
  "132007": "Template text breaks WhatsApp's policy",
  "132012": "Template values are in the wrong format",
  "132015": "Template is paused",
  "132016": "Template is disabled",
  "130472": "Customer is part of a WhatsApp experiment",
  "131000": "WhatsApp had a problem sending it",
};

/** One short, plain sentence for a failure (the Sent report, the daily summary). */
export function failureReason(detail: unknown): string {
  const e = parseErrorDetail(detail);
  if (e.code && REASONS[e.code]) return `${REASONS[e.code]} (${e.code})`;
  const words = e.details || e.title || e.message;
  if (words) return e.code ? `${words} (${e.code})` : words;
  return "Not delivered";
}

/** The contact's mark, or null (also null for anything malformed). */
export function unreachableOf(raw: unknown): Unreachable | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r["since"] !== "string" || typeof r["code"] !== "string") return null;
  return {
    since: r["since"],
    last_at: typeof r["last_at"] === "string" ? r["last_at"] : r["since"],
    code: r["code"],
    reason:
      typeof r["reason"] === "string" ? r["reason"] : (REASONS[r["code"]] ?? "Not on WhatsApp"),
    template: typeof r["template"] === "string" ? r["template"] : null,
    message_id: typeof r["message_id"] === "string" ? r["message_id"] : null,
    failures: Number(r["failures"] ?? 1) || 1,
  };
}

/** Whether a mark is recent enough for the API's warning. */
export function warnsNow(mark: Unreachable | null, now = Date.now()): boolean {
  if (!mark) return false;
  const last = Date.parse(mark.last_at);
  return Number.isFinite(last) && now - last <= UNREACHABLE_WARN_DAYS * 864e5;
}

/** The next mark after one more failed send (keeps the first date). */
export function nextUnreachable(
  current: Unreachable | null,
  failure: {
    at: string;
    code: string;
    detail: unknown;
    template: string | null;
    messageId: string | null;
  },
): Unreachable {
  return {
    since: current?.since ?? failure.at,
    last_at: failure.at,
    code: failure.code,
    reason: failureReason(failure.detail),
    template: failure.template,
    message_id: failure.messageId,
    failures: (current?.failures ?? 0) + 1,
  };
}

/** "Not on WhatsApp since 3 Nov" for badges. */
export function unreachableLabel(mark: Unreachable, timeZone = "Asia/Kolkata"): string {
  const d = new Date(mark.since);
  const day = Number.isFinite(d.getTime())
    ? d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone })
    : "";
  return day ? `Not on WhatsApp since ${day}` : "Not on WhatsApp";
}
