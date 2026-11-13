import { createServerFn } from "@tanstack/react-start";
import type { ClientRate } from "@/lib/billing";

/** Platform default message rates (India) for the public pricing page. Never throws: [] on failure. */
export const getPublicRates = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { loadPublicRates } = await import("./public-rates.server");
    return { rates: await loadPublicRates(), ok: true as const };
  } catch {
    return { rates: [] as ClientRate[], ok: false as const };
  }
});

/** Batch 80: Meta's base India rates for the /999 calculator (never throws). */
export const getMetaBaseRates = createServerFn({ method: "GET" }).handler(async () => {
  const { loadMetaBaseRates } = await import("./public-rates.server");
  return loadMetaBaseRates();
});
