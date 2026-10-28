import type { SupabaseClient } from "@supabase/supabase-js";
import type { MessageCategory } from "@/lib/billing";

export type TemplatePriceQuote = {
  /** False when billing is off for the workspace: nothing is charged, nothing is refused. */
  enabled: boolean;
  category: MessageCategory;
  currency: string;
  /** What each number costs (its country's client rate for this category). */
  perNumber: Array<{ phone: string; rate: number }>;
  total: number;
  available: number;
  covers: boolean;
};

const CATEGORIES: MessageCategory[] = ["marketing", "utility", "authentication", "service"];

/** A stored template category (MARKETING, Utility…) as the billing category it is charged at. */
export function billingCategoryOf(raw: string | null | undefined): MessageCategory {
  const c = String(raw ?? "").toLowerCase();
  return (CATEGORIES as string[]).includes(c) ? (c as MessageCategory) : "marketing";
}

/**
 * Batch 35: what sending one template message to each of these numbers costs,
 * before anything is sent. The same rates the debit itself charges
 * (client_rate_for by the phone's country, found from the rate card's dial
 * codes like the Public API does) and the same wallet sum a hold checks.
 * Charging still happens only through the existing messages billing trigger.
 */
export async function quoteTemplateMessages(
  supabase: SupabaseClient,
  organizationId: string,
  category: MessageCategory,
  phones: string[],
): Promise<TemplatePriceQuote> {
  const { billingEnabled, rateFor, creditsCover } = await import("@/lib/billing.server");
  const enabled = await billingEnabled(supabase, organizationId);
  if (!enabled) {
    return {
      enabled: false,
      category,
      currency: "INR",
      perNumber: phones.map((phone) => ({ phone, rate: 0 })),
      total: 0,
      available: 0,
      covers: true,
    };
  }
  const { countryForPhone } = await import("@/lib/public-api-send.server");
  const perNumber: Array<{ phone: string; rate: number }> = [];
  let currency = "INR";
  for (const phone of phones) {
    const country = await countryForPhone(supabase, phone.replace(/\D/g, ""));
    const r = await rateFor(supabase, organizationId, category, country);
    currency = r.currency;
    perNumber.push({ phone, rate: r.rate });
  }
  const total = Math.round(perNumber.reduce((s, p) => s + p.rate, 0) * 10000) / 10000;
  const cover = await creditsCover(supabase, organizationId, total);
  return {
    enabled: true,
    category,
    currency,
    perNumber,
    total,
    available: cover.available,
    covers: cover.covers,
  };
}
