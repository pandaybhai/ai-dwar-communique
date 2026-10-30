/**
 * Batch 52: the confirm_code an AI assistant must hand back before AiDwar
 * sends a campaign or switches a flow on.
 *
 * A code is HMAC-signed and bound to (user, workspace, object, action, a hash
 * of the draft's state) and expires 15 minutes after it was issued. The key
 * is derived with HKDF from the server-only AIDWAR_SUPABASE_SERVICE_ROLE_KEY
 * and the fixed label "aidwar-mcp-confirm" — no new secret, and the derived
 * key can't be used for anything else.
 *
 * Format: `<expiry, base36 seconds>.<first 16 hex of the state hash>.<mac>`.
 * The state hash travels in the code (it is signed), so a code whose draft
 * changed after it was issued is told apart from a code that was edited.
 * "Works once" is the caller's job: the object leaves its draft state when
 * the code is used, and a code for a non-draft is refused.
 */

export const CONFIRM_TTL_MS = 15 * 60 * 1000;
export const CONFIRM_LABEL = "aidwar-mcp-confirm";

export type ConfirmAction =
  | "send_campaign"
  | "activate_flow"
  // Batch 54
  | "submit_template"
  | "update_campaign"
  | "cancel_campaign"
  | "tag_contacts"
  | "answer_question";

export type ConfirmBinding = {
  userId: string;
  workspaceId: string;
  objectId: string;
  action: ConfirmAction;
  /** sha256 hex of the draft's canonical state (stateHash). */
  stateHash: string;
};

export type ConfirmCheck =
  | { ok: true }
  | { ok: false; reason: "malformed" | "tampered" | "expired" | "changed" };

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function rootSecret(): string {
  const secret = process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  if (!secret) throw new Error("Missing AiDwar backend service configuration.");
  return secret;
}

function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = (async () => {
      const ikm = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: enc.encode(CONFIRM_LABEL) },
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

function base64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** JSON with object keys sorted, so the same state always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** sha256 hex of a draft's state (audience + template + schedule, or a flow graph). */
export async function stateHash(state: unknown): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(canonicalJson(state))));
}

async function mac(binding: ConfirmBinding, hashPrefix: string, exp: number, secret: string) {
  const payload = [
    "v1",
    binding.userId,
    binding.workspaceId,
    binding.objectId,
    binding.action,
    hashPrefix,
    String(exp),
  ].join("|");
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(payload));
  return base64url(sig).slice(0, 32);
}

export async function issueConfirmCode(
  binding: ConfirmBinding,
  now = Date.now(),
  secret = rootSecret(),
): Promise<{ code: string; expiresAt: string }> {
  const exp = Math.floor((now + CONFIRM_TTL_MS) / 1000);
  const prefix = binding.stateHash.slice(0, 16);
  const code = `${exp.toString(36)}.${prefix}.${await mac(binding, prefix, exp, secret)}`;
  return { code, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * Checks a code against the object as it is now. Order matters: a code that
 * isn't ours (or was edited) is "tampered" before anything else is said
 * about it; then its age; then whether the draft still matches.
 */
export async function verifyConfirmCode(
  code: unknown,
  binding: ConfirmBinding,
  now = Date.now(),
  secret = rootSecret(),
): Promise<ConfirmCheck> {
  if (typeof code !== "string") return { ok: false, reason: "malformed" };
  const m = /^([0-9a-z]{1,12})\.([0-9a-f]{16})\.([A-Za-z0-9_-]{32})$/.exec(code.trim());
  if (!m) return { ok: false, reason: "malformed" };
  const exp = parseInt(m[1]!, 36);
  const prefix = m[2]!;
  const expected = await mac(binding, prefix, exp, secret);
  if (!sameString(expected, m[3]!)) return { ok: false, reason: "tampered" };
  if (exp * 1000 <= now) return { ok: false, reason: "expired" };
  if (!sameString(prefix, binding.stateHash.slice(0, 16))) return { ok: false, reason: "changed" };
  return { ok: true };
}

export const CONFIRM_REFUSALS: Record<Exclude<ConfirmCheck, { ok: true }>["reason"], string> = {
  malformed: "That confirm_code isn't one AiDwar gave. Use the exact code from the draft.",
  tampered:
    "That confirm_code doesn't belong to this draft, this workspace or this user. Use the code returned with this draft.",
  expired:
    "That confirm_code has expired (codes last 15 minutes). Create the draft again to get a new code, and ask the user to confirm again.",
  changed:
    "This draft changed after the confirm_code was issued. Show the user the new details and create a fresh draft before sending.",
};

/** Batch 54: the same refusals for a code that came from a preview (not a saved draft). */
export const PREVIEW_REFUSALS: Record<Exclude<ConfirmCheck, { ok: true }>["reason"], string> = {
  malformed: "That confirm_code isn't one AiDwar gave. Use the exact code from the preview.",
  tampered:
    "That confirm_code doesn't belong to this change, this workspace or this user. Use the code returned with this preview.",
  expired:
    "That confirm_code has expired (codes last 15 minutes). Run the preview again to get a new code, and ask the user to confirm again.",
  changed:
    "Something changed after the confirm_code was issued (the request or what it applies to). Run the preview again, show the user the new details and ask them to confirm.",
};
