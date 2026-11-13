import type { SupabaseClient } from "@supabase/supabase-js";
import { MESSAGE_CATEGORIES, type ClientRate } from "@/lib/billing";

/**
 * The platform default per-message rates for India, for the public pricing
 * page. Read through public.client_rate_for with no workspace (p_org null =
 * the platform default rate card), like every other client surface, and only
 * the client rate and currency leave this file — never Meta's cost or the
 * card's mode. Cached in memory: the page is public and rates change rarely.
 */
const CACHE_MS = 10 * 60_000;
let cached: { at: number; rates: ClientRate[] } | null = null;

export async function readDefaultRates(
  supabase: SupabaseClient,
  country = "IN",
): Promise<ClientRate[]> {
  return Promise.all(
    MESSAGE_CATEGORIES.map(async (category) => {
      const { data, error } = await supabase.rpc("client_rate_for", {
        p_org: null,
        p_country: country,
        p_category: category,
      });
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : null) as {
        rate: number | string | null;
        currency: string | null;
      } | null;
      return {
        category,
        rate: row?.rate === null || row?.rate === undefined ? null : Number(row.rate),
        currency: row?.currency ?? "INR",
      } satisfies ClientRate;
    }),
  );
}

export async function loadPublicRates(now = Date.now()): Promise<ClientRate[]> {
  if (cached && now - cached.at < CACHE_MS) return cached.rates;
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const rates = await readDefaultRates(getServiceClient());
  cached = { at: now, rates };
  return rates;
}

/**
 * Batch 80: Meta's own base rates for India (message_rates — Meta's price,
 * never our rate card), for the /999 page's zero-markup calculator. The
 * latest row in effect today per category; the seeded 1 Jan 2026 figures
 * when the table can't be read, so the page never shows an empty calculator.
 */
export const META_BASE_FALLBACK = { marketing: 0.8631, utility: 0.115 } as const;
let baseCached: {
  at: number;
  rates: { marketing: number; utility: number; effective_from: string | null };
} | null = null;

export async function loadMetaBaseRates(
  now = Date.now(),
): Promise<{ marketing: number; utility: number; effective_from: string | null }> {
  if (baseCached && now - baseCached.at < CACHE_MS) return baseCached.rates;
  const fallback = { ...META_BASE_FALLBACK, effective_from: null };
  try {
    const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
    const today = new Date(now).toISOString().slice(0, 10);
    const { data, error } = await getServiceClient()
      .from("message_rates")
      .select("category, rate, effective_from")
      .eq("country_code", "IN")
      .in("category", ["marketing", "utility"])
      .lte("effective_from", today)
      .order("effective_from", { ascending: false });
    if (error || !Array.isArray(data)) return fallback;
    type RateRow = { category: string; rate: number | string; effective_from: string };
    const rows = data as RateRow[];
    const pick = (category: "marketing" | "utility") => {
      const row = rows.find((r) => r.category === category);
      const rate = row ? Number(row.rate) : Number.NaN;
      return Number.isFinite(rate) && rate > 0 ? { rate, from: row!.effective_from } : null;
    };
    const m = pick("marketing");
    const u = pick("utility");
    const rates = {
      marketing: m?.rate ?? fallback.marketing,
      utility: u?.rate ?? fallback.utility,
      effective_from: m?.from ?? u?.from ?? null,
    };
    baseCached = { at: now, rates };
    return rates;
  } catch {
    return fallback;
  }
}
