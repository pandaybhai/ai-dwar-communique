/**
 * Batch 67: a Public API send that didn't go out ("Refused") — a request to
 * POST /api/v1/messages/template or /session answered 4xx/5xx before any
 * messages row existed. It is recorded once (public.api_refusals, 20261370)
 * so the shop sees it in Templates → Sent, Home's Needs attention and the
 * daily summary, not only the developer's software. Pure: no server code.
 *
 * Never stored: the API key or Authorization header, body_params values,
 * document bytes or links (a link in the reason becomes "[link]"), header or
 * button values. `to` is kept as received, at most 32 characters.
 */

export type RefusalEndpoint = "template" | "session";

/** One row of public.api_refusals, as written (the database adds id and created_at). */
export type RefusalRow = {
  organization_id: string;
  api_key_id: string | null;
  source: "api" | "api_console";
  endpoint: RefusalEndpoint;
  http_status: number;
  error_code: string;
  reason: string;
  template_name: string | null;
  to_received: string | null;
  idempotency_key: string | null;
  field: string | null;
  /** endpoint:idempotency_key:error_code — a retry with the same key is not recorded twice. */
  dedupe_key: string | null;
};

export const REFUSAL_REASON_MAX = 300;
export const REFUSAL_TO_MAX = 32;

const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

/** The error sentence with any link taken out (a document URL may carry a token). */
export function refusalReason(error: unknown): string {
  const s = typeof error === "string" ? error : "";
  return (
    s
      .replace(/\bhttps?:\/\/\S+/gi, "[link]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, REFUSAL_REASON_MAX) || "The request was refused."
  );
}

/**
 * What to record for one answered request, or null when there is nothing to
 * record: a 2xx/3xx; an answer replayed for an idempotency key; an answer
 * with a message_id (a messages row exists — e.g. 502 whatsapp_rejected, which
 * the Sent report already shows as Failed); or idempotency_in_progress (the
 * first request is still being sent).
 */
export function refusalRow(input: {
  organizationId: string;
  keyId: string | null;
  source?: "api_console" | undefined;
  endpoint: RefusalEndpoint;
  status: number;
  replayed: boolean;
  answer: unknown;
  request: unknown;
  idempotencyHeader: string | null;
}): RefusalRow | null {
  if (input.status < 400 || input.status > 599 || input.replayed) return null;
  const answer = (input.answer && typeof input.answer === "object" ? input.answer : {}) as Record<
    string,
    unknown
  >;
  if (answer["message_id"] !== undefined && answer["message_id"] !== null) return null;
  const code = text(answer["code"], 64) ?? "unknown";
  if (code === "idempotency_in_progress") return null;
  const body = (
    input.request && typeof input.request === "object" && !Array.isArray(input.request)
      ? input.request
      : {}
  ) as Record<string, unknown>;
  const key = text(body["idempotency_key"], 255) ?? text(input.idempotencyHeader, 255);
  return {
    organization_id: input.organizationId,
    api_key_id: input.keyId,
    source: input.source === "api_console" ? "api_console" : "api",
    endpoint: input.endpoint,
    http_status: input.status,
    error_code: code,
    reason: refusalReason(answer["error"]),
    template_name: input.endpoint === "template" ? text(body["template_name"], 200) : null,
    to_received: text(body["to"], REFUSAL_TO_MAX),
    idempotency_key: key,
    field: text(answer["field"], 32),
    dedupe_key: key ? `${input.endpoint}:${key}:${code}` : null,
  };
}

/** A refusal as the Sent report and the daily summary read it. */
export type RefusalRecord = {
  id: string;
  created_at: string;
  endpoint: RefusalEndpoint;
  http_status: number;
  error_code: string;
  reason: string;
  template_name: string | null;
  to_received: string | null;
  idempotency_key: string | null;
  field: string | null;
};

export const REFUSAL_COLUMNS =
  "id, created_at, endpoint, http_status, error_code, reason, template_name, to_received, idempotency_key, field";

/** "3 API sends were refused today" (Home's Needs attention). */
export function refusedHeadline(n: number): string {
  return `${n} API send${n === 1 ? " was" : "s were"} refused today`;
}

/** The start of the India day `now` falls in, as a UTC instant (Home's "today"). */
export function indiaDayStart(now: number): number {
  const offset = 5.5 * 3600_000;
  const ist = now + offset;
  return ist - (ist % 864e5) - offset;
}

/** How far back the Message templates page's "Refused (no template)" line counts (rows are kept 90 days). */
export const NO_TEMPLATE_DAYS = 30;

export function refusedNoTemplateText(n: number): string {
  return `Refused (no template): ${n} API send${n === 1 ? "" : "s"} in the last ${NO_TEMPLATE_DAYS} days`;
}
