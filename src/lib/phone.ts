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

/** Batch 66's sentence when a typed number is refused (Add contact's wording). */
export const ENTER_WITH_COUNTRY = "Enter it with the country code, e.g. +91 98765 43210.";

/**
 * Batch 69: a number a person types into a form that stores it — the one rule
 * (enteredPhone) with the workspace's default country code, or Batch 66's
 * sentence for why not. Add contact, the billing WhatsApp (Super Admin and
 * the customer's own), staff alert numbers, the onboarding and sign-up
 * number all answer the same way.
 */
export function typedPhone(
  typed: unknown,
  defaultCountryCode: string | null,
  codeError: string | null = null,
): { phone: string; addedCountry: boolean } | { error: string } {
  const entered = enteredPhone(typed, defaultCountryCode);
  if (entered.ok) return { phone: entered.phone, addedCountry: entered.addedCountry };
  if (entered.problem === "needs_country")
    return { error: codeError ?? "Add the country code, e.g. +91 98765 43210." };
  return { error: `${phoneProblemText(entered.problem)}. ${ENTER_WITH_COUNTRY}` };
}

/** Batch 78: the one line for a typed Indian WhatsApp number we can't use. */
export const INDIA_MOBILE_ERROR = "Please enter your 10-digit WhatsApp number";

/**
 * Batch 78: a person's own WhatsApp number typed into one of our forms
 * (/start with its +91 chip, /signup, and the Settings numbers of an Indian
 * workspace). Live leads came in as +1 917002867193 and +7 3078015438:
 * enteredPhone reads 11–15 digits typed without "+" as already carrying a
 * country code, so "73078015438" (a slip) became +7… and "1917002867193"
 * became +1…, although the field shows +91. Here a number typed without "+"
 * is always Indian:
 *  - 10 digits → +91 + those 10;
 *  - 0 + 10 digits → +91 + the 10;
 *  - 91 + 10 digits (12) → +91 + the 10;
 *  - anything else → refused (never a guessed country);
 * and an Indian mobile is exactly 10 digits starting 6–9 (no landline, no
 * 5-digit stub). "+91 …" / "0091 …" follow the same national rule. A number
 * written with "+" and another country code is refused unless `foreign`
 * (Settings, where a foreign number is typed on purpose), then Batch 66's
 * rule as before.
 */
export function indiaWhatsApp(
  typed: unknown,
  opts: { foreign?: boolean } = {},
): { phone: string } | { error: string } {
  if (typeof typed !== "string" && typeof typed !== "number") return { error: INDIA_MOBILE_ERROR };
  const text = String(typed).trim();
  const explicit = /^[\s().-]*(\+|00)/.test(text);
  let digits = toWaId(text);
  if (!digits) return { error: INDIA_MOBILE_ERROR };
  if (explicit && /^[\s().-]*00/.test(text)) digits = digits.slice(2);
  let national: string;
  if (explicit) {
    if (!digits.startsWith("91")) {
      if (!opts.foreign) return { error: INDIA_MOBILE_ERROR };
      const t = typedPhone(text, null);
      return "error" in t ? t : { phone: t.phone };
    }
    national = digits.slice(2);
  } else if (digits.length === 12 && digits.startsWith("91")) {
    national = digits.slice(2);
  } else {
    national = digits;
  }
  if (national.length === 11 && national.startsWith("0")) national = national.slice(1);
  if (!/^[6-9]\d{9}$/.test(national)) return { error: INDIA_MOBILE_ERROR };
  return { phone: `+91${national}` };
}

/**
 * Batch 78: typedPhone for a person's own number in an Indian workspace's
 * form (staff alert numbers, the onboarding number, the billing WhatsApp):
 * India's code (or a typed "+91…") goes through indiaWhatsApp, so a slip is
 * refused instead of becoming a foreign number; any other code is Batch 69's
 * rule unchanged.
 */
export function typedPersonPhone(
  typed: unknown,
  defaultCountryCode: string | null,
  codeError: string | null = null,
): { phone: string; addedCountry: boolean } | { error: string } {
  const text = typeof typed === "string" || typeof typed === "number" ? String(typed).trim() : "";
  const explicit = /^[\s().-]*(\+|00)/.test(text);
  let digits = toWaId(text);
  if (explicit && /^[\s().-]*00/.test(text)) digits = digits.slice(2);
  if ((explicit && digits.startsWith("91")) || (!explicit && defaultCountryCode === "91")) {
    const out = indiaWhatsApp(text, { foreign: true });
    return "error" in out ? out : { phone: out.phone, addedCountry: !explicit };
  }
  return typedPhone(typed, defaultCountryCode, codeError);
}

/** "+919812345670" → "+91 98123 45670" for people to read; any other number as stored. */
export function displayPhone(phone: string): string {
  const m = /^\+91(\d{5})(\d{5})$/.exec(phone.replace(/[\s()-]/g, ""));
  return m ? `+91 ${m[1]} ${m[2]}` : phone;
}
