import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeMeta,
  Samples,
  Semaphore,
  installFetch,
  invocation,
  sampleConnections,
  sleep,
  startInfra,
  statusPayload,
  type StatusEvent,
} from "./test-support/loadtest/harness";

/**
 * Batch 12 load test (off by default; needs Postgres 16 locally and
 * downloads PostgREST once). Runs the real campaign worker route and the
 * real webhook code against a local Postgres + PostgREST, a fake Meta and
 * modelled network round trips:
 *
 *   LOADTEST=1 bunx vitest run src/lib/batch12-loadtest.test.ts --silent=false
 *
 * Knobs (defaults = the 10 × 10,000 day, production-like latency):
 *   LOADTEST_WORKSPACES=10 LOADTEST_PER_CAMPAIGN=10000 LOADTEST_LANES=auto
 *   LOADTEST_DB_RTT_MS=230 LOADTEST_GRAPH_MS=250 LOADTEST_META_MPS=80
 *   LOADTEST_CRON_MS=30000 LOADTEST_PGRST_POOL=40 LOADTEST_MIGRATION=1
 *   LOADTEST_EVENTS=1 (pause/resume one campaign, cancel another)
 *   CAMPAIGN_* (the worker's own settings, see campaign-dispatch.server.ts)
 */
const env = process.env;
const N_WS = Number(env["LOADTEST_WORKSPACES"] ?? 10);
const PER = Number(env["LOADTEST_PER_CAMPAIGN"] ?? 10_000);
// "auto" = what the lanes cron does: two lanes per number with a running campaign (1–32).
const LANES_SETTING = env["LOADTEST_LANES"] ?? "auto";
const LANES = LANES_SETTING === "auto" ? 0 : Number(LANES_SETTING);
const DB_RTT = Number(env["LOADTEST_DB_RTT_MS"] ?? 230);
const GRAPH_MS = Number(env["LOADTEST_GRAPH_MS"] ?? 250);
const META_MPS = Number(env["LOADTEST_META_MPS"] ?? 80);
const CRON_MS = Number(env["LOADTEST_CRON_MS"] ?? 30_000);
const POOL = Number(env["LOADTEST_PGRST_POOL"] ?? 40);
const MIGRATION = env["LOADTEST_MIGRATION"] !== "0";
const EVENTS = env["LOADTEST_EVENTS"] !== "0";
const MAX_MINUTES = Number(env["LOADTEST_MAX_MINUTES"] ?? 45);
// "live": statuses arrive while sending (realistic, but the one-process
// harness becomes the bottleneck at scale); "after": the sends run first,
// then every status is replayed through the webhook at WEBHOOK_CONCURRENCY.
const STATUS_MODE = env["LOADTEST_STATUS_MODE"] ?? "after";
const WEBHOOK_CONCURRENCY = Number(env["LOADTEST_WEBHOOK_CONCURRENCY"] ?? 200);
const OUT = env["LOADTEST_OUT"] ?? join(tmpdir(), "aidwar-loadtest");

const SUPABASE_ORIGIN = "http://supabase.loadtest";

describe.runIf(env["LOADTEST"])("Batch 12 load test", () => {
  it(
    "sends every campaign, once per recipient, and keeps up with the status webhooks",
    { timeout: (MAX_MINUTES + 15) * 60_000 },
    async () => {
      const infra = await startInfra({
        pgPort: Number(env["LOADTEST_PG_PORT"] ?? 54329),
        pgrstPort: Number(env["LOADTEST_PGRST_PORT"] ?? 54330),
        pool: POOL,
        schemaFile: join(import.meta.dirname, "test-support/loadtest/schema.sql"),
        migrations: MIGRATION
          ? [
              join(
                import.meta.dirname,
                "../../supabase/aidwar-migrations/20261016_send_at_scale.sql",
              ),
            ]
          : [],
      });
      try {
        // ------------------------------------------------------------- seed
        infra.psql(`
        insert into organizations (name, billing_enabled_at)
          select 'Store ' || lpad(i::text, 2, '0'), now() - interval '1 day' from generate_series(1, ${N_WS}) i;
        insert into wallet_balances (organization_id, balance) select id, 10000000 from organizations;
        insert into whatsapp_accounts (organization_id, waba_id, phone_number_id, display_phone_number)
          select id, 'waba-' || n, 'pn-' || n, '91800000' || lpad(n::text, 4, '0')
          from (select id, row_number() over (order by name) n from organizations) o;
        insert into whatsapp_credentials (organization_id, waba_id, access_token)
          select organization_id, waba_id, 'token-' || waba_id from whatsapp_accounts;
        insert into message_templates (organization_id, waba_id, name, category, components)
          select organization_id, waba_id, 'diwali_offer', 'MARKETING',
                 '[{"type":"BODY","text":"Hi {{1}}, our Diwali sale is live. Shop now!"}]'::jsonb
          from whatsapp_accounts;
        insert into contacts (organization_id, phone, wa_id, name)
          select o.id, '+91' || (7000000000 + o.n * 100000 + g)::text, (917000000000 + o.n * 100000 + g)::text, 'Customer ' || g
          from (select id, row_number() over (order by name) n from organizations) o, generate_series(1, ${PER}) g;
        insert into campaigns (organization_id, whatsapp_account_id, name, template_name, template_language,
                               status, started_at, total_recipients, estimated_cost)
          select a.organization_id, a.id, 'Diwali blast', 'diwali_offer', 'en_US', 'sending', now(), ${PER}, round(${PER} * 0.86, 2)
          from whatsapp_accounts a;
        insert into campaign_recipients (campaign_id, organization_id, contact_id, phone, resolved_variables)
          select c.id, c.organization_id, ct.id, ct.phone, jsonb_build_object('1', ct.name)
          from campaigns c join contacts ct on ct.organization_id = c.organization_id;
        -- Opted out after the list was built: must be skipped at send time.
        update contacts set opt_in_status = 'opted_out' where random() < 0.005;
        analyze;
        select pg_stat_statements_reset();
        select pg_stat_reset();
      `);
        const numbers = new Map(
          infra
            .psql("select phone_number_id, waba_id, display_phone_number from whatsapp_accounts")
            .split("\n")
            .map((line) => line.split("|"))
            .map(([pn, waba, display]) => [pn!, { pn: pn!, waba: waba!, display: display! }]),
        );
        const campaignOrder = infra
          .psql(
            "select c.id from campaigns c join organizations o on o.id = c.organization_id order by o.name",
          )
          .split("\n");

        // ------------------------------------------------------- the world
        process.env["AIDWAR_SUPABASE_URL"] = SUPABASE_ORIGIN;
        process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = infra.serviceKey;
        process.env["CRON_SECRET"] = "loadtest";

        // A queue with a moving head (shift() on 300k items is quadratic).
        const statusQueue = {
          items: [] as StatusEvent[],
          head: 0,
          get length() {
            return this.items.length - this.head;
          },
          push(s: StatusEvent) {
            this.items.push(s);
          },
          shift(): StatusEvent | undefined {
            const s = this.items[this.head];
            this.head += 1;
            if (this.head > 50_000) {
              this.items = this.items.slice(this.head);
              this.head = 0;
            }
            return s;
          },
        };
        const held: StatusEvent[] = [];
        let statusesScheduled = 0;
        let statusesDelivered = 0;
        let webhooksActive = 0;
        const webhookLatency = new Samples();
        const webhookDb = new Samples();
        let webhookErrors = 0;
        const { acceptWebhook, getServiceClient, reprocessUnprocessedEvents } =
          await import("./whatsapp-webhook.server");
        const pump = () => {
          while (webhooksActive < WEBHOOK_CONCURRENCY && statusQueue.length) {
            const s = statusQueue.shift()!;
            webhooksActive += 1;
            const ctx = { kind: "webhook" as const, sem: new Semaphore(6), db: 0 };
            const t0 = performance.now();
            void invocation
              .run(ctx, () =>
                acceptWebhook(getServiceClient(), {
                  rawBody: JSON.stringify(statusPayload(s)),
                  signatureValid: true,
                  waitUntil: null,
                }),
              )
              .catch(() => {
                webhookErrors += 1;
              })
              .finally(() => {
                webhookLatency.add(performance.now() - t0);
                webhookDb.add(ctx.db);
                webhooksActive -= 1;
                statusesDelivered += 1;
                pump();
              });
          }
        };
        const meta = new FakeMeta({
          mps: META_MPS,
          marketingCapRate: 0.01,
          transientRate: 0.002,
          failAfterSentRate: 0.005,
          numbers,
          statusDelays: { sent: [300, 1500], delivered: [1000, 5000], read: [3000, 30000] },
          onStatus: (s) => {
            statusesScheduled += 1;
            if (STATUS_MODE === "after") {
              held.push(s);
              return;
            }
            setTimeout(
              () => {
                statusQueue.push(s);
                pump();
              },
              Math.max(0, s.at - Date.now()),
            );
          },
        });
        const stats = installFetch({
          supabaseOrigin: SUPABASE_ORIGIN,
          pgrstUrl: infra.pgrstUrl,
          dbRttMs: DB_RTT,
          graphMs: GRAPH_MS,
          meta,
        });

        const { Route } = await import("../routes/api/internal/campaign-worker");
        type Post = (a: { request: Request }) => Promise<Response>;
        const post = (Route.options as unknown as { server: { handlers: { POST: Post } } }).server
          .handlers.POST;
        const runs: Array<{ lane: number; ms: number; sent: number; failed: number }> = [];
        const workerDb = { calls: 0 };
        const lanesSeen: number[] = [];
        const fireCycle = () => {
          const lanes =
            LANES ||
            Number(
              infra.psql(`select greatest(1, least(32, 2 * count(distinct whatsapp_account_id)))::int
                          from campaigns where status = 'sending' or (status = 'scheduled' and scheduled_at <= now())`),
            );
          lanesSeen.push(lanes);
          for (let lane = 0; lane < lanes; lane++) {
            const ctx = { kind: "worker" as const, sem: new Semaphore(6), db: 0 };
            void invocation
              .run(ctx, async () => {
                const res = await post({
                  request: new Request("http://aidwar.test/api/internal/campaign-worker", {
                    method: "POST",
                    headers: { "x-cron-secret": "loadtest", "content-type": "application/json" },
                    body: JSON.stringify({ lane, lanes }),
                  }),
                });
                const report = (await res.json()) as { ms: number; sent: number; failed: number };
                runs.push({ lane, ms: report.ms, sent: report.sent, failed: report.failed });
              })
              .catch((e) => console.error("worker run threw", e))
              .finally(() => {
                workerDb.calls += ctx.db;
              });
          }
        };

        // -------------------------------------------------------------- run
        const conns = sampleConnections(infra.dbUrl, 250);
        const started = Date.now();
        fireCycle();
        const cron = setInterval(fireCycle, CRON_MS);
        const control: Record<string, number> = {};
        const done = () =>
          Number(
            infra.psql(
              "select count(*) from campaigns where status not in ('completed','cancelled')",
            ),
          ) === 0;
        let lagMax = 0;
        let lagAt = performance.now();
        const lagTimer = setInterval(() => {
          const now = performance.now();
          lagMax = Math.max(lagMax, now - lagAt - 100);
          lagAt = now;
        }, 100);
        const progress = setInterval(() => {
          const sent = [...meta.accepted.values()].reduce((s, v) => s + v, 0);
          console.log(
            `[loadtest] t=${Math.round((Date.now() - started) / 1000)}s accepted=${sent} statuses=${statusesDelivered}/${statusesScheduled} queue=${statusQueue.length} active=${webhooksActive} db=${stats.dbRequests.worker}+${stats.dbRequests.webhook} dbErr=${stats.dbErrors}`,
          );
        }, 15_000);

        const pauseTarget = campaignOrder[2] ?? null;
        const cancelTarget = N_WS >= 4 ? campaignOrder[N_WS - 1]! : null;
        while (Date.now() - started < MAX_MINUTES * 60_000) {
          await sleep(1_000);
          const t = Date.now() - started;
          if (EVENTS && pauseTarget && t > 60_000 && !control["pause"]) {
            infra.psql(`update campaigns set status = 'paused' where id = '${pauseTarget}'`);
            control["pause"] = Date.now();
          }
          if (EVENTS && pauseTarget && t > 90_000 && !control["resume"]) {
            infra.psql(
              `update campaigns set status = 'sending' where id = '${pauseTarget}' and status = 'paused'`,
            );
            control["resume"] = Date.now();
          }
          if (EVENTS && cancelTarget && t > 120_000 && !control["cancel"]) {
            // What /api/campaigns/control does on cancel.
            infra.psql(`
            update campaign_recipients set status = 'skipped' where campaign_id = '${cancelTarget}' and status in ('queued','sending');
            update campaigns set status = 'cancelled', completed_at = now() where id = '${cancelTarget}';
          `);
            control["cancel"] = Date.now();
          }
          if (t > 20_000 && done()) break;
        }
        clearInterval(cron);
        const sendingDoneAt = Date.now();
        const webhookRequestsBefore = stats.dbRequests.webhook;
        const webhookPhaseStart = Date.now();
        if (held.length) {
          held.sort((a, b) => a.at - b.at);
          for (const s of held) statusQueue.push(s);
          held.length = 0;
          pump();
        }
        // Statuses still to come, then the retry pass (pg_cron's reprocess-events).
        while (statusQueue.length || webhooksActive || statusesDelivered < statusesScheduled)
          await sleep(500);
        const webhookPhaseMs = Date.now() - webhookPhaseStart;
        let reprocessed = 0;
        for (let i = 0; i < 10; i++) {
          const n = await invocation.run({ kind: "webhook", sem: new Semaphore(6), db: 0 }, () =>
            reprocessUnprocessedEvents(getServiceClient(), { olderThanSeconds: 0, limit: 1000 }),
          );
          reprocessed += n;
          if (!n) break;
        }
        clearInterval(progress);
        clearInterval(lagTimer);
        const connections = conns.stop();
        const totalMs = Date.now() - started;

        // ---------------------------------------------------------- measure
        const q = (sql: string) => infra.psql(sql);
        const accepted = [...meta.accepted.values()].reduce((s, v) => s + v, 0);
        const firstSend = Math.min(...meta.firstAcceptAt.values());
        const lastSend = Math.max(...meta.lastAcceptAt.values());
        const perCampaign = campaignOrder.map((id) => {
          const [status, total, sent, delivered, read, failed] = q(
            `select status, total_recipients, sent_count, delivered_count, read_count, failed_count from campaigns where id = '${id}'`,
          ).split("|");
          const [expSent, expDelivered, expRead, expFailed, expSkipped, stuck] = q(`
          select
            (select count(*) from campaign_recipients r join messages m on m.id = r.message_id where r.campaign_id = '${id}' and m.meta_message_id is not null),
            (select count(*) from campaign_recipients where campaign_id = '${id}' and status in ('delivered','read')),
            (select count(*) from campaign_recipients where campaign_id = '${id}' and status = 'read'),
            (select count(*) from campaign_recipients where campaign_id = '${id}' and status = 'failed'),
            (select count(*) from campaign_recipients where campaign_id = '${id}' and status = 'skipped'),
            (select count(*) from campaign_recipients where campaign_id = '${id}' and status in ('queued','sending'))
        `).split("|");
          const first = meta.firstAcceptAt.get(id) ?? 0;
          const last = meta.lastAcceptAt.get(id) ?? 0;
          return {
            id,
            status,
            total: Number(total),
            counters: {
              sent: Number(sent),
              delivered: Number(delivered),
              read: Number(read),
              failed: Number(failed),
            },
            truth: {
              sent: Number(expSent),
              delivered: Number(expDelivered),
              read: Number(expRead),
              failed: Number(expFailed),
              skipped: Number(expSkipped),
              stuck: Number(stuck),
            },
            minutes: last && first ? (last - first) / 60_000 : null,
          };
        });
        // Every status Meta sent landed: each accepted message (and its
        // recipient) ends at read, or failed when Meta reported a failure.
        const [
          messagesNotFinal = -1,
          recipientsNotFinal = -1,
          readEvents = -1,
          failedAfterSent = 0,
        ] = q(`
        select
          (select count(*) from messages where meta_message_id is not null and status not in ('read','failed')),
          (select count(*) from campaign_recipients r join messages m on m.id = r.message_id
             where m.meta_message_id is not null and r.status not in ('read','failed')),
          (select count(*) from analytics_events where event_type = 'message.read'),
          (select count(*) from messages where meta_message_id is not null and status = 'failed')
      `)
          .split("|")
          .map(Number);
        const optedOutSent = Number(
          q(`select count(*) from campaign_recipients r join contacts c on c.id = r.contact_id
            where c.opt_in_status = 'opted_out' and r.status <> 'skipped'`),
        );
        const optedOutIds = new Set(
          q(
            `select r.id from campaign_recipients r join contacts c on c.id = r.contact_id where c.opt_in_status = 'opted_out'`,
          )
            .split("\n")
            .filter(Boolean),
        );
        const optedOutAtMeta = meta.sendTimes.filter((s) => optedOutIds.has(s.recipient)).length;
        const pauseLeak =
          pauseTarget && control["pause"]
            ? meta.sendTimes.filter(
                (s) =>
                  s.campaign === pauseTarget &&
                  s.at > control["pause"]! + 3_000 &&
                  s.at < control["resume"]!,
              ).length
            : null;
        const pauseLastSendMs =
          pauseTarget && control["pause"]
            ? Math.max(
                0,
                ...meta.sendTimes
                  .filter((s) => s.campaign === pauseTarget && s.at < control["resume"]!)
                  .map((s) => s.at - control["pause"]!),
              )
            : null;
        const cancelLeak =
          cancelTarget && control["cancel"]
            ? meta.sendTimes.filter(
                (s) => s.campaign === cancelTarget && s.at > control["cancel"]! + 3_000,
              ).length
            : null;
        const cancelLastSendMs =
          cancelTarget && control["cancel"]
            ? Math.max(
                0,
                ...meta.sendTimes
                  .filter((s) => s.campaign === cancelTarget)
                  .map((s) => s.at - control["cancel"]!),
              )
            : null;
        const [deadlocks = -1, commits = 0, rollbacks = 0] = q(
          "select deadlocks, xact_commit, xact_rollback from pg_stat_database where datname = 'loadtest'",
        )
          .split("|")
          .map(Number);
        const [stmtCalls = 0, topTimeMs = 0] = q(
          "select sum(calls), sum(total_exec_time) filter (where toplevel) from pg_stat_statements where dbid = (select oid from pg_database where datname='loadtest')",
        )
          .split("|")
          .map(Number);
        const topStatements = q(`
        select calls || ' × ' || round(mean_exec_time::numeric, 3) || ' ms  ' || left(regexp_replace(query, '\\s+', ' ', 'g'), 110)
        from pg_stat_statements where toplevel and dbid = (select oid from pg_database where datname='loadtest')
        order by total_exec_time desc limit 12`).split("\n");
        const unprocessed = Number(
          q("select count(*) from webhook_events where processed_at is null"),
        );
        const retried = Number(
          q(
            "select count(*) from webhook_events where error like 'retry:%' or error like 'gave_up:%'",
          ),
        );
        const statuses = Number(q("select count(*) from webhook_events"));
        const maxPerSecond = Math.max(...meta.maxPerSecond().values());
        const wallet = q(
          "select count(*) filter (where entry_type='debit_message'), count(*) filter (where entry_type='hold') from wallet_ledger",
        );

        const report = {
          config: {
            workspaces: N_WS,
            perCampaign: PER,
            lanes: LANES_SETTING,
            lanesPerCycle: lanesSeen,
            dbRttMs: DB_RTT,
            graphMs: GRAPH_MS,
            metaMps: META_MPS,
            cronMs: CRON_MS,
            pgrstPool: POOL,
            migration: MIGRATION,
            events: EVENTS,
            concurrency: env["CAMPAIGN_SEND_CONCURRENCY"] ?? "6 (default)",
            numberMps: env["CAMPAIGN_NUMBER_MPS"] ?? "60 (default)",
          },
          totals: {
            wallMinutes: +(totalMs / 60_000).toFixed(2),
            sendMinutes: +((lastSend - firstSend) / 60_000).toFixed(2),
            accepted,
            msgsPerSec: +(accepted / ((lastSend - firstSend) / 1000)).toFixed(1),
            refusedByMeta: meta.refused,
            duplicatesAtMeta: meta.duplicates,
            maxAcceptedPerNumberPerSecond: maxPerSecond,
            workerRuns: runs.length,
            workerRunMsP50: (() => {
              const r = new Samples();
              runs.forEach((x) => r.add(x.ms));
              return Math.round(r.pct(50));
            })(),
            workerRunMsMax: Math.max(0, ...runs.map((x) => x.ms)),
            workerSentPerRunMax: Math.max(0, ...runs.map((x) => x.sent)),
          },
          latency: {
            graphSendP50: Math.round(stats.graphLatency.pct(50)),
            graphSendP95: Math.round(stats.graphLatency.pct(95)),
            dbRequestP50: Math.round(stats.dbLatency.pct(50)),
            dbRequestP95: Math.round(stats.dbLatency.pct(95)),
            webhookP50: Math.round(webhookLatency.pct(50)),
            webhookP95: Math.round(webhookLatency.pct(95)),
            eventLoopLagMaxMs: Math.round(lagMax),
          },
          database: {
            workerRequestsPerMessage: +(stats.dbRequests.worker / Math.max(1, accepted)).toFixed(3),
            webhookRequestsPerStatus: +(
              stats.dbRequests.webhook / Math.max(1, statusesDelivered)
            ).toFixed(3),
            webhookRequestsPerStatusP95: webhookDb.pct(95),
            requestsTotal: stats.dbRequests,
            requestErrors: stats.dbErrors,
            requestErrorSamples: stats.dbErrorSamples,
            sqlStatements: stmtCalls,
            sqlStatementsPerMessage: +(stmtCalls / Math.max(1, accepted)).toFixed(1),
            dbTimeMsPerMessage: +(topTimeMs / Math.max(1, accepted)).toFixed(3),
            dbTimeSecondsTotal: +(topTimeMs / 1000).toFixed(1),
            commits,
            rollbacks,
            deadlocks,
            activeConnections: connections,
            topStatements,
            busiestPaths: [...stats.byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
          },
          webhookPhase: {
            mode: STATUS_MODE,
            concurrency: WEBHOOK_CONCURRENCY,
            seconds: +(webhookPhaseMs / 1000).toFixed(1),
            eventsPerSec:
              STATUS_MODE === "after"
                ? +(statusesDelivered / (webhookPhaseMs / 1000)).toFixed(1)
                : null,
            dbRequestsPerSec:
              STATUS_MODE === "after"
                ? +(
                    (stats.dbRequests.webhook - webhookRequestsBefore) /
                    (webhookPhaseMs / 1000)
                  ).toFixed(0)
                : null,
          },
          webhooks: {
            statusesScheduled,
            statusesDelivered,
            stored: statuses,
            unprocessed,
            retriedEvents: retried,
            reprocessed,
            errors: webhookErrors,
          },
          correctness: {
            messagesNotFinal,
            recipientsNotFinal,
            readEvents,
            failedAfterSent,
            duplicateSends: meta.duplicates,
            optedOutNotSkipped: optedOutSent,
            optedOutSentAtMeta: optedOutAtMeta,
            pauseSendsAfter3s: pauseLeak,
            pauseLastSendMs,
            cancelSendsAfter3s: cancelLeak,
            cancelLastSendMs,
            wallet: {
              debitRows: Number(wallet.split("|")[0]),
              holds: Number(wallet.split("|")[1]),
            },
          },
          campaigns: perCampaign,
          sendingDoneAfterMinutes: +((sendingDoneAt - started) / 60_000).toFixed(2),
        };
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report, null, 2));

        // --------------------------------------------------------- verdicts
        expect(meta.duplicates).toBe(0);
        expect(messagesNotFinal).toBe(0);
        expect(recipientsNotFinal).toBe(0);
        expect(readEvents + failedAfterSent).toBe(accepted);
        expect(optedOutAtMeta).toBe(0);
        expect(optedOutSent).toBe(0);
        expect(deadlocks).toBe(0);
        for (const c of perCampaign) {
          expect(c.truth.stuck).toBe(0);
          expect(c.counters.sent).toBe(c.truth.sent);
          expect(c.counters.delivered).toBe(c.truth.delivered);
          expect(c.counters.read).toBe(c.truth.read);
          expect(c.counters.failed).toBe(c.truth.failed);
        }
        if (pauseLeak !== null) expect(pauseLeak).toBe(0);
        if (cancelLeak !== null) expect(cancelLeak).toBe(0);
        expect(unprocessed).toBe(0);
      } finally {
        infra.stop();
      }
    },
  );
});

describe.runIf(env["LOADTEST"] || env["LOADTEST_SQL"])("Batch 12 SQL concurrency", () => {
  /**
   * pgbench, 64 clients for 20 s per mix, each script being what one real
   * writer does statement by statement (each statement its own transaction,
   * as through PostgREST): worker runs (claim → outcome of exactly the rows
   * it claimed → message ids → counters → release a few), status webhooks
   * (recipient row, then its campaign row), counter bumps, and — in the
   * second mix — a merchant cancelling (control.ts).
   */
  const CAMPAIGNS = 20;
  const PER = 15_000;
  const cid = (n: string) => `('00000000-0000-4000-8000-' || lpad((${n})::text, 12, '0'))::uuid`;
  const scripts: Record<string, string> = {
    "worker.sql": `\\set c random(1, ${CAMPAIGNS})
create temp table if not exists mine (id uuid);
delete from mine;
insert into mine select id from claim_campaign_recipients(${cid(":c")}, 25);
update campaign_recipients set status = 'sent', error = null where id in (select id from mine) and status in ('sending','skipped');
update campaign_recipients set message_id = null where id in (select id from mine);
select bump_campaign_counters(${cid(":c")}, 25, 0, 0, 0, 0);
update campaign_recipients set status = 'queued' where id in (select id from mine where random() < 0.2) and status = 'sending';`,
    "status.sql": `\\set n random(1, ${CAMPAIGNS * PER})
\\set s random(1, 4)
select campaign_recipient_status(null, (select id from recipient_ids where n = :n), (array['sent','delivered','read','failed'])[:s], null);`,
    "bump.sql": `\\set c random(1, ${CAMPAIGNS})
select bump_campaign_counters(${cid(":c")}, 0, 1, 0, 0, 0);`,
    "cancel.sql": `\\set c random(1, ${CAMPAIGNS})
update campaign_recipients set status = 'skipped' where campaign_id = ${cid(":c")} and status in ('queued','sending');`,
  };

  it(
    "worker runs, status webhooks and counter bumps on the same rows never deadlock (and with cancels)",
    { timeout: 600_000 },
    async () => {
      const infra = await startInfra({
        pgPort: 54339,
        pgrstPort: 54340,
        pool: 4,
        schemaFile: join(import.meta.dirname, "test-support/loadtest/schema.sql"),
        migrations: [
          join(import.meta.dirname, "../../supabase/aidwar-migrations/20261016_send_at_scale.sql"),
        ],
      });
      try {
        const dir = join(env["LOADTEST_DIR"] ?? join(tmpdir(), "aidwar-loadtest"), "pgbench");
        mkdirSync(dir, { recursive: true });
        for (const [name, body] of Object.entries(scripts))
          writeFileSync(join(dir, name), `${body}\n`);
        const seed = () =>
          infra.psql(`
          truncate campaign_recipients, campaigns, organizations cascade;
          drop table if exists recipient_ids;
          insert into organizations (id, name) values ('00000000-0000-4000-8000-000000000001', 'o');
          insert into campaigns (id, organization_id, name, status)
            select ${cid("g")}, '00000000-0000-4000-8000-000000000001', 'c' || g, 'sending' from generate_series(1, ${CAMPAIGNS}) g;
          insert into campaign_recipients (campaign_id, organization_id, phone, status)
            select ${cid("(g % " + CAMPAIGNS + ") + 1")}, '00000000-0000-4000-8000-000000000001', '+91' || g, 'queued'
            from generate_series(1, ${CAMPAIGNS * PER}) g;
          create table recipient_ids as select row_number() over () n, id from campaign_recipients;
          create index on recipient_ids (n);
          analyze;
          select pg_stat_reset();
        `);
        const bench = (mix: string[], maxTries = 1) => {
          const out = execFileSync(
            "/usr/lib/postgresql/16/bin/pgbench",
            [
              "-h",
              "127.0.0.1",
              "-p",
              "54339",
              "-U",
              "postgres",
              "-n",
              "-c",
              "64",
              "-j",
              "4",
              "-T",
              "20",
              `--max-tries=${maxTries}`,
              ...mix.flatMap((m) => ["-f", join(dir, m)]),
              "loadtest",
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
          );
          return {
            tps: Number(/tps = ([\d.]+)/.exec(out)?.[1] ?? 0),
            failedTransactions: Number(
              /number of failed transactions: (\d+)/.exec(out)?.[1] ?? "0",
            ),
            deadlocks: Number(
              infra.psql("select deadlocks from pg_stat_database where datname = 'loadtest'"),
            ),
          };
        };
        seed();
        const normal = bench(["worker.sql@4", "status.sql@6", "bump.sql@2"]);
        seed();
        // Cancels can deadlock with a worker's write on the same rows; both
      // sides try again (as the app does), so nothing may end up failed.
      const withCancels = bench(["worker.sql@4", "status.sql@6", "bump.sql@2", "cancel.sql@1"], 5);
        const report = { normal, withCancels };
        mkdirSync(OUT, { recursive: true });
        writeFileSync(join(OUT, "sql-concurrency.json"), JSON.stringify(report, null, 2));
        console.log("SQL concurrency", JSON.stringify(report));
        expect(normal.deadlocks).toBe(0);
        expect(normal.failedTransactions).toBe(0);
        expect(normal.tps).toBeGreaterThan(0);
        expect(withCancels.failedTransactions).toBe(0);
      } finally {
        infra.stop();
      }
    },
  );
});
