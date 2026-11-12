import { DEFAULT_COUNTRY_CODE, typedPhone } from "@/lib/phone";

/**
 * Batch 74: the pure half of the WhatsApp-only sign-up and log-in — safe for
 * the browser and the server. The code people send from their WhatsApp, the
 * /start qualification chips, the fake-number rules and the placeholder email
 * a WhatsApp-only account carries.
 */

/** "VERIFY V-7K2P" (sign-up) or "LOGIN L-4QX9" (log-in), anywhere in a message. */
export const WA_AUTH_CODE_RE = /\b(VERIFY|LOGIN)\s+([VL]-[A-Z0-9]{4})\b/i;

export type WaAuthPurpose = "verify" | "login";

/** The code a message carries, normalised, or null. The keyword must match the code's letter. */
export function readWaAuthCode(body: string): { purpose: WaAuthPurpose; code: string } | null {
  const m = WA_AUTH_CODE_RE.exec(body ?? "");
  if (!m) return null;
  const keyword = m[1]!.toUpperCase();
  const code = m[2]!.toUpperCase();
  if (keyword === "VERIFY" && code.startsWith("V-")) return { purpose: "verify", code };
  if (keyword === "LOGIN" && code.startsWith("L-")) return { purpose: "login", code };
  return null;
}

/** 4 characters without look-alikes (no 0/O, 1/I/L): 32^4 ≈ 1M codes, live 15 minutes each. */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function newWaAuthCode(purpose: WaAuthPurpose, random: Uint8Array): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += ALPHABET[random[i]! % ALPHABET.length];
  return `${purpose === "verify" ? "V" : "L"}-${s}`;
}

/** What WhatsApp opens with, ready to send. */
export function waAuthMessage(purpose: WaAuthPurpose, code: string): string {
  return `${purpose === "verify" ? "VERIFY" : "LOGIN"} ${code}`;
}

export function waMeLink(onboardingWaId: string, text: string): string {
  return `https://wa.me/${onboardingWaId.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

export const CODE_TTL_MS = 15 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;

/* ------------------------------------------------------- qualification --- */

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

/**
 * The two taps → demo_leads.qualification, and business_type where the
 * existing values (retail / services / education / healthcare / realestate /
 * other) fit; "Food & café" stays in qualification only.
 */
export function qualificationFor(
  sells: unknown,
  customers: unknown,
): { ok: true; qualification: { sells: Sells; customers: Customers }; businessType: string | null } | { ok: false } {
  const s = SELLS.find((o) => o.value === sells);
  const c = CUSTOMERS.find((o) => o.value === customers);
  if (!s || !c) return { ok: false };
  return { ok: true, qualification: { sells: s.value, customers: c.value }, businessType: s.businessType };
}

export function labelOf(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: unknown,
): string | null {
  return options.find((o) => o.value === value)?.label ?? null;
}

/* --------------------------------------------------------- fake numbers --- */

/**
 * A number for /start or /login: Batch 66's rule (a 10-digit number gets
 * +91; a leading 0 — an STD landline like 040… — is refused), then the
 * obviously fake ones: one digit repeated, a straight run (1234567890,
 * 9876543210…), and for India anything that isn't a mobile (6–9 first).
 */
export function checkWaNumber(typed: unknown): { ok: true; phone: string } | { ok: false; error: string } {
  const t = typedPhone(typed, DEFAULT_COUNTRY_CODE);
  if ("error" in t) return { ok: false, error: t.error };
  const digits = t.phone.replace(/\D/g, "");
  const national = digits.startsWith("91") && digits.length === 12 ? digits.slice(2) : digits;
  const fake = "That doesn't look like a real WhatsApp number. Please check it.";
  if (/^(\d)\1+$/.test(national)) return { ok: false, error: fake };
  if (isRun(national)) return { ok: false, error: fake };
  if (digits.startsWith("91")) {
    if (digits.length !== 12) return { ok: false, error: "Indian mobile numbers have 10 digits." };
    if (!/^[6-9]/.test(national)) {
      return { ok: false, error: "Please use your WhatsApp mobile number (it starts with 6, 7, 8 or 9)." };
    }
  }
  return { ok: true, phone: t.phone };
}

/** 8 or more digits counting straight up or down (…567890 wraps to 0). */
function isRun(n: string): boolean {
  if (n.length < 8) return false;
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

/* ---------------------------------------------------- placeholder email --- */

/**
 * Supabase hands a server-made session to the browser only through an
 * email-based token, so a WhatsApp-only account carries this address. It
 * receives no mail (users.aidwar.in has no inbox) and nothing may send to it.
 */
export const PLACEHOLDER_EMAIL_DOMAIN = "users.aidwar.in";

export function placeholderEmail(phone: string): string {
  return `wa+${phone.replace(/\D/g, "")}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

export function isPlaceholderEmail(email: unknown): boolean {
  return (
    typeof email === "string" &&
    email.trim().toLowerCase().endsWith(`@${PLACEHOLDER_EMAIL_DOMAIN}`)
  );
}

/** An email fit to show or send to: never the placeholder. */
export function realEmail(email: unknown): string | null {
  if (typeof email !== "string" || !email.trim() || isPlaceholderEmail(email)) return null;
  return email.trim();
}
