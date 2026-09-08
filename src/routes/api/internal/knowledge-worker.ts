import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * Reading a website takes minutes, so it never happens on the request that
 * asked for it. Anything queued waits here for the next minute's run, and a
 * read that dies mid-way goes back in the queue after ten minutes.
 */
export const Route = createFileRoute("/api/internal/knowledge-worker")({
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
        const { syncSource } = await import("@/lib/knowledge.server");
        const supabase = getServiceClient();

        try {
          // A read that never finished is worth another try.
          const stale = new Date(Date.now() - 10 * 60_000).toISOString();
          await supabase
            .from("knowledge_sources")
            .update({ status: "queued", queued_at: new Date().toISOString() })
            .eq("status", "syncing")
            .lt("sync_started_at", stale);

          const { data } = await supabase
            .from("knowledge_sources")
            .select("id, organization_id")
            .eq("status", "queued")
            .order("queued_at", { ascending: true, nullsFirst: true })
            .limit(3);

          const claimed: string[] = [];
          for (const row of (data ?? []) as Array<{ id: string; organization_id: string }>) {
            const { data: won } = await supabase
              .from("knowledge_sources")
              .update({ status: "syncing", sync_started_at: new Date().toISOString() })
              .eq("id", row.id)
              .eq("status", "queued")
              .select("id")
              .maybeSingle();
            if (won) claimed.push(row.id);
          }

          let done = 0;
          let failed = 0;
          for (const sourceId of claimed) {
            const result = await syncSource(supabase, sourceId);
            if (result.ok) done += 1;
            else failed += 1;

            // The owner's chat with Aiden is waiting on this read.
            const { finishOnboardingCrawl } = await import("@/lib/merchant-channel.server");
            await finishOnboardingCrawl(supabase, sourceId, result);
          }

          return Response.json({
            claimed: claimed.length,
            done,
            failed,
            commit: buildInfo().commit,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Worker failed";
          console.error("[knowledge-worker] failed", message);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
