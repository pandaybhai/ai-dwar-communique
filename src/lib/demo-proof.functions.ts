import { createServerFn } from "@tanstack/react-start";

/**
 * Public, read-only: the sanitized record of AI answers captured from the
 * internal fixture. No AI is generated here — this only reads rows that an
 * operator explicitly published.
 */
export const getPublishedProof = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
    const { listPublishedProof } = await import("@/lib/demo-proof.server");
    return { proof: await listPublishedProof(getServiceClient()) };
  } catch {
    return { proof: [] };
  }
});
