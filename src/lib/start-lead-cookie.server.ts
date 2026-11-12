/**
 * Batch 75: the /start lead this browser just created, as an httpOnly cookie
 * signed with a key derived (HKDF, label "aidwar-start-lead") from the
 * server-only AIDWAR_SUPABASE_SERVICE_ROLE_KEY — no new secret. The
 * qualification step reads the lead id only from here, never from the
 * request body, so a browser can answer for its own lead and no other.
 */

export const START_LEAD_COOKIE = "aidwar_start_lead";
/** One hour: long enough to tap two answers, short enough to not linger. */
export const START_LEAD_TTL_S = 60 * 60;
const LABEL = "aidwar-start-lead";

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function key(): Promise<CryptoKey> {
  const secret = process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!secret) throw new Error("Missing AiDwar backend service configuration.");
  let k = keyCache.get(secret);
  if (!k) {
    k = (async () => {
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
    keyCache.set(secret, k);
  }
  return k;
}

async function sig(payload: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", await key(), enc.encode(payload)));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 32);
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** "<lead id>.<expiry, base36 seconds>.<signature>" */
export async function startLeadToken(leadId: string, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000 + START_LEAD_TTL_S).toString(36);
  return `${leadId}.${exp}.${await sig(`${leadId}|${exp}`)}`;
}

/** The lead id when the token is ours and unexpired, else null. */
export async function readStartLeadToken(
  token: string | null | undefined,
  now = Date.now(),
): Promise<string | null> {
  const [leadId, exp, s] = String(token ?? "").split(".");
  if (!leadId || !exp || !s) return null;
  if (!/^[A-Za-z0-9-]{1,64}$/.test(leadId)) return null;
  if (!same(s, await sig(`${leadId}|${exp}`))) return null;
  if (parseInt(exp, 36) * 1000 <= now) return null;
  return leadId;
}

export async function startLeadSetCookie(leadId: string, now = Date.now()): Promise<string> {
  return `${START_LEAD_COOKIE}=${await startLeadToken(leadId, now)}; Path=/api/public; HttpOnly; Secure; SameSite=Lax; Max-Age=${START_LEAD_TTL_S}`;
}

export function startLeadFromRequest(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === START_LEAD_COOKIE) return v.join("=");
  }
  return null;
}
