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
 * Offline tokens (shpat_) are issued to the app and never expire; online
 * (per-user) tokens (shpua_) die with the user's session and would break the
 * background sync worker. The install URL therefore never sends
 * grant_options[]=per-user — Shopify defaults to offline without it.
 */
export const ONLINE_TOKEN_ERROR = "online access token detected — reinstall required";

export function isOfflineAccessToken(token: string | null | undefined): boolean {
  return String(token ?? "").startsWith("shpat_");
}

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

export async function exchangeAccessToken(args: {
  shopDomain: string;
  apiKey: string;
  apiSecret: string;
  code: string;
}): Promise<{ ok: boolean; accessToken?: string; scopes?: string[]; error?: string }> {
  const res = await fetch(`https://${args.shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: args.apiKey,
      client_secret: args.apiSecret,
      code: args.code,
    }),
  });
  if (!res.ok) return { ok: false, error: `Shopify refused the token exchange (${res.status}).` };
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const accessToken = String(body["access_token"] ?? "");
  if (!accessToken) return { ok: false, error: "Shopify returned no access token." };
  return {
    ok: true,
    accessToken,
    scopes: String(body["scope"] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
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

/** Resolve a connected store's token. Never returns the token to a client. */
export async function getShopifyConnection(
  supabase: SupabaseClient,
  integrationId: string,
): Promise<
  | { ok: true; integration: Record<string, unknown>; shopDomain: string; accessToken: string }
  | { ok: false; error: string }
> {
  const { data: integration } = await supabase
    .from("integrations")
    .select("*")
    .eq("id", integrationId)
    .maybeSingle();
  if (!integration) return { ok: false, error: "That store is not connected." };

  const { data: credential } = await supabase
    .from("integration_credentials")
    .select("access_token")
    .eq("integration_id", integrationId)
    .maybeSingle();
  const accessToken = (credential as { access_token?: string } | null)?.access_token ?? "";
  if (!accessToken) return { ok: false, error: "This store has no stored access token." };

  return {
    ok: true,
    integration: integration as Record<string, unknown>,
    shopDomain: String((integration as { shop_domain?: string }).shop_domain ?? ""),
    accessToken,
  };
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
