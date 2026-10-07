import { createFileRoute } from "@tanstack/react-router";
import { buildInfo } from "@/lib/build-info";

/**
 * Reading a website takes minutes, so it never happens on the request that
 * asked for it. Anything queued waits here for the next minute's run, and a
 * read that dies mid-way goes back in the queue after ten minutes, resuming
 * where it got to.
 *
 * The caller (pg_net) gives up after 120 s, so one tick never runs longer
 * than TICK_BUDGET_MS: sources are claimed one at a time, each read is told
 * when it must be over, and another is claimed only while there is time for it.
 */
const TICK_BUDGET_MS = 95_000;
/** Time a claimed read needs to be worth starting. */
const MIN_READ_MS = 45_000;
/**
 * Time the suggested behaviour (one AI call) needs. With less left it waits:
 * the source is marked persona_pending and the next tick makes it first.
 */
const PERSONA_MIN_MS = 30_000;
/** Time the onboarding nudges need; with less they wait for the next tick. */
const NUDGES_MIN_MS = 15_000;

export const Route = createFileRoute("/api/internal/knowledge-worker")({
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
        const { syncSource, resetStaleReads } = await import("@/lib/knowledge.server");
        const supabase = getServiceClient();
        const tickStarted = Date.now();
        const tickEnds = tickStarted + TICK_BUDGET_MS;

        try {
          // A read that never finished is worth another try, from where it got to.
          await resetStaleReads(supabase);

          // A suggested behaviour the last tick had no time for comes first
          // (one per tick; suggestPersonaAfterRead does nothing once one exists).
          let personaCaughtUp = 0;
          try {
            const { data: waiting } = await supabase
              .from("knowledge_sources")
              .select("id, config")
              .eq("config->>persona_pending", "true")
              .neq("status", "syncing")
              .limit(1);
            for (const row of (waiting ?? []) as Array<{ id: string; config: Record<string, unknown> | null }>) {
              const { persona_pending: _done, ...config } = row.config ?? {};
              const { data: took } = await supabase
                .from("knowledge_sources")
                .update({ config })
                .eq("id", row.id)
                .eq("config->>persona_pending", "true")
                .neq("status", "syncing")
                .select("id")
                .maybeSingle();
              if (!took) continue;
              const { suggestPersonaAfterRead } = await import("@/lib/persona.server");
              await suggestPersonaAfterRead(supabase, row.id);
              personaCaughtUp += 1;
            }
          } catch (error) {
            console.error("[knowledge-worker] deferred persona failed", error instanceof Error ? error.message : String(error));
          }

          /** The oldest queued source, claimed so no other tick reads it too. */
          const claimNext = async (): Promise<string | null> => {
            const { data } = await supabase
              .from("knowledge_sources")
              .select("id, organization_id")
              .eq("status", "pending")
              .not("queued_at", "is", null)
              .is("sync_started_at", null)
              .order("queued_at", { ascending: true })
              .limit(3);
            for (const row of (data ?? []) as Array<{ id: string; organization_id: string }>) {
              const { data: won } = await supabase
                .from("knowledge_sources")
                .update({ status: "syncing", sync_started_at: new Date().toISOString() })
                .eq("id", row.id)
                .eq("status", "pending")
                .not("queued_at", "is", null)
                .is("sync_started_at", null)
                .select("id")
                .maybeSingle();
              if (won) return row.id;
            }
            return null;
          };

          const claimed: string[] = [];
          let done = 0;
          let failed = 0;
          let personaDeferred = 0;
          while (claimed.length < 3 && tickEnds - Date.now() >= MIN_READ_MS) {
            const sourceId = await claimNext();
            if (!sourceId) break;
            claimed.push(sourceId);
            let stage: import("@/lib/knowledge.server").CrawlStage = "discover";
            try {
              const result = await syncSource(supabase, sourceId, {
                preserveError: true,
                deadlineAt: tickEnds - 5_000,
                onStage: (next) => { stage = next; },
              });
              if (!result.ok) throw new Error(result.error ?? "The source could not be read.");

              stage = "finish";
              const { finishOnboardingCrawl } = await import("@/lib/merchant-channel.server");
              await finishOnboardingCrawl(supabase, sourceId, result);
              // First website read with no behaviour yet → a suggested one to review.
              // Out of time: the next tick makes it (never past this tick's end).
              if (tickEnds - Date.now() >= PERSONA_MIN_MS) {
                const { suggestPersonaAfterRead } = await import("@/lib/persona.server");
                await suggestPersonaAfterRead(supabase, sourceId);
              } else {
                const { data: now } = await supabase.from("knowledge_sources").select("config").eq("id", sourceId).maybeSingle();
                const config = ((now as { config?: Record<string, unknown> | null } | null)?.config ?? {}) as Record<string, unknown>;
                await supabase
                  .from("knowledge_sources")
                  .update({ config: { ...config, persona_pending: true } })
                  .eq("id", sourceId)
                  .neq("status", "syncing");
                console.warn("[knowledge-worker] persona deferred to next tick", sourceId);
                personaDeferred += 1;
              }
              done += 1;
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              const detail = `${stage}: ${err.name}: ${err.message}`.slice(0, 500);
              console.error("[knowledge-worker]", sourceId, detail);
              await supabase
                .from("knowledge_sources")
                .update({ status: "error", last_error: detail })
                .eq("id", sourceId)
                .neq("status", "disabled");
              // Tell the owner's chat too, or the session waits for ever.
              // A failure here must never hide the crawl error above.
              try {
                const { finishOnboardingCrawl } = await import("@/lib/merchant-channel.server");
                await finishOnboardingCrawl(supabase, sourceId, {
                  ok: false,
                  itemCount: 0,
                  error: detail,
                });
              } catch (notifyError) {
                console.error(
                  "[knowledge-worker] notify failed",
                  sourceId,
                  notifyError instanceof Error ? notifyError.message : String(notifyError),
                );
              }
              failed += 1;
            }
          }

          let embeddings = { tried: 0, built: 0 };
          try {
            const { retryPendingEmbeddings } = await import("@/lib/knowledge.server");
            // Only with time to spare: a read's own pages come first.
            if (tickEnds - Date.now() > 20_000) embeddings = await retryPendingEmbeddings(supabase, 50, tickEnds - 10_000);
          } catch (error) {
            console.error("[knowledge-worker] embed retry failed", error instanceof Error ? error.message : String(error));
          }

          // Day-one follow-ups ride on this tick; a failure here never
          // blocks the reads above.
          let nudges: {
            expired: number;
            nudged: number;
            code_nudged: number;
            skipped: string | null;
          } = {
            expired: 0,
            nudged: 0,
            code_nudged: 0,
            skipped: null,
          };
          try {
            const { runOnboardingNudges } = await import("@/lib/onboarding-nudges.server");
            // Out of time: they are all still due on the next tick.
            if (tickEnds - Date.now() >= NUDGES_MIN_MS) nudges = await runOnboardingNudges(supabase);
            else nudges = { ...nudges, skipped: "deadline" };
          } catch (error) {
            console.error(
              "[onboarding-nudge] failed",
              error instanceof Error ? error.message : String(error),
            );
          }

          return Response.json({
            claimed: claimed.length,
            done,
            failed,
            nudges,
            embeddings,
            ...(personaDeferred > 0 ? { persona_deferred: personaDeferred } : {}),
            ...(personaCaughtUp > 0 ? { persona_caught_up: personaCaughtUp } : {}),
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
