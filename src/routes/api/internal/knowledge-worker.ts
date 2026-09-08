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
            .update({
              status: "pending",
              queued_at: new Date().toISOString(),
              sync_started_at: null,
            })
            .eq("status", "syncing")
            .lt("sync_started_at", stale);

          const { data } = await supabase
            .from("knowledge_sources")
            .select("id, organization_id")
            .in("status", ["pending", "queued"])
            .not("queued_at", "is", null)
            .is("sync_started_at", null)
            .order("queued_at", { ascending: true })
            .limit(3);

          const claimed: string[] = [];
          for (const row of (data ?? []) as Array<{ id: string; organization_id: string }>) {
            const { data: won } = await supabase
              .from("knowledge_sources")
              .update({ status: "syncing", sync_started_at: new Date().toISOString() })
              .eq("id", row.id)
                .in("status", ["pending", "queued"])
                .not("queued_at", "is", null)
                .is("sync_started_at", null)
              .select("id")
              .maybeSingle();
            if (won) claimed.push(row.id);
          }

          let done = 0;
          let failed = 0;
          for (const sourceId of claimed) {
            let stage: import("@/lib/knowledge.server").CrawlStage = "discover";
            try {
              const result = await syncSource(supabase, sourceId, {
                preserveError: true,
                onStage: (next) => { stage = next; },
              });
              if (!result.ok) throw new Error(result.error ?? "The source could not be read.");

              stage = "finish";
              const { finishOnboardingCrawl } = await import("@/lib/merchant-channel.server");
              await finishOnboardingCrawl(supabase, sourceId, result);
              done += 1;
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              const detail = `${stage}: ${err.name}: ${err.message}`.slice(0, 500);
              console.error("[knowledge-worker]", sourceId, detail);
              await supabase
                .from("knowledge_sources")
                .update({ status: "error", last_error: detail })
                .eq("id", sourceId);
              failed += 1;
            }
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
