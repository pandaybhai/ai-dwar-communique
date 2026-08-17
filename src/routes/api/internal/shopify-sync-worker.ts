import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * Cron-driven Shopify backfill. Each tick retires stalled jobs and advances the
 * oldest pending job by exactly one bounded chunk (a page of products or of
 * orders), storing a cursor so the next tick resumes where this one stopped.
 */
export const Route = createFileRoute("/api/internal/shopify-sync-worker")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["CRON_SECRET"];
        const provided =
          request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        if (!expected || provided !== expected) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const { getServiceClient } = await import("@/lib/shopify.server");
        const { processSyncJobTick } = await import("@/lib/shopify-sync.server");

        const result = await processSyncJobTick(getServiceClient());
        return Response.json({ ...result, commit: buildInfo().commit });
      },
    },
  },
});
