import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash, randomBytes, timingSafeEqual } from "crypto";

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

export const API_KEY_PREFIX = "adw_live_";
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

  const lastUsed = row.last_used_at ? Date.parse(row.last_used_at) : 0;
  if (!lastUsed || Date.now() - lastUsed >= LAST_USED_EVERY_MS) {
    await supabase
      .from("api_keys")
      .update({ last_used_at: new Date().toISOString() })
      .eq("id", row.id);
  }
  return { keyId: row.id, organizationId: row.organization_id };
}
