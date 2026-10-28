import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API v1.2 (Batch 38): every webhook event — when it fires, an
 * example body and the plans that have it — from the same description as
 * the docs (public-api-spec.ts) and the plan table.
 */
export const Route = createFileRoute("/api/v1/webhooks/events")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { webhookEventCatalogue } = await import("@/lib/public-api-webhook-endpoints.server");
        return runApiRoute(request, { step: "webhook_events" }, () => webhookEventCatalogue());
      },
    },
  },
});
