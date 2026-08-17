import { createFileRoute } from "@tanstack/react-router";

/** Shopify mandatory compliance webhook: shop/redact. */
export const Route = createFileRoute("/api/public/shopify/webhooks/shop-redact")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { receiveComplianceWebhook, handleShopRedact } = await import(
          "@/lib/shopify-compliance.server"
        );
        const result = await receiveComplianceWebhook(request, "shop/redact");
        if ("response" in result) return result.response;
        await handleShopRedact(result.delivery);
        return new Response("ok", { status: 200 });
      },
    },
  },
});
