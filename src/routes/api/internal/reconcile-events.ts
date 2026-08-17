import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * Nightly reconciliation. Compares recorded flow.sent / flow.clicked events
 * against scheduled_sends and short_links, and logs an alert when they
 * disagree. Guarded by the same shared secret as the other internal workers.
 */
export const Route = createFileRoute("/api/internal/reconcile-events")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["CRON_SECRET"];
        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        if (!expected || provided !== expected) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const url = new URL(request.url);
        const hoursParam = Number(url.searchParams.get("hours"));
        const hours = Number.isFinite(hoursParam) && hoursParam > 0 ? Math.min(hoursParam, 168) : 24;

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { reconcileEvents } = await import("@/lib/reconciliation.server");

        try {
          const result = await reconcileEvents(getServiceClient(), { hours });
          return Response.json({ ...result, commit: buildInfo().commit });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Reconciliation failed";
          console.error("[reconcile] failed", message);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
