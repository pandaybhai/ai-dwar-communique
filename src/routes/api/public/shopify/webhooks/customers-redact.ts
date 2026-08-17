import { createFileRoute } from "@tanstack/react-router";

/** Shopify mandatory compliance webhook: customers/redact. */
export const Route = createFileRoute("/api/public/shopify/webhooks/customers-redact")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { receiveComplianceWebhook, handleCustomersRedact } = await import(
          "@/lib/shopify-compliance.server"
        );
        const result = await receiveComplianceWebhook(request, "customers/redact");
        if ("response" in result) return result.response;
        await handleCustomersRedact(result.delivery);
        return Response.json({ ok: true }, { status: 200 });
      },
    },
  },
});
