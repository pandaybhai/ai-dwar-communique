import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import {
  API_KEY_PREFIX,
  IDEMPOTENCY_WINDOW_HOURS,
  RATE_PER_KEY_PER_MIN,
  RATE_PER_WORKSPACE_PER_MIN,
} from "@/lib/public-api";

/**
 * Batch 34: the Public API's keys and its caller check.
 *
 * A key is "adw_live_" + 32 random bytes (base64url). It is shown once, when
 * it is created, and never stored: api_keys keeps its sha256 (key_hash) and
 * the first 8 characters after the prefix (prefix, shown in the list so a
 * merchant can tell keys apart). A call is matched by its hash, compared
 * again in constant time, and every query after that is scoped to the key's
 * own workspace — never one the caller names. Keys, secrets and documents
 * are never logged.
 */

export { API_KEY_PREFIX, RATE_PER_KEY_PER_MIN, RATE_PER_WORKSPACE_PER_MIN };
const KEY_SHAPE = /^adw_live_[A-Za-z0-9_-]{43}$/;
/** Active keys one workspace may hold at once. */
export const MAX_ACTIVE_KEYS = 20;
/** last_used_at is written at most this often per key. */
const LAST_USED_EVERY_MS = 60_000;

export type ApiKeyRow = {
  id: string;
  organization_id: string;
  name: string;
  prefix: string;
  created_by: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/** Every column but the hash: what a list ever returns. */
export const API_KEY_COLUMNS =
  "id, organization_id, name, prefix, created_by, created_at, last_used_at, revoked_at";

/** Exactly the shown columns, whatever a read returned: the hash never leaves here. */
export function publicKeyRow(row: Record<string, unknown>): ApiKeyRow {
  return {
    id: String(row["id"]),
    organization_id: String(row["organization_id"]),
    name: String(row["name"] ?? ""),
    prefix: String(row["prefix"] ?? ""),
    created_by: (row["created_by"] as string | null) ?? null,
    created_at: String(row["created_at"] ?? ""),
    last_used_at: (row["last_used_at"] as string | null) ?? null,
    revoked_at: (row["revoked_at"] as string | null) ?? null,
  };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** A fresh key: the full key (to show once), what is shown later, and the hash stored. */
export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const secret = randomBytes(32).toString("base64url");
  const key = `${API_KEY_PREFIX}${secret}`;
  return { key, prefix: secret.slice(0, 8), hash: hashApiKey(key) };
}

/** Constant-time equality of two sha256 hex digests. */
export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

/** How a key is shown in the list: never more than its prefix. */
export function maskedKey(prefix: string): string {
  return `${API_KEY_PREFIX}${prefix}…`;
}

// ------------------------------------------------------------ management

export async function listApiKeys(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<ApiKeyRow[]> {
  const { data, error } = await supabase
    .from("api_keys")
    .select(API_KEY_COLUMNS)
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map(publicKeyRow);
}

export async function createApiKey(
  supabase: SupabaseClient,
  input: { organizationId: string; name: string; userId: string },
): Promise<
  { ok: true; key: string; row: ApiKeyRow } | { ok: false; error: string; status: number }
> {
  const name = input.name.trim().slice(0, 80);
  if (name.length < 2)
    return { ok: false, error: "Give the key a name (at least 2 characters).", status: 400 };

  const { count, error: countError } = await supabase
    .from("api_keys")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", input.organizationId)
    .is("revoked_at", null);
  if (countError)
    return { ok: false, error: "We couldn't create the key. Please try again.", status: 503 };
  if ((count ?? 0) >= MAX_ACTIVE_KEYS) {
    return {
      ok: false,
      error: `A workspace can hold ${MAX_ACTIVE_KEYS} active keys. Revoke one you no longer use first.`,
      status: 400,
    };
  }

  const fresh = generateApiKey();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      organization_id: input.organizationId,
      name,
      prefix: fresh.prefix,
      key_hash: fresh.hash,
      created_by: input.userId,
    })
    .select(API_KEY_COLUMNS)
    .single();
  if (error || !data)
    return { ok: false, error: "We couldn't create the key. Please try again.", status: 503 };
  return { ok: true, key: fresh.key, row: publicKeyRow(data as Record<string, unknown>) };
}

/** Revokes one of the workspace's keys. False when there is no such active key. */
export async function revokeApiKey(
  supabase: SupabaseClient,
  input: { organizationId: string; keyId: string },
): Promise<ApiKeyRow | null> {
  const { data, error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", input.keyId)
    .eq("organization_id", input.organizationId)
    .is("revoked_at", null)
    .select(API_KEY_COLUMNS);
  if (error) throw new Error(error.message);
  const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
  return row ? publicKeyRow(row) : null;
}

/** public_api for one workspace, resolved like every flag (override > plan > default). */
export async function publicApiEnabled(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc("org_flag_enabled", {
      p_org: organizationId,
      p_flag: "public_api",
    });
    return !error && data === true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ the caller

export type ApiCaller = { keyId: string; organizationId: string };

/** The public API's error body: a sentence for people and a code for programs. */
export function apiError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error: message, code }, { status, headers });
}

/**
 * The key on "Authorization: Bearer adw_live_…", checked: a known, unrevoked
 * key of a workspace with public_api on. Returns the caller or the
 * 401 / 403 / 503 to send back.
 */
export async function authenticateApiKey(
  supabase: SupabaseClient,
  request: Request,
): Promise<ApiCaller | Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
  const unauthorized = () =>
    apiError(
      401,
      "unauthorized",
      "Missing or invalid API key. Send it as: Authorization: Bearer adw_live_…",
    );
  if (!KEY_SHAPE.test(token)) return unauthorized();

  const hash = hashApiKey(token);
  const { data, error } = await supabase
    .from("api_keys")
    .select("id, organization_id, key_hash, revoked_at, last_used_at")
    .eq("key_hash", hash)
    .maybeSingle();
  if (error)
    return apiError(503, "unavailable", "We couldn't check your API key. Please try again.");
  const row = data as {
    id: string;
    organization_id: string;
    key_hash: string;
    revoked_at: string | null;
    last_used_at: string | null;
  } | null;
  if (!row || !hashesEqual(String(row.key_hash ?? ""), hash) || row.revoked_at)
    return unauthorized();

  if (!(await publicApiEnabled(supabase, row.organization_id))) {
    return apiError(
      403,
      "public_api_disabled",
      "The Public API isn't switched on for this workspace. It is part of the Scale plan — contact AiDwar support to turn it on.",
    );
  }

  // Batch 38: the endpoint must be in the workspace's plan (public-api-plans.ts).
  const { endpointPlanGate } = await import("@/lib/public-api-plans.server");
  const notInPlan = await endpointPlanGate(supabase, row.organization_id, request);
  if (notInPlan) return notInPlan;

  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (!lastUsed || Date.now() - lastUsed >= LAST_USED_EVERY_MS) {
    await supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", row.id);
  }
  return { keyId: row.id, organizationId: row.organization_id };
}

// ------------------------------------------------------------ rate limits

/**
 * One call counted against a fixed one-minute window (api_rate_take, in the
 * database, so every server instance shares the count). Null when allowed,
 * else the 429 (with Retry-After) — or a 503 when the count can't be read:
 * an unknown count is never treated as "under the limit".
 */
export async function takeRateLimit(
  supabase: SupabaseClient,
  caller: ApiCaller,
): Promise<Response | null> {
  const buckets: Array<[string, number, string]> = [
    [
      `key:${caller.keyId}`,
      RATE_PER_KEY_PER_MIN,
      `${RATE_PER_KEY_PER_MIN} requests a minute per API key`,
    ],
    [
      `org:${caller.organizationId}`,
      RATE_PER_WORKSPACE_PER_MIN,
      `${RATE_PER_WORKSPACE_PER_MIN} requests a minute per workspace`,
    ],
  ];
  for (const [bucket, limit, label] of buckets) {
    const { data, error } = await supabase.rpc("api_rate_take", {
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: 60,
    });
    const row = (Array.isArray(data) ? data[0] : data) as {
      allowed?: boolean;
      retry_after?: number;
    } | null;
    if (error || !row || typeof row.allowed !== "boolean") {
      return apiError(
        503,
        "unavailable",
        "We couldn't check the rate limit. Please try again in a moment.",
      );
    }
    if (!row.allowed) {
      const retryAfter = Math.max(1, Math.ceil(Number(row.retry_after ?? 60)));
      return apiError(
        429,
        "rate_limited",
        `Too many requests: the limit is ${label}. Try again in ${retryAfter} s.`,
        {
          "Retry-After": String(retryAfter),
        },
      );
    }
  }
  return null;
}

// ------------------------------------------------------------ idempotency

/** A repeat of the same idempotency_key within this long returns the first answer. */
export const IDEMPOTENCY_WINDOW_MS = IDEMPOTENCY_WINDOW_HOURS * 60 * 60 * 1000;

export type IdempotencyClaim =
  | { kind: "new"; id: string }
  | { kind: "replay"; status: number; body: Record<string, unknown> }
  | { kind: "in_progress" }
  | { kind: "mismatch" }
  | { kind: "error" };

type RequestRow = {
  id: string;
  request_hash: string;
  state: string;
  http_status: number | null;
  response: Record<string, unknown> | null;
  created_at: string;
};

/** sha256 of the request's own fields, in a fixed order. */
export function requestFingerprint(fields: Record<string, unknown>): string {
  const ordered = Object.keys(fields)
    .sort()
    .map((k) => [k, fields[k]]);
  return createHash("sha256").update(JSON.stringify(ordered), "utf8").digest("hex");
}

/**
 * Reserves (organization_id, idempotency_key) before anything is sent.
 * public.api_requests is unique on the pair, so of two identical calls at
 * the same moment exactly one inserts; the other reads that row and is told
 * it is in progress (or, once done, gets the same answer). A row older than
 * 24 h is taken over by one conditional update.
 */
export async function claimIdempotency(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    apiKeyId: string;
    key: string;
    requestHash: string;
    now?: number;
  },
): Promise<IdempotencyClaim> {
  const now = input.now ?? Date.now();
  const read = async (): Promise<RequestRow | null | "error"> => {
    const { data, error } = await supabase
      .from("api_requests")
      .select("id, request_hash, state, http_status, response, created_at")
      .eq("organization_id", input.organizationId)
      .eq("idempotency_key", input.key)
      .maybeSingle();
    return error ? "error" : ((data as RequestRow | null) ?? null);
  };
  const judge = (row: RequestRow): IdempotencyClaim => {
    if (row.request_hash !== input.requestHash) return { kind: "mismatch" };
    if (row.state === "done" && row.http_status)
      return { kind: "replay", status: row.http_status, body: row.response ?? {} };
    return { kind: "in_progress" };
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = await read();
    if (existing === "error") return { kind: "error" };
    if (existing) {
      if (now - Date.parse(existing.created_at) < IDEMPOTENCY_WINDOW_MS) return judge(existing);
      const { data, error } = await supabase
        .from("api_requests")
        .update({
          api_key_id: input.apiKeyId,
          request_hash: input.requestHash,
          state: "processing",
          http_status: null,
          response: null,
          message_id: null,
          created_at: new Date(now).toISOString(),
        })
        .eq("id", existing.id)
        .eq("created_at", existing.created_at)
        .select("id");
      if (error) return { kind: "error" };
      const taken = ((data ?? []) as Array<{ id: string }>)[0];
      if (taken) return { kind: "new", id: taken.id };
      continue; // someone else took it over first: read again
    }
    const { data, error } = await supabase
      .from("api_requests")
      .insert({
        organization_id: input.organizationId,
        api_key_id: input.apiKeyId,
        idempotency_key: input.key,
        request_hash: input.requestHash,
        state: "processing",
      })
      .select("id")
      .single();
    if (!error && data) return { kind: "new", id: (data as { id: string }).id };
    if ((error as { code?: string } | null)?.code !== "23505") return { kind: "error" };
    // Lost the race to an identical call: read what it reserved.
  }
  const last = await read();
  return last && last !== "error" ? judge(last) : { kind: "error" };
}

/** The answer a reserved request gave, kept for its repeats. */
export async function finishIdempotency(
  supabase: SupabaseClient,
  id: string,
  result: { status: number; body: Record<string, unknown>; messageId: string | null },
): Promise<void> {
  const { error } = await supabase
    .from("api_requests")
    .update({
      state: "done",
      http_status: result.status,
      response: result.body,
      message_id: result.messageId,
    })
    .eq("id", id);
  if (error)
    console.warn(
      JSON.stringify({
        scope: "public_api",
        step: "idempotency_finish",
        request_id: id,
        error: error.message,
      }),
    );
}

/** Nothing was sent: the key may be used again (e.g. after topping up credits). */
export async function releaseIdempotency(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase
    .from("api_requests")
    .delete()
    .eq("id", id)
    .eq("state", "processing");
  if (error)
    console.warn(
      JSON.stringify({
        scope: "public_api",
        step: "idempotency_release",
        request_id: id,
        error: error.message,
      }),
    );
}

// ------------------------------------------------------------ upkeep

/** Kept this long: a rate window is read only within its minute, a reservation within 24 h. */
export const RATE_WINDOW_KEEP_MS = 60 * 60_000;
export const REQUEST_KEEP_MS = 48 * 60 * 60_000;
export const DELIVERY_KEEP_MS = 30 * 24 * 60 * 60_000;
/** Most rows one sweep removes per table. */
export const CLEANUP_BATCH = 500;

export type ApiCleanupCounts = {
  api_rate_windows_removed: number;
  api_requests_removed: number;
  api_deliveries_removed: number;
};

/**
 * The billing sweep's Public API upkeep (Batch 34): rate windows older than
 * 1 h, idempotency reservations older than 48 h and finished webhook
 * deliveries older than 30 days are removed — at most CLEANUP_BATCH rows of
 * each per run (rate windows: at most the oldest hour of them), oldest
 * first, so a backlog is worked down over runs. Never throws; without the
 * tables (20261120 not applied) it removes nothing.
 */
export async function cleanupApiRecords(
  supabase: SupabaseClient,
  now = Date.now(),
): Promise<ApiCleanupCounts> {
  const counts: ApiCleanupCounts = {
    api_rate_windows_removed: 0,
    api_requests_removed: 0,
    api_deliveries_removed: 0,
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const step = async (name: string, work: () => Promise<number>) => {
    try {
      return await work();
    } catch (error) {
      console.warn(
        JSON.stringify({
          scope: "public_api_cleanup",
          step: name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return 0;
    }
  };

  // Rate windows have no id (bucket + window_start): one hour of the oldest windows per run.
  counts.api_rate_windows_removed = await step("rate_windows", async () => {
    const cutoff = now - RATE_WINDOW_KEEP_MS;
    const { data, error } = await supabase
      .from("api_rate_windows")
      .select("window_start")
      .lt("window_start", iso(cutoff))
      .order("window_start", { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    const oldest = ((data ?? []) as Array<{ window_start: string }>)[0]?.window_start;
    if (!oldest) return 0;
    const until = Math.min(cutoff, Date.parse(oldest) + RATE_WINDOW_KEEP_MS);
    const { count, error: deleteError } = await supabase
      .from("api_rate_windows")
      .delete({ count: "exact" })
      .lt("window_start", iso(until + 1));
    if (deleteError) throw new Error(deleteError.message);
    return count ?? 0;
  });

  /** Deletes the given ids of one table; how many. */
  const removeIds = async (table: string, rows: unknown): Promise<number> => {
    const ids = ((rows ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (!ids.length) return 0;
    const { error } = await supabase.from(table).delete().in("id", ids);
    if (error) throw new Error(error.message);
    return ids.length;
  };
  counts.api_requests_removed = await step("requests", async () => {
    const { data, error } = await supabase
      .from("api_requests")
      .select("id")
      .lt("created_at", iso(now - REQUEST_KEEP_MS))
      .order("created_at", { ascending: true })
      .limit(CLEANUP_BATCH);
    if (error) throw new Error(error.message);
    return removeIds("api_requests", data);
  });
  counts.api_deliveries_removed = await step("deliveries", async () => {
    const { data, error } = await supabase
      .from("api_webhook_deliveries")
      .select("id")
      .neq("state", "pending")
      .lt("created_at", iso(now - DELIVERY_KEEP_MS))
      .order("created_at", { ascending: true })
      .limit(CLEANUP_BATCH);
    if (error) throw new Error(error.message);
    return removeIds("api_webhook_deliveries", data);
  });
  return counts;
}
