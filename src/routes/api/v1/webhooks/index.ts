import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API v1.2 (Batch 38): the workspace's webhooks (up to 5). GET lists
 * them (never a secret); POST adds one { url, events } and answers with its
 * signing secret, once.
 */
export const Route = createFileRoute("/api/v1/webhooks/")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { listWebhooks } = await import("@/lib/public-api-webhook-endpoints.server");
        return runApiRoute(request, { step: "webhook_list" }, ({ supabase, caller }) =>
          listWebhooks(supabase, caller),
        );
      },
      POST: async ({ request }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { MAX_WEBHOOK_REQUEST_BYTES, apiActor, createWebhook } =
          await import("@/lib/public-api-webhook-endpoints.server");
        return runApiRoute(
          request,
          { step: "webhook_create", body: { maxBytes: MAX_WEBHOOK_REQUEST_BYTES } },
          ({ supabase, caller, body }) => {
            const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
            return createWebhook(supabase, apiActor(caller), {
              url: b["url"],
              events: b["events"],
            });
          },
        );
      },
    },
  },
});
