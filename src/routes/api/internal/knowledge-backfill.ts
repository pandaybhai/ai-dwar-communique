import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * Nightly: every paid workspace's website reads its next unread pages, in
 * priority order, up to backfill_pages_per_day and within its plan's limit.
 * Firecrawl caps apply inside the crawler (it falls back to our own reader).
 */
export const Route = createFileRoute("/api/internal/knowledge-backfill")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env["CRON_SECRET"];
        const provided = request.headers.get("x-cron-secret") ?? request.headers.get("X-Cron-Secret");
        if (!expected || provided !== expected) return Response.json({ error: "Unauthorized" }, { status: 401 });

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { planLimits } = await import("@/lib/knowledge.server");
        const { loadReadingSettings } = await import("@/lib/reading.server");
        const supabase = getServiceClient();
        const reading = await loadReadingSettings(supabase);
        if (reading.backfill_pages_per_day <= 0) return Response.json({ off: true });

        try {
          const { data } = await supabase
            .from("knowledge_sources")
            .select("id, organization_id, pages_seen, config")
            .eq("type", "website")
            .eq("status", "ready")
            .limit(500);
          let queued = 0;
          for (const src of (data ?? []) as Array<{ id: string; organization_id: string; pages_seen: number | null; config: Record<string, unknown> | null }>) {
            const { count } = await supabase
              .from("knowledge_urls")
              .select("id", { count: "exact", head: true })
              .eq("source_id", src.id)
              .eq("status", "unread");
            if (!count) continue;
            const plan = await planLimits(supabase, src.organization_id);
            if (!plan.paid) continue;
            const room = plan.cap - Number(src.pages_seen ?? 0);
            if (room <= 0) continue;
            await supabase
              .from("knowledge_sources")
              .update({
                status: "pending",
                queued_at: new Date().toISOString(),
                sync_started_at: null,
                config: {
                  ...(src.config ?? {}),
                  mode: "full",
                  resume: true,
                  pages_done: Number(src.pages_seen ?? 0),
                  run_limit: Math.min(reading.backfill_pages_per_day, room),
                },
              })
              .eq("id", src.id)
              .eq("status", "ready");
            queued += 1;
          }
          return Response.json({ queued, commit: buildInfo().commit });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Backfill failed";
          console.error("[knowledge-backfill] failed", message);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
