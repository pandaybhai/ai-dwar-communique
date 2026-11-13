import { createServerFn } from "@tanstack/react-start";

/**
 * Batch 80: what the /999 page reads on the server — Meta's base India rates
 * for the calculator, and the "Try Aiden yourself" link to AiDwar's own
 * WhatsApp number (null when it isn't set: the link is left out). Never throws.
 */
export const getPage999Data = createServerFn({ method: "GET" }).handler(async () => {
  const { loadMetaBaseRates } = await import("./public-rates.server");
  const rates = await loadMetaBaseRates();
  let aidenLink: string | null = null;
  try {
    const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
    const { aidwarWaId } = await import("@/lib/lead-verify.server");
    const { waMeLink } = await import("@/lib/lead-verify");
    const waId = await aidwarWaId(getServiceClient());
    aidenLink = waId ? waMeLink(waId, "Hi Aiden! I saw the ₹999 plan.") : null;
  } catch {
    aidenLink = null;
  }
  return { rates, aidenLink };
});
