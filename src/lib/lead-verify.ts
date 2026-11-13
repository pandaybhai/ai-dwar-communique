/**
 * Batch 78: the pure half of /start's WhatsApp verification — safe for the
 * browser and the server. Taken from the parked Batch 74 work (its VERIFY
 * code only; no WhatsApp log-in, no email-less sign-up).
 *
 * The visitor proves the number is theirs by sending "VERIFY V-7K2P" from it
 * to AiDwar's own WhatsApp number (free: the customer writes first).
 */

/** "VERIFY V-7K2P", anywhere in a message (WhatsApp may add nothing, or a greeting). */
export const VERIFY_CODE_RE = /\bVERIFY\s+(V-[A-Z0-9]{4})\b/i;

/** The code a message carries, upper-cased, or null. */
export function readVerifyCode(body: string | null | undefined): string | null {
  const m = VERIFY_CODE_RE.exec(body ?? "");
  return m ? m[1]!.toUpperCase() : null;
}

/** 4 characters without look-alikes (no 0/O, 1/I/L): 31^4 ≈ 920k codes, each live 15 minutes. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newVerifyCode(random: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += ALPHABET[random[i]! % ALPHABET.length];
  return `V-${s}`;
}

/** What WhatsApp opens with, ready to send. */
export function verifyMessage(code: string): string {
  return `VERIFY ${code}`;
}

/** wa.me link to AiDwar's number with the message typed in. */
export function waMeLink(aidwarWaId: string, text: string): string {
  return `https://wa.me/${aidwarWaId.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

/** A code lives 15 minutes and is used once. */
export const CODE_TTL_MS = 15 * 60 * 1000;
/** Wrong-number tries against one code before it locks. */
export const MAX_CODE_ATTEMPTS = 5;
/** The page asks every 2 s while visible, for at most 15 minutes. */
export const POLL_MS = 2000;
export const POLL_FOR_MS = 15 * 60 * 1000;
/** "Having trouble? Continue without verifying" appears after a minute. */
export const SKIP_AFTER_MS = 60 * 1000;

export type VerifyState = "none" | "waiting" | "verified" | "expired";
