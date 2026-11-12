import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_PUBLIC_URL } from "@/lib/app-url";
import { normalizePhone, toWaId } from "@/lib/phone";
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  newWaAuthCode,
  placeholderEmail,
  readWaAuthCode,
  waAuthMessage,
  waMeLink,
  type WaAuthPurpose,
} from "@/lib/wa-auth";

/**
 * Batch 74: WhatsApp-only sign-up and log-in, server side.
 *
 * Proof of the number: the browser gets a short code bound to (lead or user,
 * the E.164 number, a random nonce kept in an httpOnly cookie — only its
 * sha256 is stored). The visitor sends "VERIFY V-XXXX" / "LOGIN L-XXXX" to
 * AiDwar's own number; the code counts only when the sender's wa_id is the
 * number it was issued for. The browser polls with its cookie and moves on by
 * itself; the WhatsApp reply carries a one-time 15-minute link for someone on
 * another device. Each code is used once and claimed once.
 *
 * Sessions are Supabase's own: the user is created with
 * auth.admin.createUser (phone confirmed; a placeholder email because
 * Supabase hands a server-made session to a browser only through an email
 * token), and auth.admin.generateLink({ type: "magiclink" }) gives a
 * single-use token hash — no email is sent — which only the verified browser
 * receives and exchanges with auth.verifyOtp({ token_hash, type: "email" }).
 * No custom session system.
 */

export const START_COOKIE = "aidwar_start";
export const LOGIN_COOKIE = "aidwar_login";
const LABEL = "aidwar-wa-auth";
const LINK_TTL_MS = 15 * 60 * 1000;
const PER_PHONE_PER_HOUR = 5;
const PER_IP_PER_HOUR = 12;
/** The statuses in which an AD-code chat proved this number (onboarding_sessions). */
const BOUND_STATUSES = ["bound", "learning", "ready", "tested", "connected", "completed"];

const enc = new TextEncoder();

/* --------------------------------------------------------------- crypto --- */

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 24): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function hmacKey(): Promise<CryptoKey> {
  const secret = process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!secret) throw new Error("Missing AiDwar backend service configuration.");
  let key = keyCache.get(secret);
  if (!key) {
    key = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(LABEL) },
        ikm,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign"],
      );
    })();
    keyCache.set(secret, key);
  }
  return key;
}

async function sign(payload: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(payload));
  return base64url(new Uint8Array(sig)).slice(0, 32);
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* -------------------------------------------------------------- cookies --- */

/** /start's cookie: the lead, the browser's nonce, signed. 24 h (the nudge link can resume it). */
export async function startCookieValue(leadId: string, nonce: string): Promise<string> {
  return `${leadId}.${nonce}.${await sign(`start|${leadId}|${nonce}`)}`;
}

export async function readStartCookie(
  request: Request,
): Promise<{ leadId: string; nonce: string } | null> {
  const raw = cookieOf(request, START_COOKIE);
  const [leadId, nonce, sig] = (raw ?? "").split(".");
  if (!leadId || !nonce || !sig) return null;
  return same(sig, await sign(`start|${leadId}|${nonce}`)) ? { leadId, nonce } : null;
}

export async function loginCookieValue(nonce: string): Promise<string> {
  return `${nonce}.${await sign(`login|${nonce}`)}`;
}

export async function readLoginCookie(request: Request): Promise<string | null> {
  const raw = cookieOf(request, LOGIN_COOKIE);
  const [nonce, sig] = (raw ?? "").split(".");
  if (!nonce || !sig) return null;
  return same(sig, await sign(`login|${nonce}`)) ? nonce : null;
}

export function cookieOf(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function setCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** A signed, 24-hour token for the nudge's "continue" button (no row to store). */
export async function continueToken(leadId: string, now = Date.now()): Promise<string> {
  const exp = Math.floor((now + 24 * 60 * 60 * 1000) / 1000).toString(36);
  return `${leadId}.${exp}.${await sign(`continue|${leadId}|${exp}`)}`;
}

export async function readContinueToken(token: string, now = Date.now()): Promise<string | null> {
  const [leadId, exp, sig] = (token ?? "").split(".");
  if (!leadId || !exp || !sig) return null;
  if (!same(sig, await sign(`continue|${leadId}|${exp}`))) return null;
  if (parseInt(exp, 36) * 1000 < now) return null;
  return leadId;
}

/* ------------------------------------------------------- the AiDwar number --- */

/** AiDwar's own WhatsApp number (digits), from platform_settings — never hardcoded. */
export async function onboardingWaId(supabase: SupabaseClient): Promise<string | null> {
  const { data: settings } = await supabase
    .from("platform_settings")
    .select("onboarding_whatsapp_account_id")
    .maybeSingle();
  const accountId =
    (settings as { onboarding_whatsapp_account_id?: string | null } | null)
      ?.onboarding_whatsapp_account_id ?? null;
  if (!accountId) return null;
  const { data: account } = await supabase
    .from("whatsapp_accounts")
    .select("display_phone_number")
    .eq("id", accountId)
    .maybeSingle();
  return toWaId((account as { display_phone_number?: string } | null)?.display_phone_number) || null;
}

/* ---------------------------------------------------------------- codes --- */

export type VerificationRow = {
  id: string;
  lead_id: string | null;
  purpose: WaAuthPurpose;
  code: string;
  phone: string;
  browser_nonce_hash: string;
  user_id: string | null;
  expires_at: string;
  used_at: string | null;
  attempts: number;
  link_token_hash: string | null;
  claimed_at: string | null;
  created_at: string;
};

const ROW =
  "id, lead_id, purpose, code, phone, browser_nonce_hash, user_id, expires_at, used_at, attempts, link_token_hash, claimed_at, created_at";

export async function hashIpForLimit(ip: string | null): Promise<string | null> {
  return ip ? (await sha256Hex(`aidwar-wa-auth-ip:${ip}`)).slice(0, 24) : null;
}

/**
 * A fresh code for this browser (nonce) and number. At most 5 codes an hour
 * per number and 12 per IP. Answers the wa.me link that opens WhatsApp with
 * the message ready.
 */
export async function issueCode(
  supabase: SupabaseClient,
  input: {
    purpose: WaAuthPurpose;
    phone: string;
    nonce: string;
    leadId?: string | null;
    userId?: string | null;
    ip: string | null;
    now?: number;
  },
): Promise<
  | { ok: true; code: string; waLink: string; message: string; expiresAt: string }
  | { ok: false; error: string; status: number }
> {
  const now = input.now ?? Date.now();
  const phone = normalizePhone(input.phone);
  const hourAgo = new Date(now - 60 * 60 * 1000).toISOString();
  const { count: byPhone } = await supabase
    .from("lead_verifications")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone)
    .gte("created_at", hourAgo);
  if ((byPhone ?? 0) >= PER_PHONE_PER_HOUR) {
    return { ok: false, error: "Too many codes for this number. Please try again in an hour.", status: 429 };
  }
  const ipHash = await hashIpForLimit(input.ip);
  if (ipHash) {
    const { count: byIp } = await supabase
      .from("lead_verifications")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", hourAgo);
    if ((byIp ?? 0) >= PER_IP_PER_HOUR) {
      return { ok: false, error: "Too many tries from here. Please try again later.", status: 429 };
    }
  }
  const aidwar = await onboardingWaId(supabase);
  if (!aidwar) {
    return { ok: false, error: "WhatsApp verification isn't available right now.", status: 503 };
  }
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  const nonceHash = await sha256Hex(input.nonce);
  for (let i = 0; i < 5; i++) {
    const code = newWaAuthCode(input.purpose, crypto.getRandomValues(new Uint8Array(4)));
    const { error } = await supabase.from("lead_verifications").insert({
      lead_id: input.leadId ?? null,
      purpose: input.purpose,
      code,
      phone,
      browser_nonce_hash: nonceHash,
      user_id: input.userId ?? null,
      expires_at: expiresAt,
      ip_hash: ipHash,
    });
    if (!error) {
      const message = waAuthMessage(input.purpose, code);
      return { ok: true, code, waLink: waMeLink(aidwar, message), message, expiresAt };
    }
    if (!/duplicate|unique|23505/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) break;
  }
  return { ok: false, error: "We couldn't make a code just now. Please try again.", status: 500 };
}

/* -------------------------------------------------------------- inbound --- */

type Channel = {
  organizationId: string;
  phoneNumberId: string;
  accessToken: string;
  conversationId: string;
  to: string;
};

function startUrl(): string {
  return `${APP_PUBLIC_URL.replace(/^https?:\/\//, "")}/start`;
}

/**
 * "VERIFY V-XXXX" / "LOGIN L-XXXX" from a WhatsApp number to AiDwar's own
 * number. Counts only when the sender is the number the code was issued
 * for; a wrong number never learns whose code it is. Always answers the
 * sender (free text, inside the window they just opened) and returns true;
 * false only when the message carries no code at all.
 */
export async function handleWaAuthMessage(
  supabase: SupabaseClient,
  args: { channel: Channel; waId: string; body: string; now?: number },
): Promise<boolean> {
  const parsed = readWaAuthCode(args.body);
  if (!parsed) return false;
  const now = args.now ?? Date.now();
  const where = parsed.purpose === "verify" ? startUrl() : `${startUrl().replace(/\/start$/, "")}/login`;
  const say = async (text: string, kind: string) => {
    const { sendServiceText } = await import("@/lib/service-text.server");
    await sendServiceText(supabase, {
      ...args.channel,
      body: text,
      metadata: { kind: `wa_auth_${kind}` },
    });
  };

  const { data } = await supabase
    .from("lead_verifications")
    .select(ROW)
    .eq("code", parsed.code)
    .eq("purpose", parsed.purpose)
    .maybeSingle();
  const row = data as VerificationRow | null;

  if (!row) {
    await say(`That code isn't valid. Please go back to ${where} and tap the button again.`, "unknown");
    return true;
  }
  if (row.used_at) {
    await say(`That code was already used. Go back to ${where} for a new one.`, "used");
    return true;
  }
  if (row.attempts >= MAX_CODE_ATTEMPTS) {
    await say(`That code is locked after too many tries. Go back to ${where} for a new one.`, "locked");
    return true;
  }
  if (Date.parse(row.expires_at) <= now) {
    await say(`That code has expired. Go back to ${where} for a new one.`, "expired");
    return true;
  }
  if (toWaId(row.phone) !== toWaId(args.waId)) {
    await supabase
      .from("lead_verifications")
      .update({ attempts: row.attempts + 1 })
      .eq("id", row.id);
    await say(
      `This code is for a different number. Please send it from the WhatsApp number you typed — or go back to ${where} and enter this number.`,
      "wrong_number",
    );
    return true;
  }

  // The one moment this code counts: a conditional update, so two copies of
  // the same message (Meta retries) can't both use it.
  const linkToken = randomToken();
  const { data: used } = await supabase
    .from("lead_verifications")
    .update({ used_at: new Date(now).toISOString(), link_token_hash: await sha256Hex(linkToken) })
    .eq("id", row.id)
    .is("used_at", null)
    .select("id");
  if (!used || (used as unknown[]).length === 0) {
    await say(`That code was already used. Go back to ${where} for a new one.`, "used");
    return true;
  }

  if (parsed.purpose === "verify") {
    let first = "";
    if (row.lead_id) {
      await supabase
        .from("demo_leads")
        .update({ verified_at: new Date(now).toISOString() })
        .eq("id", row.lead_id)
        .is("verified_at", null);
      const { data: lead } = await supabase
        .from("demo_leads")
        .select("name")
        .eq("id", row.lead_id)
        .maybeSingle();
      first = String((lead as { name?: string | null } | null)?.name ?? "").trim().split(/\s+/)[0] ?? "";
    }
    await say(
      `✅ Verified${first ? `, ${first}` : ""}! Your AiDwar trial is ready — tap to finish: ${APP_PUBLIC_URL}/start/continue?v=${linkToken}`,
      "verified",
    );
  } else {
    await say(
      `✅ Log-in confirmed. Your browser signs you in by itself — or, on another device, tap: ${APP_PUBLIC_URL}/login/whatsapp?t=${linkToken}`,
      "login_confirmed",
    );
  }
  return true;
}

/* ------------------------------------------------------- browser checks --- */

export type PollState =
  | { state: "none" }
  | { state: "waiting"; code: string; expiresAt: string }
  | { state: "expired" }
  | { state: "verified"; row: VerificationRow };

/** The newest code this browser holds (its nonce), and where it stands. */
export async function pollCode(
  supabase: SupabaseClient,
  input: { purpose: WaAuthPurpose; nonce: string; leadId?: string | null; now?: number },
): Promise<PollState> {
  const now = input.now ?? Date.now();
  let q = supabase
    .from("lead_verifications")
    .select(ROW)
    .eq("purpose", input.purpose)
    .eq("browser_nonce_hash", await sha256Hex(input.nonce));
  if (input.leadId) q = q.eq("lead_id", input.leadId);
  const { data } = await q.order("created_at", { ascending: false }).limit(1);
  const row = ((data ?? []) as VerificationRow[])[0];
  if (!row) return { state: "none" };
  if (row.used_at) return { state: "verified", row };
  if (Date.parse(row.expires_at) <= now || row.attempts >= MAX_CODE_ATTEMPTS) {
    return { state: "expired" };
  }
  return { state: "waiting", code: row.code, expiresAt: row.expires_at };
}

/**
 * The WhatsApp reply's link: valid once, for 15 minutes after the code was
 * used, and only while the result hasn't been taken. Rebinds the row to the
 * new browser's nonce so that browser can finish.
 */
export async function exchangeLink(
  supabase: SupabaseClient,
  input: { purpose: WaAuthPurpose; token: string; nonce: string; now?: number },
): Promise<VerificationRow | null> {
  const now = input.now ?? Date.now();
  if (!input.token || input.token.length < 16) return null;
  const { data } = await supabase
    .from("lead_verifications")
    .select(ROW)
    .eq("purpose", input.purpose)
    .eq("link_token_hash", await sha256Hex(input.token))
    .maybeSingle();
  const row = data as VerificationRow | null;
  if (!row || !row.used_at || row.claimed_at) return null;
  if (Date.parse(row.used_at) + LINK_TTL_MS <= now) return null;
  const nonceHash = await sha256Hex(input.nonce);
  const { data: moved } = await supabase
    .from("lead_verifications")
    .update({ browser_nonce_hash: nonceHash, link_token_hash: null })
    .eq("id", row.id)
    .eq("link_token_hash", await sha256Hex(input.token))
    .is("claimed_at", null)
    .select("id");
  if (!moved || (moved as unknown[]).length === 0) return null;
  return { ...row, browser_nonce_hash: nonceHash, link_token_hash: null };
}

/** Takes a verified result once (sign-up finish or log-in). */
export async function claimVerification(
  supabase: SupabaseClient,
  rowId: string,
  userId: string | null,
  now = Date.now(),
): Promise<boolean> {
  const { data } = await supabase
    .from("lead_verifications")
    .update({ claimed_at: new Date(now).toISOString(), ...(userId ? { user_id: userId } : {}) })
    .eq("id", rowId)
    .not("used_at", "is", null)
    .is("claimed_at", null)
    .select("id");
  return Boolean(data && (data as unknown[]).length > 0);
}

/* ------------------------------------------------------------- accounts --- */

type AdminUser = {
  id: string;
  email?: string | null;
  phone?: string | null;
  phone_confirmed_at?: string | null;
  app_metadata?: Record<string, unknown> | null;
  user_metadata?: Record<string, unknown> | null;
};

type AuthAdmin = {
  getUserById: (id: string) => Promise<{ data: { user: AdminUser | null }; error: unknown }>;
  createUser: (attrs: Record<string, unknown>) => Promise<{
    data: { user: AdminUser | null };
    error: { message?: string; status?: number } | null;
  }>;
  updateUserById: (
    id: string,
    attrs: Record<string, unknown>,
  ) => Promise<{ data: { user: AdminUser | null }; error: { message?: string } | null }>;
  generateLink: (params: Record<string, unknown>) => Promise<{
    data: { properties?: { hashed_token?: string } | null } | null;
    error: { message?: string } | null;
  }>;
};

function admin(supabase: SupabaseClient): AuthAdmin {
  return (supabase as unknown as { auth: { admin: AuthAdmin } }).auth.admin;
}

/** True when this auth user's WhatsApp number was proven (by us), never just typed. */
export function userHasVerifiedNumber(user: AdminUser | null, phone: string): boolean {
  if (!user) return false;
  const e164 = normalizePhone(phone);
  if (user.app_metadata?.["wa_verified_phone"] === e164) return true;
  return Boolean(user.phone && user.phone_confirmed_at && toWaId(user.phone) === toWaId(e164));
}

/**
 * Accounts this number may log into. Only numbers that were proven:
 * WhatsApp sign-ups (app_metadata.wa_verified_phone, or a confirmed auth
 * phone), and email accounts whose number was proven in the AD-code chat (an
 * onboarding session bound to that wa_id). A number someone only typed at
 * sign-up (profiles.phone) never logs anyone in.
 */
export async function findVerifiedAccounts(
  supabase: SupabaseClient,
  phone: string,
): Promise<string[]> {
  const e164 = normalizePhone(phone);
  const ids = new Set<string>();
  const { data: profiles } = await supabase.from("profiles").select("id").eq("phone", e164).limit(10);
  for (const p of (profiles ?? []) as Array<{ id: string }>) {
    const { data } = await admin(supabase).getUserById(p.id);
    if (userHasVerifiedNumber(data?.user ?? null, e164)) ids.add(p.id);
  }
  const { data: sessions } = await supabase
    .from("onboarding_sessions")
    .select("user_id, status")
    .eq("wa_id", toWaId(e164))
    .in("status", BOUND_STATUSES)
    .limit(10);
  for (const s of (sessions ?? []) as Array<{ user_id: string | null }>) {
    if (s.user_id) ids.add(s.user_id);
  }
  return [...ids];
}

/**
 * A browser session for this user: Supabase's single-use magic-link token
 * hash (generateLink sends no email). The caller hands it only to the
 * verified browser, which calls auth.verifyOtp({ token_hash, type: "email" }).
 */
export async function mintSessionToken(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data } = await admin(supabase).getUserById(userId);
  const user = data?.user ?? null;
  if (!user) return null;
  let email = user.email ?? null;
  if (!email) {
    // A phone-only account (created in the fallback below) gets its placeholder now.
    const phone = String(user.app_metadata?.["wa_verified_phone"] ?? user.phone ?? "");
    if (!phone) return null;
    email = placeholderEmail(phone);
    const { error } = await admin(supabase).updateUserById(userId, { email, email_confirm: true });
    if (error) return null;
    await supabase.from("profiles").update({ email, email_is_placeholder: true }).eq("id", userId);
  }
  const { data: link, error } = await admin(supabase).generateLink({ type: "magiclink", email });
  if (error) return null;
  return link?.properties?.hashed_token ?? null;
}

/**
 * The WhatsApp-only account: phone confirmed (we just proved it), the
 * placeholder email, and app_metadata.wa_verified_phone (server-only, so a
 * user can't set it). If Supabase refuses a phone on admin-created users
 * (Phone provider off), the account is made with the email only and the
 * proven number in app_metadata — logged, so it can be seen.
 */
export async function createWaUser(
  supabase: SupabaseClient,
  input: { phone: string; name: string | null },
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  const e164 = normalizePhone(input.phone);
  const base = {
    email: placeholderEmail(e164),
    email_confirm: true,
    user_metadata: {
      ...(input.name ? { full_name: input.name } : {}),
      phone: e164,
      signup_method: "whatsapp",
    },
    app_metadata: { wa_verified_phone: e164 },
  };
  let res = await admin(supabase).createUser({ ...base, phone: toWaId(e164), phone_confirm: true });
  if (res.error && /phone/i.test(res.error.message ?? "") && !/already/i.test(res.error.message ?? "")) {
    console.log(JSON.stringify({ scope: "wa_auth", stage: "phone_refused_fallback_email_only" }));
    res = await admin(supabase).createUser(base);
  }
  const user = res.data?.user ?? null;
  if (res.error || !user) {
    return { ok: false, error: "We couldn't create your account just now. Please try again." };
  }
  // handle_new_user copied email/phone/full_name; mark the email as a placeholder.
  await supabase
    .from("profiles")
    .update({
      email_is_placeholder: true,
      phone: e164,
      ...(input.name ? { full_name: input.name } : {}),
    })
    .eq("id", user.id);
  return { ok: true, userId: user.id };
}
