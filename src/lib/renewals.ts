/**
 * Batch 82: the access period's words and rules (organizations.
 * plan_period_ends_at). Pure: the app banner, Admin's Renewals list and the
 * tests read the same rules.
 */

const DAY_MS = 864e5;

/** "+919812345670" → "…5670" — the Renewals list never shows a whole number. */
export function phoneLast4(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `…${digits.slice(-4)}` : "—";
}

/** "Asha Rao" → "Asha". */
export function ownerFirstName(name: string | null | undefined): string {
  return (
    String(name ?? "")
      .trim()
      .split(/\s+/)[0] || "—"
  );
}

/** "19 Dec 2026" (India). */
export function periodDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
}

/** Whole days left, rounded up (0 = ends today, negative = ended). */
export function daysLeft(endsAt: string, now: number = Date.now()): number {
  return Math.ceil((Date.parse(endsAt) - now) / DAY_MS);
}

export const BANNER_DAYS = 5;

/**
 * The in-app banner for a /199 paid trial: shown when 5 days or fewer are
 * left (and after the end — nothing is locked), never at 6. No automatic
 * charge: "Talk to us" opens WhatsApp with our team.
 */
export function accessBanner(
  endsAt: string | null | undefined,
  now: number = Date.now(),
): { text: string } | null {
  if (!endsAt || !Number.isFinite(Date.parse(endsAt))) return null;
  const left = daysLeft(endsAt, now);
  if (left > BANNER_DAYS) return null;
  const date = periodDate(endsAt);
  return {
    text:
      Date.parse(endsAt) <= now
        ? `Your AiDwar access ended on ${date} — our team will call you, or choose a plan`
        : `Your AiDwar access ends on ${date} — our team will call you, or choose a plan`,
  };
}

export type RenewalRow = {
  organization_id: string;
  name: string;
  owner_first_name: string;
  phone_last4: string;
  plan_period_ends_at: string;
  last_amount: number | null;
  offer: string | null;
};

/** Soonest end first. Pure. */
export function sortRenewals(rows: RenewalRow[]): RenewalRow[] {
  return [...rows].sort(
    (a, b) => Date.parse(a.plan_period_ends_at) - Date.parse(b.plan_period_ends_at),
  );
}
