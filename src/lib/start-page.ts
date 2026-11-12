import { DEFAULT_COUNTRY_CODE, typedPhone } from "@/lib/phone";

/**
 * Batch 72: the /start ad landing page's logic, pure so it can be tested
 * without a browser: the pricing sentence (from the public plans, never a
 * hard-coded price), when the sticky bar shows, and the form's own check.
 */

export type StartPlan = { price_monthly: number | null; currency?: string };

/** "₹2,499" for whole rupees, "₹2,499.50" otherwise. */
export function rupees(amount: number): string {
  const whole = Math.round(amount * 100) % 100 === 0;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: whole ? 0 : 2,
    minimumFractionDigits: whole ? 0 : 2,
  }).format(amount);
}

/** The lowest monthly price among the public paid plans (INR), or null. */
export function lowestPaidPrice(plans: StartPlan[]): number | null {
  const prices = plans
    .filter((p) => (p.currency ?? "INR") === "INR")
    .map((p) => Number(p.price_monthly ?? 0))
    .filter((n) => Number.isFinite(n) && n > 0);
  return prices.length ? Math.min(...prices) : null;
}

/**
 * "Start free. Plans from ₹X/month. Pay for WhatsApp messages only when you
 * send." — ₹X is the lowest public paid plan; "+ GST" only while AiDwar
 * charges GST (Batch 55); no price at all when the plans can't be read.
 */
export function pricingTeaser(plans: StartPlan[], gstRegistered = false): string {
  const low = lowestPaidPrice(plans);
  const from =
    low === null ? "" : ` Plans from ${rupees(low)}/month${gstRegistered ? " + GST" : ""}.`;
  return `Start free.${from} Pay for WhatsApp messages only when you send.`;
}

/**
 * The sticky bar shows once the hero form has scrolled up out of view, and
 * hides again whenever the hero form or the final form is on screen.
 */
export function stickyBarVisible(input: {
  heroFormVisible: boolean;
  heroFormAbove: boolean;
  finalFormVisible: boolean;
}): boolean {
  return input.heroFormAbove && !input.heroFormVisible && !input.finalFormVisible;
}

/** The form's own check (the server checks again): Batch 66's rule, +91 by default. */
export function checkStartForm(input: {
  name?: string;
  phone: string;
}):
  | { ok: true; name: string; phone: string }
  | { ok: false; field: "name" | "phone"; error: string } {
  const name = (input.name ?? "").trim().replace(/\s+/g, " ");
  if (name && name.length < 2)
    return { ok: false, field: "name", error: "Please enter your name." };
  const typed = typedPhone(input.phone, DEFAULT_COUNTRY_CODE);
  if ("error" in typed) return { ok: false, field: "phone", error: typed.error };
  return { ok: true, name, phone: typed.phone };
}

/** The non-personal search params carried to /signup (campaign tags only — never the number or name). */
export function signupSearchFrom(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const key of ["plan", "utm_source", "utm_medium", "utm_campaign", "ref"]) {
    const v = params.get(key);
    if (v && v.trim()) out[key] = v.trim().slice(0, 120);
  }
  return out;
}

export type BarState = {
  heroFormVisible: boolean;
  heroFormAbove: boolean;
  finalFormVisible: boolean;
};
type ObserverEntry = {
  target: unknown;
  isIntersecting: boolean;
  boundingClientRect: { top: number };
};

/** The sticky bar's state after IntersectionObserver entries for the hero and final forms. */
export function nextBarState(
  prev: BarState,
  entries: ObserverEntry[],
  heroForm: unknown,
  finalForm: unknown,
): BarState {
  const next = { ...prev };
  for (const e of entries) {
    if (e.target === heroForm) {
      next.heroFormVisible = e.isIntersecting;
      next.heroFormAbove = !e.isIntersecting && e.boundingClientRect.top < 0;
    } else if (e.target === finalForm) {
      next.finalFormVisible = e.isIntersecting;
    }
  }
  return next;
}
