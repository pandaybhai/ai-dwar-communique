import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * Catch-up worker for stored webhook events that were never processed
 * (processed_at IS NULL). Guarded by the same shared secret as the campaign
 * worker so only our scheduler can call it. The public webhook never runs this
 * inline — it processes exactly the payload it received.
 */
export const Route = createFileRoute("/api/internal/reprocess-events")({
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

        const { getServiceClient, reprocessUnprocessedEvents, waitUntilOf } = await import(
          "@/lib/whatsapp-webhook.server"
        );

        const supabase = getServiceClient();
        // Batch 12: a campaign day leaves thousands of status events; they are
        // caught up 10 at a time (customer messages still one by one, in
        // order), for up to 20 s, and the pass keeps going if pg_net hangs up.
        // Batch 27: 60 s is for status-only events; an event with a customer
        // message waits CATCH_UP_MESSAGES_AFTER_MS so its retry can re-answer it.
        const work = reprocessUnprocessedEvents(supabase, {
          olderThanSeconds: 60,
          limit: 500,
          statusConcurrency: 10,
          budgetMs: 20_000,
        });
        const waitUntil = waitUntilOf(request);
        if (waitUntil) waitUntil(work.catch(() => 0));
        const processed = await work;

        let healthAlerts = 0;
        try {
          const { drainHealthNotifications } = await import("@/lib/send-health.server");
          healthAlerts = await drainHealthNotifications(supabase);
        } catch {
          // alerts never block event catch-up
        }

        return Response.json({ processed, health_alerts: healthAlerts, commit: buildInfo().commit });
      },
    },
  },
});
