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
        const expected = process.env["CRON_SECRET"];
        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        if (!expected || provided !== expected) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { getServiceClient, reprocessUnprocessedEvents } = await import(
          "@/lib/whatsapp-webhook.server"
        );

        const supabase = getServiceClient();
        const processed = await reprocessUnprocessedEvents(supabase, {
          olderThanSeconds: 60,
          limit: 100,
        });

        return Response.json({ processed, commit: buildInfo().commit });
      },
    },
  },
});
