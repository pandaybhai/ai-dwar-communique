import { createFileRoute } from "@tanstack/react-router";

/** Public API v1.2 (Batch 38): send webhook.test to one webhook now, and answer with what it replied. */
export const Route = createFileRoute("/api/v1/webhooks/$webhookId/test")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { apiActor, testWebhook } = await import("@/lib/public-api-webhook-endpoints.server");
        return runApiRoute(request, { step: "webhook_test" }, ({ supabase, caller }) =>
          testWebhook(supabase, apiActor(caller), String(params.webhookId ?? "").trim()),
        );
      },
    },
  },
});
