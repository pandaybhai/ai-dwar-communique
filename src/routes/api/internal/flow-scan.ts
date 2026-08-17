import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * Daily scan for the time-based flows (winback, reorder).
 *
 * These trigger on elapsed time since a customer's last order, not on a store
 * event, so pg_cron calls this once a day at 04:00 UTC. Enrolment only writes
 * scheduled_sends rows — the per-minute flow worker still does the sending and
 * re-checks every gate at dispatch time.
 */
export const Route = createFileRoute("/api/internal/flow-scan")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["CRON_SECRET"];
        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        if (!expected || provided !== expected) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { scanTimeBasedFlows } = await import("@/lib/flows.server");

        try {
          const result = await scanTimeBasedFlows(getServiceClient());
          return Response.json({ ...result, commit: buildInfo().commit });
        } catch (caught) {
          const error = caught instanceof Error ? caught.message : String(caught);
          console.error(JSON.stringify({ scope: "flows", stage: "scan_failed", error }));
          return Response.json({ error }, { status: 500 });
        }
      },
    },
  },
});
