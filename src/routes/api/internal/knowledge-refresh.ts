import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * The scheduled re-read: any source whose refresh window has passed is
 * re-read here — a website only on a paid plan, and only its changed pages
 * (sitemap date vs read_at). Only while platform_settings.knowledge_auto_refresh is on —
 * off (the default, and while the column is missing) it does nothing, and a
 * site is re-read only when the merchant asks. Uploaded files are static and
 * never queued.
 *
 * pg_net drops the call at 120 s, so no inline re-read starts after
 * REFRESH_BUDGET_MS; a source left over is still due and goes first next run.
 */
const REFRESH_BUDGET_MS = 60_000;

export const Route = createFileRoute("/api/internal/knowledge-refresh")({
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

        const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
        const { syncSource } = await import("@/lib/knowledge.server");
        const supabase = getServiceClient();
        const deadlineAt = Date.now() + REFRESH_BUDGET_MS;

        try {
          const { loadKnowledgeAutoRefresh, loadReadingSettings } = await import("@/lib/reading.server");
          if (!(await loadKnowledgeAutoRefresh(supabase))) {
            return Response.json({ skipped: "auto_refresh_off", considered: 0, due: 0, refreshed: 0, queued: 0, failed: 0, commit: buildInfo().commit });
          }
          const reading = await loadReadingSettings(supabase);
          const { data: raw } = await supabase
            .from("knowledge_sources")
            .select("id, organization_id, type, refresh_days, last_synced_at, config, status")
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
          let trialSkipped = 0;
          let deferred = 0;
          // Batch 16: the weekly re-read is for paid plans only; a trial
          // workspace's site is re-read only when the merchant asks.
          const { planLimits } = await import("@/lib/knowledge.server");
          const paidByOrg = new Map<string, Promise<boolean>>();
          const isPaid = (org: string) => {
            if (!paidByOrg.has(org)) paidByOrg.set(org, planLimits(supabase, org).then((p) => p.paid).catch(() => false));
            return paidByOrg.get(org)!;
          };
          for (const source of due) {
            // Websites: re-read only pages already read, and of those only the
            // ones whose sitemap date moved (changed_only); unchanged pages
            // aren't re-embedded. The worker reads them in bounded runs, never here.
            const src = data.find((d) => d.id === source.id) as (typeof data)[number] & { organization_id?: string };
            if (src?.type === "website") {
              if (!src.organization_id || !(await isPaid(src.organization_id))) {
                trialSkipped += 1;
                continue;
              }
              await supabase
                .from("knowledge_sources")
                .update({
                  config: { ...(src.config ?? {}), refresh: true, refresh_started_at: null, changed_only: true },
                  status: "pending",
                  queued_at: new Date().toISOString(),
                  sync_started_at: null,
                })
                .eq("id", source.id)
                .not("status", "in", "(syncing,pending,disabled)");
              queued += 1;
              continue;
            }
            if (Date.now() >= deadlineAt) {
              deferred += 1;
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
            trial_skipped: trialSkipped,
            ...(deferred > 0 ? { deferred } : {}),
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
