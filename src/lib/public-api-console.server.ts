import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { ApiCaller } from "@/lib/public-api.server";
import { RATE_PER_KEY_PER_MIN } from "@/lib/public-api";
import { consoleFieldNames, type ConsoleEndpoint } from "@/lib/public-api-console";

/**
 * Batch 38 item 7: the "Try it" console's credential (Settings → API &
 * webhooks, owners and admins, public_api on).
 *
 * The console fires REAL calls through the same /api/v1 handlers — not a
 * copy of them — with a credential the server mints for one workspace and
 * the member who opened the console. It is never an API key and never leaves
 * the server: the browser asks /api/developer/console, which puts the
 * credential on the request it hands the /api/v1 handler in-process, and
 * answers with the request (as curl, the credential masked) and the
 * handler's response. Stored as its sha256 only (api_console_credentials,
 * service role only, 20261160), it works for 10 minutes; the plaintext lives
 * in this server's memory for that time (so one console session is one
 * credential and one rate bucket) and nowhere else. authenticateApiKey
 * accepts it like a key — the public_api flag, the plan table, the
 * per-credential and per-workspace rate limits all apply — and its caller is
 * marked source "api_console", so its sends are charged like any API send
 * and labelled metadata.source "api_console". The member must still hold
 * public_api.manage when it is used.
 */

export const CONSOLE_PREFIX = "adw_console_";
export const CONSOLE_TTL_MS = 10 * 60_000;
/** A remembered credential is reused while it has at least this long left. */
const REUSE_MARGIN_MS = 60_000;
export const CONSOLE_SHAPE = /^adw_console_[A-Za-z0-9_-]{43}$/;

export type ConsoleCaller = ApiCaller & { source: "api_console"; userId: string };

function hash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** What the console shows of a credential: never more than this. */
export const MASKED_CREDENTIAL = `${CONSOLE_PREFIX}••••••••`;

const remembered = new Map<string, { token: string; expiresAt: number }>();

/** Test hook. */
export function forgetConsoleCredentials(): void {
  remembered.clear();
}

/**
 * A credential for this member in this workspace: the one still remembered
 * here, else a new one (10 minutes). Throws when it can't be stored (the
 * table is missing before 20261160): the console says it isn't available.
 */
export async function consoleCredential(
  supabase: SupabaseClient,
  input: { organizationId: string; userId: string; now?: number },
): Promise<{ token: string; expiresAt: number }> {
  const now = input.now ?? Date.now();
  const slot = `${input.organizationId}:${input.userId}`;
  const hit = remembered.get(slot);
  if (hit && hit.expiresAt - now > REUSE_MARGIN_MS) return hit;
  const token = `${CONSOLE_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = now + CONSOLE_TTL_MS;
  const { error } = await supabase.from("api_console_credentials").insert({
    organization_id: input.organizationId,
    created_by: input.userId,
    token_hash: hash(token),
    created_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  });
  if (error) throw new Error(`console credential: ${error.message}`);
  const minted = { token, expiresAt };
  remembered.set(slot, minted);
  return minted;
}

/**
 * authenticateApiKey's path for a console credential: known, unexpired, its
 * member still allowed to manage the API, public_api on, the endpoint in
 * the plan. The caller, or the 401 / 403 / 503 to send back.
 */
export async function authenticateConsoleCredential(
  supabase: SupabaseClient,
  token: string,
  request: Request,
): Promise<ConsoleCaller | Response> {
  const { apiError, publicApiEnabled } = await import("@/lib/public-api.server");
  const unauthorized = () =>
    apiError(401, "unauthorized", "This console session has ended. Open the console again.");
  if (!CONSOLE_SHAPE.test(token)) return unauthorized();
  const digest = hash(token);
  const { data, error } = await supabase
    .from("api_console_credentials")
    .select("id, organization_id, created_by, token_hash, expires_at")
    .eq("token_hash", digest)
    .maybeSingle();
  if (error)
    return apiError(503, "unavailable", "We couldn't check the console session. Please try again.");
  const row = data as {
    id: string;
    organization_id: string;
    created_by: string;
    token_hash: string;
    expires_at: string;
  } | null;
  if (!row || !sameHash(String(row.token_hash ?? ""), digest)) return unauthorized();
  if (!(Date.parse(row.expires_at) > Date.now())) return unauthorized();

  const { hasPermission } = await import("@/lib/permissions.server");
  if (!(await hasPermission(supabase, row.organization_id, row.created_by, "public_api.manage")))
    return unauthorized();
  if (!(await publicApiEnabled(supabase, row.organization_id))) {
    return apiError(
      403,
      "public_api_disabled",
      "The Public API isn't switched on for this workspace. It is part of the Scale plan — contact AiDwar support to turn it on.",
    );
  }
  const { endpointPlanGate } = await import("@/lib/public-api-plans.server");
  const notInPlan = await endpointPlanGate(supabase, row.organization_id, request);
  if (notInPlan) return notInPlan;

  await supabase
    .from("api_console_credentials")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id);
  return {
    keyId: row.id,
    organizationId: row.organization_id,
    source: "api_console",
    userId: row.created_by,
  };
}

/**
 * The member's own console bucket (the per-key limit, whatever credential
 * they hold), counted like a key's; null when allowed, else the 429 / 503.
 */
export async function takeConsoleRate(
  supabase: SupabaseClient,
  input: { organizationId: string; userId: string },
): Promise<{ status: number; body: Record<string, unknown>; retryAfter?: number } | null> {
  const { data, error } = await supabase.rpc("api_rate_take", {
    p_bucket: `console:${input.organizationId}:${input.userId}`,
    p_limit: RATE_PER_KEY_PER_MIN,
    p_window_seconds: 60,
  });
  const row = (Array.isArray(data) ? data[0] : data) as {
    allowed?: boolean;
    retry_after?: number;
  } | null;
  if (error || !row || typeof row.allowed !== "boolean")
    return {
      status: 503,
      body: {
        error: "We couldn't check the rate limit. Please try again in a moment.",
        code: "unavailable",
      },
    };
  if (row.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil(Number(row.retry_after ?? 60)));
  return {
    status: 429,
    retryAfter,
    body: {
      error: `Too many requests: the limit is ${RATE_PER_KEY_PER_MIN} requests a minute, as for an API key. Try again in ${retryAfter} s.`,
      code: "rate_limited",
    },
  };
}

/** The billing sweep's upkeep: credentials expired more than a day ago are removed (at most 500 a run). Never throws. */
export async function cleanupConsoleCredentials(
  supabase: SupabaseClient,
  now = Date.now(),
): Promise<number> {
  try {
    const { data, error } = await supabase
      .from("api_console_credentials")
      .select("id")
      .lt("expires_at", new Date(now - 24 * 60 * 60_000).toISOString())
      .order("expires_at", { ascending: true })
      .limit(500);
    if (error) return 0;
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (!ids.length) return 0;
    const { error: deleteError } = await supabase
      .from("api_console_credentials")
      .delete()
      .in("id", ids);
    return deleteError ? 0 : ids.length;
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------ the call

/** What the console may call: Part A of Batch 38 — the template send and the status read. */
export { CONSOLE_ENDPOINTS, type ConsoleEndpoint } from "@/lib/public-api-console";

/** A JSON body as the curl shows it: base64 files shortened, never pasted whole into the page. */
export function displayBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(displayBody);
  if (body && typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] =
        k === "base64" && typeof v === "string"
          ? `<${Math.round((v.length * 3) / 4 / 1024)} KB of base64>`
          : displayBody(v);
    }
    return out;
  }
  return body;
}

/** The request as curl, with the credential masked. */
export function consoleCurl(input: {
  origin: string;
  method: string;
  path: string;
  body: unknown;
}): string {
  const lines = [
    // A query string is quoted, so the shell keeps its "&".
    `curl -X ${input.method} ${input.path.includes("?") ? `"${input.origin}${input.path}"` : `${input.origin}${input.path}`} \\`,
    `  -H "Authorization: Bearer ${MASKED_CREDENTIAL}"${input.body !== undefined ? " \\" : ""}`,
  ];
  if (input.body !== undefined) {
    const json = JSON.stringify(displayBody(input.body), null, 2).replace(/'/g, "'\\''");
    lines.push(`  -H "Content-Type: application/json" \\`, `  -d '${json}'`);
  }
  return lines.join("\n");
}

/**
 * The console's body for a call: only what the endpoint takes (its spec
 * fields), and never an idempotency key (a console send is one click, and an
 * idempotency record belongs to a real API key).
 */
export function consoleBody(endpoint: ConsoleEndpoint, raw: unknown): Record<string, unknown> {
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const k of consoleFieldNames(endpoint, "body")) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

/** The template send's body (consoleBody for send_template). */
export function consoleSendBody(raw: unknown): Record<string, unknown> {
  return consoleBody("send_template", raw);
}

/** A list's filters as a query string ("" or "?a=b"): only the endpoint's own, only non-empty text. */
export function consoleQuery(endpoint: ConsoleEndpoint, raw: unknown): string {
  const q =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const params = new URLSearchParams();
  for (const k of consoleFieldNames(endpoint, "query")) {
    const v = q[k];
    if ((typeof v === "string" && v.trim()) || typeof v === "number")
      params.set(k, String(v).trim());
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Calls a route's own handler, as the router does. */
export async function invokeRoute(
  route: unknown,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  input: { request: Request; params: Record<string, string> },
): Promise<Response> {
  const handlers = (
    route as {
      options: { server: { handlers: Record<string, (a: typeof input) => Promise<Response>> } };
    }
  ).options.server.handlers;
  return handlers[method]!(input);
}

export type ConsoleQuote = {
  ok: boolean;
  error?: string;
  /** Billing off for this workspace: the send isn't charged. */
  billed?: boolean;
  category?: string;
  rate?: number;
  currency?: string;
  available?: number;
  covers?: boolean;
};

/**
 * What one template send to `to` would cost: the template's category at
 * this customer's country rate — the same numbers the send's own credit
 * check uses (countryForPhone, rateFor, creditsCover). Nothing is sent.
 */
export async function consoleQuote(
  supabase: SupabaseClient,
  input: { organizationId: string; templateName: string; language: string | null; to: string },
): Promise<ConsoleQuote> {
  const { normalizePhone, toWaId } = await import("@/lib/phone");
  const waId = toWaId(normalizePhone(input.to));
  if (waId.length < 8 || waId.length > 15)
    return { ok: false, error: "Enter the test number with its country code, e.g. +919812345678." };
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection } = await getWhatsAppConnection(supabase, input.organizationId, null);
  if (!connection) return { ok: false, error: "Connect a WhatsApp number first." };
  let query = supabase
    .from("message_templates")
    .select("category, language")
    .eq("organization_id", input.organizationId)
    .eq("waba_id", connection.wabaId)
    .eq("name", input.templateName)
    .eq("status", "APPROVED");
  if (input.language) query = query.eq("language", input.language);
  const { data } = await query.limit(1).maybeSingle();
  if (!data)
    return { ok: false, error: "That template isn't approved on this workspace's number." };
  const category = String(
    (data as { category?: string | null }).category ?? "utility",
  ).toLowerCase();
  const billing = await import("@/lib/billing.server");
  if (!(await billing.billingEnabled(supabase, input.organizationId)))
    return { ok: true, billed: false, category };
  const { countryForPhone } = await import("@/lib/public-api-send.server");
  const country = await countryForPhone(supabase, waId);
  const { rate, currency } = await billing.rateFor(
    supabase,
    input.organizationId,
    category as import("@/lib/billing").MessageCategory,
    country,
  );
  const cover = await billing.creditsCover(supabase, input.organizationId, rate);
  return {
    ok: true,
    billed: true,
    category,
    rate,
    currency,
    available: Number(cover.available ?? 0),
    covers: cover.covers,
  };
}
