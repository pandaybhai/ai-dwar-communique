import { DEFAULT_COUNTRY_CODE, typedPhone } from "@/lib/phone";

/**
 * Batch 75: the /start qualification step (two taps after name + number) and
 * the fake-number rule for the /start forms. Pure: the browser and the
 * server use the same lists and the same rule.
 */

export const SELLS = [
  { value: "jewellery", label: "Jewellery", businessType: "retail" },
  { value: "fashion", label: "Fashion", businessType: "retail" },
  { value: "food_cafe", label: "Food & café", businessType: null },
  { value: "online_store", label: "Online store", businessType: "retail" },
  { value: "clinic_salon", label: "Clinic & salon", businessType: "services" },
  { value: "education", label: "Education", businessType: "education" },
  { value: "other", label: "Other", businessType: "other" },
] as const;

export const CUSTOMERS = [
  { value: "under_500", label: "Under 500" },
  { value: "500_5000", label: "500–5,000" },
  { value: "5000_plus", label: "5,000+" },
] as const;

export type Sells = (typeof SELLS)[number]["value"];
export type Customers = (typeof CUSTOMERS)[number]["value"];

export type StartQualification = { sells: Sells; customers: Customers; answered_at: string };

/**
 * The two answers → demo_leads.qualification, plus business_type when the
 * answer fits the column's existing values (retail / services / education /
 * other — the /demo form's list); "Food & café" fits none and stays in
 * qualification only.
 */
export function qualificationFor(
  sells: unknown,
  customers: unknown,
  now: Date = new Date(),
): { ok: true; qualification: StartQualification; businessType: string | null } | { ok: false } {
  const s = SELLS.find((o) => o.value === sells);
  const c = CUSTOMERS.find((o) => o.value === customers);
  if (!s || !c) return { ok: false };
  return {
    ok: true,
    qualification: { sells: s.value, customers: c.value, answered_at: now.toISOString() },
    businessType: s.businessType,
  };
}

export function sellsLabel(value: unknown): string | null {
  return SELLS.find((o) => o.value === value)?.label ?? null;
}

export function customersLabel(value: unknown): string | null {
  return CUSTOMERS.find((o) => o.value === value)?.label ?? null;
}

/** The one line every rejected /start number gets. */
export const REAL_NUMBER_ERROR = "Please enter your real WhatsApp number";

/**
 * A /start number: Batch 66's rule first (a 10-digit number gets +91), then
 * the obviously fake ones — one digit repeated (9999999999), a straight run
 * up or down (1234567890, 0123456789, 9876543210), and an Indian number that
 * isn't exactly 10 digits.
 */
export function checkRealNumber(
  typed: unknown,
): { ok: true; phone: string } | { ok: false; error: string } {
  const t = typedPhone(typed, DEFAULT_COUNTRY_CODE);
  // A badly written number keeps Batch 66's sentence (how to write it).
  if ("error" in t) return { ok: false, error: t.error };
  const digits = t.phone.replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length !== 12) {
    return { ok: false, error: REAL_NUMBER_ERROR };
  }
  const national = digits.startsWith("91") ? digits.slice(2) : digits;
  if (/^(\d)\1+$/.test(national) || isStraightRun(national)) {
    return { ok: false, error: REAL_NUMBER_ERROR };
  }
  return { ok: true, phone: t.phone };
}

/** Every digit one more (or one less) than the last, wrapping 9→0 / 0→9. */
export function isStraightRun(n: string): boolean {
  if (n.length < 7) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < n.length; i++) {
    const a = Number(n[i - 1]);
    const b = Number(n[i]);
    if ((a + 1) % 10 !== b) up = false;
    if ((a + 9) % 10 !== b) down = false;
  }
  return up || down;
}
