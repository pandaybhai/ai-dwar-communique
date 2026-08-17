import { createFileRoute } from "@tanstack/react-router";

/** Shopify mandatory compliance webhook: customers/data_request. */
export const Route = createFileRoute("/api/public/shopify/webhooks/customers-data-request")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { receiveComplianceWebhook, handleCustomersDataRequest } = await import(
          "@/lib/shopify-compliance.server"
        );
        const result = await receiveComplianceWebhook(request, "customers/data_request");
        if ("response" in result) return result.response;
        await handleCustomersDataRequest(result.delivery);
        return new Response("ok", { status: 200 });
      },
    },
  },
});
