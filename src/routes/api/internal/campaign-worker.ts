import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * The campaign sender. pg_cron calls it (one call per lane; body
 * {"lane": i, "lanes": n}, or no body for a single lane). Each call sends for
 * up to CAMPAIGN_WORKER_BUDGET_MS across every running campaign — see
 * src/lib/campaign-dispatch.server.ts.
 */
export const Route = createFileRoute("/api/internal/campaign-worker")({
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

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown> | null;
        const { getServiceClient, waitUntilOf } = await import("@/lib/whatsapp-webhook.server");
        const { dispatchConfig, runCampaignDispatch } =
          await import("@/lib/campaign-dispatch.server");

        const supabase = getServiceClient();
        const cfg = dispatchConfig({ lane: body?.["lane"], lanes: body?.["lanes"] });
        const work = runCampaignDispatch(supabase, cfg);
        // The caller (pg_net) may hang up before the run ends; the run still
        // finishes its in-flight sends and puts unsent recipients back.
        const waitUntil = waitUntilOf(request);
        if (waitUntil) waitUntil(work.catch(() => {}));
        const report = await work;

        return Response.json({ ...report, commit: buildInfo().commit });
      },
    },
  },
});
