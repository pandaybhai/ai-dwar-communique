/**
 * Single source of truth for phone formatting.
 * `normalizePhone` returns E.164 with a leading `+` (digits only otherwise).
 * `toWaId` returns the digits-only form Meta expects in API calls / wa_id.
 */
export function normalizePhone(input: string | null | undefined): string {
  const digits = String(input ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

export function toWaId(input: string | null | undefined): string {
  return String(input ?? "").replace(/\D/g, "");
}

/** Batch 66: the default country code when a workspace has none stored (the column's own default). */
export const DEFAULT_COUNTRY_CODE = "91";

/** A calling code a workspace may store: E.164's 1–4 digits, without "+" (organizations.default_country_code). */
export function isCountryCode(code: unknown): code is string {
  return typeof code === "string" && /^[1-9][0-9]{0,3}$/.test(code);
}

/** Why an entered number can't be used (see enteredPhone). */
export type PhoneProblem =
  | "empty"
  | "too_short"
  | "too_long"
  | "leading_zero"
  /** A number without its country code, and no default code was given to add. */
  | "needs_country";

export type EnteredPhone =
  | {
      ok: true;
      /** E.164: "+919908109123". */
      phone: string;
      /** The workspace's default country code was added (a 10-digit number, or 0 + 10 digits). */
      addedCountry: boolean;
    }
  | { ok: false; problem: PhoneProblem };

/**
 * Batch 66: the one rule for a phone number a person types or an integrator
 * sends — the contact import, Add contact, the Settings default copy numbers
 * and every Public API phone (to, cc, contacts, /contacts/{phone},
 * /conversations/{phone}, audience.phones, ?to=, the Try-it price). Never the
 * inbound or status webhooks: Meta's wa_id always has its country code, and
 * they keep normalizePhone.
 *
 * Spaces, dashes, brackets and dots are stripped.
 *  - "+" then 8–15 digits: as before.
 *  - "00" then 8–15 digits: the international prefix, dropped.
 *  - digits only, exactly 10 (not starting with 0): the default country code is added.
 *  - digits only, 11 starting with 0 (a trunk 0, "09908109123"): the 0 is dropped and the default code added.
 *  - digits only, 11–15 not starting with 0: already has its country code, as before.
 *  - anything else: refused, with the problem.
 * For every number that already had its country code the result is exactly
 * normalizePhone's, so lookups, idempotency fingerprints and copy keys don't move.
 * `defaultCountryCode` null: a number that needs it answers "needs_country"
 * (callers read the workspace's code only then).
 */
export function enteredPhone(raw: unknown, defaultCountryCode: string | null): EnteredPhone {
  if (typeof raw !== "string" && typeof raw !== "number") return { ok: false, problem: "empty" };
  const text = String(raw).trim();
  let digits = toWaId(text);
  if (!digits) return { ok: false, problem: "empty" };
  const lead = text.replace(/^[\s().-]+/, "");
  const sized = (d: string): EnteredPhone =>
    d.length < 8
      ? { ok: false, problem: "too_short" }
      : d.length > 15
        ? { ok: false, problem: "too_long" }
        : { ok: true, phone: `+${d}`, addedCountry: false };
  if (lead.startsWith("+")) return sized(digits);
  if (lead.startsWith("00")) return sized(digits.slice(2));
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  else if (digits.length >= 11) {
    if (digits.startsWith("0")) return { ok: false, problem: "leading_zero" };
    return sized(digits);
  }
  if (digits.length < 10) return { ok: false, problem: "too_short" };
  if (digits.startsWith("0")) return { ok: false, problem: "leading_zero" };
  // Exactly 10 digits, without their country code.
  if (!defaultCountryCode) return { ok: false, problem: "needs_country" };
  if (!isCountryCode(defaultCountryCode)) return { ok: false, problem: "needs_country" };
  const full = defaultCountryCode + digits;
  if (full.length > 15) return { ok: false, problem: "too_long" };
  return { ok: true, phone: `+${full}`, addedCountry: true };
}

/** One plain sentence for a refused number (the import's skip reason, the API's error). */
export function phoneProblemText(problem: PhoneProblem): string {
  switch (problem) {
    case "empty":
      return "No phone number";
    case "too_short":
      return "Too short: needs 10 digits, or + and the country code";
    case "too_long":
      return "Too long: more than 15 digits";
    case "leading_zero":
      return "Starts with 0: write it with + and the country code";
    case "needs_country":
      return "No country code";
  }
}
