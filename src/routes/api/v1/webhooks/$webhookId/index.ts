import { createFileRoute } from "@tanstack/react-router";

/**
 * Public API v1.2 (Batch 38): one webhook. GET it; PATCH its url, events,
 * status or rotate_secret (a new secret is in that one answer); DELETE it.
 * Another workspace's webhook is a 404.
 */
export const Route = createFileRoute("/api/v1/webhooks/$webhookId/")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { getWebhook } = await import("@/lib/public-api-webhook-endpoints.server");
        return runApiRoute(request, { step: "webhook_get" }, ({ supabase, caller }) =>
          getWebhook(supabase, caller, String(params.webhookId ?? "").trim()),
        );
      },
      PATCH: async ({ request, params }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { MAX_WEBHOOK_REQUEST_BYTES, apiActor, updateWebhook } =
          await import("@/lib/public-api-webhook-endpoints.server");
        return runApiRoute(
          request,
          { step: "webhook_update", body: { maxBytes: MAX_WEBHOOK_REQUEST_BYTES } },
          ({ supabase, caller, body }) =>
            updateWebhook(supabase, apiActor(caller), String(params.webhookId ?? "").trim(), body),
        );
      },
      DELETE: async ({ request, params }) => {
        const { runApiRoute } = await import("@/lib/public-api.server");
        const { apiActor, deleteWebhook } =
          await import("@/lib/public-api-webhook-endpoints.server");
        return runApiRoute(request, { step: "webhook_delete" }, ({ supabase, caller }) =>
          deleteWebhook(supabase, apiActor(caller), String(params.webhookId ?? "").trim()),
        );
      },
    },
  },
});
