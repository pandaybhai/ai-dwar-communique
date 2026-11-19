import { createServerFn } from "@tanstack/react-start";

/**
 * Batch 82: what the /199 page reads on the server — the same as /999's
 * (Meta's base India rates for the calculator) and the "Try Aiden yourself"
 * link to AiDwar's own WhatsApp number, with this page's own opening line.
 * Never throws.
 */
export const getPage199Data = createServerFn({ method: "GET" }).handler(async () => {
  const { loadMetaBaseRates } = await import("./public-rates.server");
  const rates = await loadMetaBaseRates();
  let aidenLink: string | null = null;
  try {
    const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
    const { aidwarWaId } = await import("@/lib/lead-verify.server");
    const { waMeLink } = await import("@/lib/lead-verify");
    const waId = await aidwarWaId(getServiceClient());
    aidenLink = waId ? waMeLink(waId, "Hi Aiden! I saw the ₹199 offer.") : null;
  } catch {
    aidenLink = null;
  }
  return { rates, aidenLink };
});
