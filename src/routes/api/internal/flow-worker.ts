import { createFileRoute } from "@tanstack/react-router";

/**
 * Flow worker — one tick per minute from pg_cron.
 *
 * Claims a small batch of due scheduled sends (FOR UPDATE SKIP LOCKED inside
 * claim_scheduled_sends) and re-checks every gate at dispatch time before it
 * sends: cancellation/recovery, opt-in class, quiet hours and frequency cap.
 * A failure is terminal — status 'failed' with the provider error — so a bad
 * row can never be retried forever.
 *
 * The tick itself lives in src/lib/flow-worker.server.ts (runFlowWorker).
 *
 * Batch 34: the same tick also delivers the Public API's webhook events
 * (runApiWebhookDeliveries, src/lib/public-api-webhooks.server.ts), side by
 * side with the flow tick and on its own budget — no new cron job. It never
 * throws, so the flow tick's answer is unchanged when it has nothing to do.
 */

export const Route = createFileRoute("/api/internal/flow-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { secretEquals } = await import("@/lib/cron-auth.server");
        const expected = process.env["CRON_SECRET"];
        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        if (!expected || !secretEquals(provided, expected)) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { runFlowWorker } = await import("@/lib/flow-worker.server");
        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { runApiWebhookDeliveries } = await import("@/lib/public-api-webhooks.server");
        const [flows, apiWebhooks] = await Promise.all([
          runFlowWorker(),
          runApiWebhookDeliveries(getServiceClient()),
        ]);
        return Response.json({ ...flows, api_webhooks: apiWebhooks });
      },
    },
  },
});
