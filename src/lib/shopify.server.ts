import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Shopify plumbing: OAuth, signature verification, REST access.
 *
 * Two rules hold in this file:
 *  1. The API secret is read inside functions from process.env and never
 *     leaves the server. Access tokens live only in integration_credentials,
 *     which grants nothing to anon or authenticated.
 *  2. Nothing here trusts a request until its HMAC verifies — Shopify's
 *     signature is the only proof a callback or webhook is genuine.
 */

export const SHOPIFY_API_VERSION = "2024-10";

/** The exact scopes this app asks for. Sync only — all read. */
export const SHOPIFY_SCOPES = [
  "read_orders",
  "read_checkouts",
  "read_customers",
  "read_products",
] as const;

/** Topics we subscribe to on install, including Shopify's mandatory ones. */
export const SHOPIFY_WEBHOOK_TOPICS = [
  "orders/create",
  "orders/updated",
  "orders/cancelled",
  "orders/fulfilled",
  "checkouts/create",
  "checkouts/update",
  "customers/create",
  "customers/update",
  "products/create",
  "products/update",
  "products/delete",
  "app/uninstalled",
] as const;

export function shopifyCredentials(): { apiKey: string; apiSecret: string } | null {
  const apiKey = process.env["SHOPIFY_API_KEY"] ?? "";
  const apiSecret = process.env["SHOPIFY_API_SECRET"] ?? "";
  if (!apiKey || !apiSecret) return null;
  return { apiKey, apiSecret };
}

/** Service-role client for the external AiDwar backend. */
export function getServiceClient(): SupabaseClient {
  const url = process.env["AIDWAR_SUPABASE_URL"] ?? "";
  const key = process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!url || !key) throw new Error("Missing AiDwar backend service configuration.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** myshopify.com host, lowercased, with any scheme or path stripped. */
export function normalizeShopDomain(input: string | null | undefined): string {
  const raw = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(raw) ? raw : "";
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacBytes(secret: string, body: string): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, enc.encode(body));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** OAuth callback: hex HMAC over the sorted query string, hmac removed. */
export async function verifyOAuthHmac(url: URL, secret: string): Promise<boolean> {
  const provided = url.searchParams.get("hmac") ?? "";
  if (!provided) return false;
  const parts: string[] = [];
  for (const [k, v] of Array.from(url.searchParams.entries())) {
    if (k === "hmac" || k === "signature") continue;
    parts.push(`${k}=${v}`);
  }
  parts.sort();
  const expected = toHex(await hmacBytes(secret, parts.join("&")));
  return timingSafeEqual(provided.toLowerCase(), expected);
}

/** Webhooks: base64 HMAC over the exact raw body. */
export async function verifyWebhookHmac(
  rawBody: string,
  header: string | null,
  secret: string,
): Promise<boolean> {
  if (!header) return false;
  const expected = toBase64(await hmacBytes(secret, rawBody));
  return timingSafeEqual(header, expected);
}

/**
 * Access-mode guard. The shpat_/shpua_ prefix reflects the app's distribution
 * status, not its access mode, so it cannot be used to tell offline from
 * online. The reliable signal is the token response itself: Shopify only
 * includes an associated_user object when the token is online (per-user).
 */
export const ONLINE_TOKEN_ERROR = "online access token detected — reinstall required";

/** The refresh token is gone for good; only a fresh install can fix it. */
export const AUTH_EXPIRED_ERROR = "Shopify authorization expired — reconnect required";

/** Refresh this many ms before the stated expiry so a call never races it. */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export function buildInstallUrl(args: {
  shopDomain: string;
  apiKey: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`https://${args.shopDomain}/admin/oauth/authorize`);
  url.searchParams.set("client_id", args.apiKey);
  url.searchParams.set("scope", SHOPIFY_SCOPES.join(","));
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  // Deliberately no grant_options[]=per-user: that would mint an online token.
  return url.toString();
}


export function callbackUrl(request: Request): string {
  const configured = process.env["SHOPIFY_APP_URL"];
  const origin = configured ? configured.replace(/\/$/, "") : new URL(request.url).origin;
  return `${origin}/api/public/shopify-callback`;
}

export type TokenGrant = {
  accessToken: string;
  scopes: string[];
  /** Seconds until the access token dies. Absent on legacy non-expiring grants. */
  expiresIn: number | null;
  refreshToken: string | null;
  refreshTokenExpiresIn: number | null;
  /** Present only on online (per-user) tokens. */
  associatedUser: boolean;
};

function parseTokenBody(body: Record<string, unknown>): TokenGrant | null {
  const accessToken = String(body["access_token"] ?? "");
  if (!accessToken) return null;
  const num = (key: string) => {
    const value = Number(body[key]);
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    accessToken,
    scopes: String(body["scope"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    expiresIn: num("expires_in"),
    refreshToken: (body["refresh_token"] as string | undefined) || null,
    refreshTokenExpiresIn: num("refresh_token_expires_in"),
    associatedUser: Boolean(body["associated_user"]),
  };
}

/** Timestamps written to integration_credentials, derived at write time. */
export function grantTimestamps(grant: TokenGrant): {
  expires_at: string | null;
  refresh_token: string | null;
  refresh_token_expires_at: string | null;
} {
  const now = Date.now();
  return {
    expires_at: grant.expiresIn ? new Date(now + grant.expiresIn * 1000).toISOString() : null,
    refresh_token: grant.refreshToken,
    refresh_token_expires_at: grant.refreshTokenExpiresIn
      ? new Date(now + grant.refreshTokenExpiresIn * 1000).toISOString()
      : null,
  };
}

export async function exchangeAccessToken(args: {
  shopDomain: string;
  apiKey: string;
  apiSecret: string;
  code: string;
}): Promise<{ ok: boolean; grant?: TokenGrant; error?: string }> {
  const res = await fetch(`https://${args.shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: args.apiKey,
      client_secret: args.apiSecret,
      code: args.code,
      // Apps created after 2026-04-01 must use expiring offline tokens; the
      // Admin API rejects non-expiring ones outright.
      expiring: 1,
    }),
  });
  if (!res.ok) return { ok: false, error: `Shopify refused the token exchange (${res.status}).` };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const grant = parseTokenBody(body);
  if (!grant) return { ok: false, error: "Shopify returned no access token." };
  return { ok: true, grant };
}

/**
 * Exchange the stored refresh token for a fresh pair.
 *
 * Retry semantics matter here. Network failures, timeouts, 5xx and 429 are
 * transient and the *same* refresh token may be retried — Shopify replays the
 * same refreshed response for up to an hour. Only a 401 invalid_request (or a
 * refresh token past its 90-day life) means the grant is definitively dead.
 */
export async function refreshAccessToken(args: {
  shopDomain: string;
  apiKey: string;
  apiSecret: string;
  refreshToken: string;
}): Promise<{ ok: true; grant: TokenGrant } | { ok: false; fatal: boolean; error: string }> {
  let res: Response;
  try {
    res = await fetch(`https://${args.shopDomain}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: args.apiKey,
        client_secret: args.apiSecret,
        grant_type: "refresh_token",
        refresh_token: args.refreshToken,
      }),
    });
  } catch (err) {
    // Transient: the same refresh token stays valid and can be retried.
    return {
      ok: false,
      fatal: false,
      error: err instanceof Error ? err.message : "Shopify token refresh failed.",
    };
  }

  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    body = {};
  }

  if (!res.ok) {
    const fatal = res.status === 401 && String(body["error"] ?? "") === "invalid_request";
    return {
      ok: false,
      fatal,
      error: fatal
        ? AUTH_EXPIRED_ERROR
        : `Shopify token refresh failed (${res.status}). ${raw.slice(0, 200)}`,
    };
  }

  const grant = parseTokenBody(body);
  if (!grant) return { ok: false, fatal: false, error: "Shopify returned no access token." };
  return { ok: true, grant };
}


export type RestResult = {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  /** Cursor for the next page, when Shopify sent a rel="next" Link header. */
  nextPageInfo: string | null;
  /** Shopify's request id, echoed in X-Request-Id — needed for support. */
  requestId?: string | null;

};

function nextPageInfoFrom(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    if (!part.includes('rel="next"')) continue;
    const match = part.match(/<([^>]+)>/);
    if (!match?.[1]) continue;
    return new URL(match[1]).searchParams.get("page_info");
  }
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Rate-limit aware REST call. Shopify leaks its bucket in
 * X-Shopify-Shop-Api-Call-Limit; when it fills we back off before being told
 * to, and we always honour Retry-After on a 429.
 */
export async function shopifyRest(args: {
  shopDomain: string;
  accessToken: string;
  path: string;
  query?: Record<string, string>;
  method?: string;
  body?: unknown;
  attempt?: number;
}): Promise<RestResult> {
  const url = new URL(
    `https://${args.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/${args.path.replace(/^\//, "")}`,
  );
  for (const [k, v] of Object.entries(args.query ?? {})) if (v) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method: args.method ?? "GET",
    headers: {
      "X-Shopify-Access-Token": args.accessToken,
      ...(args.body ? { "content-type": "application/json" } : {}),
    },
    ...(args.body ? { body: JSON.stringify(args.body) } : {}),
  });

  const attempt = args.attempt ?? 0;
  if (res.status === 429 && attempt < 5) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "2");
    await sleep(Math.min(Math.max(retryAfter, 1), 10) * 1000);
    return shopifyRest({ ...args, attempt: attempt + 1 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  // Pre-emptive breather when the leaky bucket is nearly full.
  const limit = res.headers.get("x-shopify-shop-api-call-limit");
  if (limit) {
    const [used, cap] = limit.split("/").map((n) => Number(n));
    if (used && cap && used / cap > 0.8) await sleep(1000);
  }

  return {
    ok: res.ok,
    status: res.status,
    body,
    nextPageInfo: nextPageInfoFrom(res.headers.get("link")),
    requestId: res.headers.get("x-request-id"),
  };
}

/**
 * The full diagnostic: Shopify's own message plus its X-Request-Id, which is
 * what support needs. A bare status code costs a debugging round trip.
 */
export function restErrorMessage(result: RestResult): string {
  const errors = result.body["errors"] ?? result.body["error"];
  let detail = "";
  if (typeof errors === "string") detail = errors;
  else if (errors && typeof errors === "object") detail = JSON.stringify(errors).slice(0, 300);
  const parts = [`Shopify returned ${result.status}`];
  if (detail) parts.push(detail);
  if (result.requestId) parts.push(`X-Request-Id: ${result.requestId}`);
  return parts.join(" — ");
}


/** Registers every topic. Already-registered topics come back as 422 and are fine. */
export async function registerWebhooks(args: {
  shopDomain: string;
  accessToken: string;
  callbackBase: string;
}): Promise<{ registered: string[]; failed: string[] }> {
  const registered: string[] = [];
  const failed: string[] = [];
  for (const topic of SHOPIFY_WEBHOOK_TOPICS) {
    const result = await shopifyRest({
      shopDomain: args.shopDomain,
      accessToken: args.accessToken,
      path: "webhooks.json",
      method: "POST",
      body: {
        webhook: {
          topic,
          address: `${args.callbackBase}/api/public/shopify-webhook`,
          format: "json",
        },
      },
    });
    if (result.ok || result.status === 422) registered.push(topic);
    else failed.push(topic);
  }
  return { registered, failed };
}

/** Mark a store as needing a fresh install; the UI surfaces the reconnect prompt. */
export async function markAuthExpired(
  supabase: SupabaseClient,
  integrationId: string,
): Promise<void> {
  await supabase
    .from("integrations")
    .update({ status: "error", sync_error: AUTH_EXPIRED_ERROR })
    .eq("id", integrationId);
}

/**
 * Persist a refreshed grant. The previous refresh token is invalidated the
 * moment Shopify hands back a new one, so both halves are written together.
 * token_refreshed_at records the rotation itself, so refresh health can be read
 * directly instead of inferred from expiry maths.
 */
async function persistGrant(
  supabase: SupabaseClient,
  args: { integrationId: string; organizationId: string; grant: TokenGrant },
): Promise<void> {
  const now = new Date().toISOString();
  await supabase
    .from("integration_credentials")
    .update({
      access_token: args.grant.accessToken,
      ...(args.grant.scopes.length ? { granted_scopes: args.grant.scopes } : {}),
      ...grantTimestamps(args.grant),
      token_refreshed_at: now,
      updated_at: now,
    })
    .eq("integration_id", args.integrationId);

  if (args.organizationId) {
    await supabase.from("activity_log").insert({
      organization_id: args.organizationId,
      action: "shopify_token_refreshed",
      details: {
        provider: "shopify",
        integration_id: args.integrationId,
        expires_at: grantTimestamps(args.grant).expires_at,
        refreshed_at: now,
      },
    });
  }
}


/**
 * Resolve a connected store's token, refreshing it first when it is inside the
 * skew window. Never returns the token — or the refresh token — to a client.
 */
export async function getShopifyConnection(
  supabase: SupabaseClient,
  integrationId: string,
): Promise<
  | { ok: true; integration: Record<string, unknown>; shopDomain: string; accessToken: string }
  | { ok: false; error: string; fatal?: boolean }
> {
  const { data: integration } = await supabase
    .from("integrations")
    .select("*")
    .eq("id", integrationId)
    .maybeSingle();
  if (!integration) return { ok: false, error: "That store is not connected." };
  const shopDomain = String((integration as { shop_domain?: string }).shop_domain ?? "");
  const organizationId = String((integration as { organization_id?: string }).organization_id ?? "");

  const { data: credential } = await supabase
    .from("integration_credentials")
    .select("access_token, expires_at, refresh_token, refresh_token_expires_at")
    .eq("integration_id", integrationId)
    .maybeSingle();
  const cred = credential as {
    access_token?: string;
    expires_at?: string | null;
    refresh_token?: string | null;
    refresh_token_expires_at?: string | null;
  } | null;
  let accessToken = cred?.access_token ?? "";
  if (!accessToken) return { ok: false, error: "This store has no stored access token." };

  const expiresAt = cred?.expires_at ? Date.parse(cred.expires_at) : null;
  const needsRefresh = expiresAt !== null && expiresAt - Date.now() <= TOKEN_REFRESH_SKEW_MS;

  if (needsRefresh) {
    const refreshed = await refreshShopifyToken(supabase, {
      integrationId,
      organizationId,
      shopDomain,
      refreshToken: cred?.refresh_token ?? null,
      refreshTokenExpiresAt: cred?.refresh_token_expires_at ?? null,
    });
    if (!refreshed.ok) return { ok: false, error: refreshed.error, fatal: refreshed.fatal };
    accessToken = refreshed.accessToken;
  }

  return {
    ok: true,
    integration: integration as Record<string, unknown>,
    shopDomain,
    accessToken,
  };
}

/**
 * Refresh and persist. Fatal outcomes (dead or missing refresh token, or one
 * past its 90-day life) flip the integration to error; every other failure is
 * transient and leaves the stored refresh token intact for the next attempt.
 */
export async function refreshShopifyToken(
  supabase: SupabaseClient,
  args: {
    integrationId: string;
    organizationId: string;
    shopDomain: string;
    refreshToken: string | null;
    refreshTokenExpiresAt?: string | null;
  },
): Promise<{ ok: true; accessToken: string } | { ok: false; fatal: boolean; error: string }> {
  const creds = shopifyCredentials();
  if (!creds) return { ok: false, fatal: false, error: "Shopify app credentials are not configured." };

  const rtExpiry = args.refreshTokenExpiresAt ? Date.parse(args.refreshTokenExpiresAt) : null;
  if (!args.refreshToken || (rtExpiry !== null && rtExpiry <= Date.now())) {
    await markAuthExpired(supabase, args.integrationId);
    return { ok: false, fatal: true, error: AUTH_EXPIRED_ERROR };
  }

  const result = await refreshAccessToken({
    shopDomain: args.shopDomain,
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    refreshToken: args.refreshToken,
  });

  if (!result.ok) {
    if (result.fatal) await markAuthExpired(supabase, args.integrationId);
    return result;
  }

  await persistGrant(supabase, {
    integrationId: args.integrationId,
    organizationId: args.organizationId,
    grant: result.grant,
  });
  return { ok: true, accessToken: result.grant.accessToken };
}


/**
 * OAuth state. Signed rather than stored: the callback arrives on a public
 * route with no session, so the state itself has to carry — and prove — which
 * workspace started the install.
 */
export async function signInstallState(payload: {
  organizationId: string;
  shopDomain: string;
  userId: string;
}): Promise<string> {
  const creds = shopifyCredentials();
  if (!creds) throw new Error("Shopify app credentials are not configured.");
  const body = JSON.stringify({ ...payload, ts: Date.now(), nonce: crypto.randomUUID() });
  const encoded = btoa(body).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const signature = toHex(await hmacBytes(creds.apiSecret, encoded));
  return `${encoded}.${signature}`;
}

export async function verifyInstallState(
  state: string,
): Promise<{ organizationId: string; shopDomain: string; userId: string } | null> {
  const creds = shopifyCredentials();
  if (!creds) return null;
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return null;
  const expected = toHex(await hmacBytes(creds.apiSecret, encoded));
  if (!timingSafeEqual(signature, expected)) return null;

  try {
    const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(padded)) as Record<string, unknown>;
    // An install link older than an hour is stale, not an install.
    if (Date.now() - Number(parsed["ts"] ?? 0) > 60 * 60 * 1000) return null;
    const organizationId = String(parsed["organizationId"] ?? "");
    const shopDomain = String(parsed["shopDomain"] ?? "");
    const userId = String(parsed["userId"] ?? "");
    if (!organizationId || !shopDomain) return null;
    return { organizationId, shopDomain, userId };
  } catch {
    return null;
  }
}
