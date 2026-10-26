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
