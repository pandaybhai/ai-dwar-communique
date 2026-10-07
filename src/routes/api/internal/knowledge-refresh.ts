import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * The scheduled re-read: any source whose refresh window has passed is
 * re-read here. Only while platform_settings.knowledge_auto_refresh is on —
 * off (the default, and while the column is missing) it does nothing, and a
 * site is re-read only when the merchant asks. Uploaded files are static and
 * never queued.
 */
export const Route = createFileRoute("/api/internal/knowledge-refresh")({
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
          const { loadKnowledgeAutoRefresh, loadReadingSettings } = await import("@/lib/reading.server");
          if (!(await loadKnowledgeAutoRefresh(supabase))) {
            return Response.json({ skipped: "auto_refresh_off", considered: 0, due: 0, refreshed: 0, queued: 0, failed: 0, commit: buildInfo().commit });
          }
          const reading = await loadReadingSettings(supabase);
          const { data: raw } = await supabase
            .from("knowledge_sources")
            .select("id, type, refresh_days, last_synced_at, config, status")
            .or("refresh_days.gt.0,and(type.eq.website,refresh_days.is.null)")
            .not("status", "in", "(syncing,pending,disabled)")
            .order("last_synced_at", { ascending: true, nullsFirst: true })
            .limit(25);

          // Website sources without their own window use the platform's refresh_days.
          const data = ((raw ?? []) as Array<{ id: string; type: string; refresh_days: number | null; last_synced_at: string | null; config: Record<string, unknown> | null }>)
            .map((s) => ({ ...s, refresh_days: s.refresh_days ?? (s.type === "website" ? reading.refresh_days : 0) }))
            .filter((s) => s.refresh_days > 0);
          const due = (data as Array<{
            id: string;
            refresh_days: number;
            last_synced_at: string | null;
          }>).filter(
            (s) =>
              !s.last_synced_at ||
              Date.now() - new Date(s.last_synced_at).getTime() >= s.refresh_days * 864e5,
          );

          let refreshed = 0;
          let failed = 0;
          let queued = 0;
          for (const source of due) {
            // Websites: re-read only pages already read; unchanged pages aren't
            // re-embedded. The worker reads them in bounded runs, never here.
            const src = data.find((d) => d.id === source.id);
            if (src?.type === "website") {
              await supabase
                .from("knowledge_sources")
                .update({
                  config: { ...(src.config ?? {}), refresh: true, refresh_started_at: null },
                  status: "pending",
                  queued_at: new Date().toISOString(),
                  sync_started_at: null,
                })
                .eq("id", source.id)
                .not("status", "in", "(syncing,pending,disabled)");
              queued += 1;
              continue;
            }
            const result = await syncSource(supabase, source.id);
            if (result.ok) refreshed += 1;
            else failed += 1;
          }

          return Response.json({
            considered: (data ?? []).length,
            due: due.length,
            refreshed,
            queued,
            failed,
            commit: buildInfo().commit,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Refresh failed";
          console.error("[knowledge-refresh] failed", message);
          return Response.json({ error: message }, { status: 500 });
        }
      },
    },
  },
});
