import type { SupabaseClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "crypto";

/**
 * The merchant's own accounts used by Flows v2 steps.
 * - Google: each workspace connects its own Google account (Sheets append).
 *   AiDwar's OAuth client (GOOGLE_OAUTH_CLIENT_ID/SECRET) only brokers consent;
 *   the refresh token lives in Vault.
 * - Razorpay: each workspace enters its own key id / secret / webhook secret,
 *   so payments go straight to the merchant. Secrets live in Vault.
 * Nothing here is ever returned to the browser or logged.
 */

export type Provider = "google" | "razorpay";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/userinfo.email";

export function googleOAuthConfigured(): boolean {
  return Boolean(process.env["GOOGLE_OAUTH_CLIENT_ID"] && process.env["GOOGLE_OAUTH_CLIENT_SECRET"]);
}

export async function loadSecret(
  supabase: SupabaseClient,
  organizationId: string,
  provider: Provider,
): Promise<{ id: string; status: string; config: Record<string, unknown>; secret: Record<string, string> } | null> {
  const { data } = await supabase.rpc("workspace_connection_secret", { p_org: organizationId, p_provider: provider });
  const row = ((data ?? []) as Array<{ id: string; status: string; public_config: Record<string, unknown>; secret: string | null }>)[0];
  if (!row || !row.secret) return null;
  try {
    return { id: row.id, status: row.status, config: row.public_config ?? {}, secret: JSON.parse(row.secret) };
  } catch {
    return null;
  }
}

export async function saveConnection(
  supabase: SupabaseClient,
  args: { organizationId: string; provider: Provider; label: string; config: Record<string, unknown>; secret: Record<string, string>; userId: string | null },
): Promise<{ error: string | null }> {
  const { data, error } = await supabase
    .from("workspace_connections")
    .upsert(
      {
        organization_id: args.organizationId,
        provider: args.provider,
        account_label: args.label,
        public_config: args.config,
        status: "active",
        last_error: null,
        connected_by: args.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id,provider" },
    )
    .select("id")
    .single();
  if (error || !data) return { error: "Couldn't save the connection. Please try again." };
  const { error: vErr } = await supabase.rpc("workspace_connection_set_secret", {
    p_id: (data as { id: string }).id,
    p_secret: JSON.stringify(args.secret),
  });
  return { error: vErr ? "Couldn't store the keys securely. Please try again." : null };
}

export async function deleteConnection(supabase: SupabaseClient, organizationId: string, provider: Provider) {
  const { data } = await supabase
    .from("workspace_connections")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("provider", provider)
    .maybeSingle();
  if (data) await supabase.rpc("workspace_connection_delete", { p_id: (data as { id: string }).id });
}

async function markError(supabase: SupabaseClient, organizationId: string, provider: Provider, message: string) {
  await supabase
    .from("workspace_connections")
    .update({ status: "error", last_error: message.slice(0, 300), updated_at: new Date().toISOString() })
    .eq("organization_id", organizationId)
    .eq("provider", provider);
}

// ---------------------------------------------------------------- OAuth state

export function signState(payload: Record<string, string>): string {
  const body = Buffer.from(JSON.stringify({ ...payload, t: Date.now() })).toString("base64url");
  const sig = createHmac("sha256", process.env["FLOW_OAUTH_STATE_SECRET"]!).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readState(state: string): Record<string, string> | null {
  const [body, sig] = state.split(".");
  if (!body || !sig || !process.env["FLOW_OAUTH_STATE_SECRET"]) return null;
  const expected = createHmac("sha256", process.env["FLOW_OAUTH_STATE_SECRET"]).update(body).digest("base64url");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString()) as Record<string, string> & { t: number };
    if (Date.now() - Number(p.t) > 15 * 60_000) return null;
    return p;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Google

export function googleRedirectUri(origin: string): string {
  return `${origin}/api/public/google-oauth-callback`;
}

export function googleAuthUrl(origin: string, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", process.env["GOOGLE_OAUTH_CLIENT_ID"]!);
  u.searchParams.set("redirect_uri", googleRedirectUri(origin));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", SHEETS_SCOPE);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  return u.toString();
}

export async function exchangeGoogleCode(origin: string, code: string): Promise<{ refreshToken: string; email: string } | { error: string }> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env["GOOGLE_OAUTH_CLIENT_ID"]!,
      client_secret: process.env["GOOGLE_OAUTH_CLIENT_SECRET"]!,
      redirect_uri: googleRedirectUri(origin),
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok || !body["refresh_token"]) return { error: "Google didn't give us access. Please try connecting again." };
  const who = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${body["access_token"]}` } });
  const info = (await who.json().catch(() => ({}))) as { email?: string };
  return { refreshToken: body["refresh_token"], email: info.email ?? "Google account" };
}

async function googleAccessToken(refreshToken: string): Promise<string | null> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env["GOOGLE_OAUTH_CLIENT_ID"] ?? "",
      client_secret: process.env["GOOGLE_OAUTH_CLIENT_SECRET"] ?? "",
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string };
  return res.ok && body.access_token ? body.access_token : null;
}

/** Spreadsheet id from a full Google Sheets link or a bare id. */
export function spreadsheetId(input: string): string {
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1]! : input.trim();
}

/**
 * The append address for one row. The tab name is always quoted, so tabs like
 * "Leads 2026" or "Rao's" work. valueInputOption=RAW: every value lands
 * exactly as the customer wrote it — "+91 98…" stays a phone number, "007"
 * keeps its zeros, "1-2" isn't turned into a date and "=…" is never run as a
 * formula (USER_ENTERED re-read customer answers as if typed into the sheet).
 */
export function sheetAppendUrl(sheet: string, tab: string): string {
  const id = spreadsheetId(sheet);
  const name = (tab || "Sheet1").replace(/'/g, "''");
  const range = encodeURIComponent(`'${name}'!A1`);
  return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(id)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
}

export async function appendSheetRow(
  supabase: SupabaseClient,
  organizationId: string,
  args: { sheet: string; tab: string; values: string[] },
): Promise<{ ok: boolean; error: string | null }> {
  const conn = await loadSecret(supabase, organizationId, "google");
  if (!conn?.secret["refresh_token"]) return { ok: false, error: "google_not_connected" };
  const token = await googleAccessToken(conn.secret["refresh_token"]);
  if (!token) {
    await markError(supabase, organizationId, "google", "Google access was removed. Reconnect Google in Settings → Integrations.");
    return { ok: false, error: "google_access_revoked" };
  }
  const res = await fetch(sheetAppendUrl(args.sheet, args.tab), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: [args.values] }),
  });
  if (!res.ok) return { ok: false, error: res.status === 404 ? "sheet_not_found" : res.status === 403 ? "sheet_no_access" : "sheet_append_failed" };
  return { ok: true, error: null };
}

// ---------------------------------------------------------------- Razorpay

export async function verifyRazorpayKeys(keyId: string, keySecret: string): Promise<boolean> {
  const res = await fetch("https://api.razorpay.com/v1/payment_links?count=1", {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}` },
  });
  return res.ok;
}

export async function createPaymentLink(
  supabase: SupabaseClient,
  organizationId: string,
  args: { amountRupees: number; description: string; name: string | null; phone: string; expireHours: number; runId: string; nodeId: string },
): Promise<{ url: string; id: string } | { error: string }> {
  const conn = await loadSecret(supabase, organizationId, "razorpay");
  if (!conn?.secret["key_id"] || !conn.secret["key_secret"]) return { error: "razorpay_not_connected" };
  const amount = Math.round(args.amountRupees * 100);
  if (!Number.isFinite(amount) || amount < 100) return { error: "invalid_amount" };
  const expire = Math.floor(Date.now() / 1000) + Math.max(args.expireHours, 1) * 3600 + 20 * 60;
  const res = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${conn.secret["key_id"]}:${conn.secret["key_secret"]}`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount,
      currency: "INR",
      description: args.description.slice(0, 2048),
      expire_by: expire,
      customer: { ...(args.name ? { name: args.name } : {}), contact: `+${args.phone.replace(/\D/g, "")}` },
      notify: { sms: false, email: false },
      notes: { aidwar_org: organizationId, aidwar_run: args.runId, aidwar_node: args.nodeId },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; short_url?: string };
  if (res.status === 401) {
    await markError(supabase, organizationId, "razorpay", "Razorpay rejected the saved keys. Enter new keys in Settings → Integrations.");
    return { error: "razorpay_keys_rejected" };
  }
  if (!res.ok || !body.short_url || !body.id) return { error: "payment_link_failed" };
  return { url: body.short_url, id: body.id };
}

export async function razorpayWebhookSecretFor(supabase: SupabaseClient, organizationId: string): Promise<string | null> {
  const conn = await loadSecret(supabase, organizationId, "razorpay");
  return conn?.secret["webhook_secret"] || null;
}
