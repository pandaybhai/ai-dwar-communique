import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * Live knowledge keeps itself current: any source whose refresh window has
 * passed is re-read here. Uploaded files are static and never queued.
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
          const { data } = await supabase
            .from("knowledge_sources")
            .select("id, refresh_days, last_synced_at")
            .gt("refresh_days", 0)
            .order("last_synced_at", { ascending: true, nullsFirst: true })
            .limit(25);

          const due = ((data ?? []) as Array<{
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
          for (const source of due) {
            const result = await syncSource(supabase, source.id);
            if (result.ok) refreshed += 1;
            else failed += 1;
          }

          return Response.json({
            considered: (data ?? []).length,
            due: due.length,
            refreshed,
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
