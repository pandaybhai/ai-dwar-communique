import { normalizePhone, toWaId } from "@/lib/phone";

/**
 * Batch 61: copies ("cc") of an API template send — the same template, values,
 * file and buttons sent to up to MAX_CC (10) more numbers (a shop's own staff), each as
 * its own WhatsApp message. Pure: the API request (`cc`), the workspace
 * default (Settings → API & webhooks, organizations.api_cc_numbers) and the
 * settings screen all check numbers here, the same way `to` is checked
 * (normalizePhone / toWaId, 8–15 digits with the country code).
 */

/** Batch 62: 10 (was 3), e.g. a shop's 7 staff numbers. 20261340's CHECK says the same. */
export const MAX_CC = 10;

export type CcNumbers = { ok: true; numbers: string[] } | { ok: false; error: string };

/** One number, as `to` is checked. The E.164 form ("+919812345678"), else null. */
export function ccNumber(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const text = String(raw).trim();
  if (!text) return null;
  const digits = toWaId(text);
  if (digits.length < 8 || digits.length > 15) return null;
  return normalizePhone(digits);
}

/**
 * A list of copy numbers: an array of at most MAX_CC numbers with country
 * code. Duplicates and the main `to` number are removed (so a list may come
 * back shorter, or empty). `label(i)` names an entry in an error.
 */
export function parseCcNumbers(
  raw: unknown,
  options: { to?: string | null; label?: (index: number) => string; field?: string } = {},
): CcNumbers {
  const field = options.field ?? "`cc`";
  const label = options.label ?? ((i: number) => `cc[${i}]`);
  if (!Array.isArray(raw))
    return { ok: false, error: `${field} must be an array of WhatsApp numbers with country code.` };
  if (raw.length > MAX_CC)
    return { ok: false, error: `${field} takes at most ${MAX_CC} numbers; it has ${raw.length}.` };
  const mainDigits = options.to ? toWaId(options.to) : "";
  const out: string[] = [];
  for (const [i, entry] of raw.entries()) {
    const number = ccNumber(entry);
    if (!number)
      return {
        ok: false,
        error: `${label(i)} isn't a valid WhatsApp number. Include the country code, e.g. +919812345678.`,
      };
    const digits = toWaId(number);
    if (digits === mainDigits) continue;
    if (out.some((n) => toWaId(n) === digits)) continue;
    out.push(number);
  }
  return { ok: true, numbers: out };
}

/** A copy's own idempotency key, derived from the request's: `<key>:cc:<E.164>`. */
export function copyIdempotencyKey(key: string, number: string): string {
  return `${key}:cc:${number}`;
}

/**
 * Batch 62: the Settings card's per-invoice cost note for `copies` numbers.
 * Words only: what is charged is unchanged (each copy is its own message).
 */
export function copyCostNote(copies: number): string {
  const n = Math.max(0, Math.floor(copies));
  const count =
    n === 0
      ? "1 WhatsApp message (the customer's), no copies."
      : `${n + 1} WhatsApp messages: the customer's and ${n} ${n === 1 ? "copy" : "copies"}.`;
  return `${count} Each copy is a separate WhatsApp message charged by Meta at the template's category rate (utility, marketing or authentication); international numbers cost more.`;
}

/** The stored default, read leniently: only valid numbers, at most MAX_CC, no duplicates. */
export function storedCcNumbers(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const number = ccNumber(entry);
    if (number && !out.includes(number)) out.push(number);
    if (out.length >= MAX_CC) break;
  }
  return out;
}

/** One copy in the API's answer. */
export type CopyResult = {
  to: string;
  message_id: string | null;
  /** queued = WhatsApp accepted it; failed = WhatsApp refused it; not_sent = refused before sending. */
  status: "queued" | "failed" | "not_sent";
  code?: string;
  error?: string;
};
