-- Batch 20 item 8 (NOT applied; to be applied by hand after review): every
-- pg_cron job the live database runs, as it runs them — names, schedules,
-- active flags, paths and timeouts from cron.job read-only on 7 Oct 2026
-- 12:25 UTC (PR #32). 13 jobs: 11 HTTP workers and 2 SQL jobs.
--
-- The cron secret is NEVER written here: every HTTP job reads it from the
-- Vault (vault.decrypted_secrets, name 'aidwar_cron_secret') when it runs,
-- as live does. Every route under src/routes/api/internal/ checks that
-- x-cron-secret header against its CRON_SECRET env var.
--
-- Definitions only — no behaviour change: where live sets no
-- timeout_milliseconds, none is set here (pg_net's default applies), and
-- aidwar-knowledge-refresh stays scheduled but paused (active = false; sites
-- are re-read only when the merchant asks, and the route is also gated by
-- platform_settings.knowledge_auto_refresh).
--
-- Idempotent: each job is unscheduled by name (if present) and scheduled
-- again with the same name. This replaces the older one-job files
-- (20260814_campaign_cron, 20260816_reprocess_events_cron,
-- 20260817_shopify_sync_cron, 20260817_retention_purge's schedule,
-- 20260901_flow_scan_cron, 20260902_knowledge_refresh_cron,
-- 20260923_plan_billing_cron) as the one definition of the schedule.
-- 20261016_campaign_worker_lanes.sql (30-second lanes) is NOT live: live
-- runs the one-call-a-minute campaign worker below.
--
-- SQL jobs: public.retention_purge() is in the repo
-- (20260824_retention_strip_extend.sql, identical to live: 4518 chars, md5
-- b63de0809cd2d49b290446953f887720). public.reprice_unpriced_messages() is
-- live only (md5 dc8fbb7ebc27d7e5432b06d7dcad74cf) — its definition is asked
-- for in PR #32 and is not part of this file.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- aidwar-billing-monthly: 0 19 * * *, timeout 120000 ms
SELECT cron.unschedule('aidwar-billing-monthly') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-billing-monthly');
SELECT cron.schedule(
  'aidwar-billing-monthly',
  '0 19 * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/billing-monthly',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cmd$
);

-- aidwar-billing-notify: */5 * * * *, timeout 30000 ms
SELECT cron.unschedule('aidwar-billing-notify') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-billing-notify');
SELECT cron.schedule(
  'aidwar-billing-notify',
  '*/5 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/billing-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $cmd$
);

-- aidwar-billing-sweep: */30 * * * *, timeout 60000 ms
SELECT cron.unschedule('aidwar-billing-sweep') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-billing-sweep');
SELECT cron.schedule(
  'aidwar-billing-sweep',
  '*/30 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/billing-sweep',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cmd$
);

-- aidwar-campaign-worker: * * * * *, timeout not set
SELECT cron.unschedule('aidwar-campaign-worker') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-campaign-worker');
SELECT cron.schedule(
  'aidwar-campaign-worker',
  '* * * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/campaign-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- aidwar-flow-scan: 0 4 * * *, timeout not set
SELECT cron.unschedule('aidwar-flow-scan') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-flow-scan');
SELECT cron.schedule(
  'aidwar-flow-scan',
  '0 4 * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/flow-scan',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- aidwar-flow-worker: * * * * *, timeout not set
SELECT cron.unschedule('aidwar-flow-worker') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-flow-worker');
SELECT cron.schedule(
  'aidwar-flow-worker',
  '* * * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/flow-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- aidwar-knowledge-backfill: 0 21 * * *, timeout 60000 ms
SELECT cron.unschedule('aidwar-knowledge-backfill') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-knowledge-backfill');
SELECT cron.schedule(
  'aidwar-knowledge-backfill',
  '0 21 * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/knowledge-backfill',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cmd$
);

-- aidwar-knowledge-refresh: 20 */6 * * * (PAUSED), timeout 60000 ms
SELECT cron.unschedule('aidwar-knowledge-refresh') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-knowledge-refresh');
SELECT cron.schedule(
  'aidwar-knowledge-refresh',
  '20 */6 * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/knowledge-refresh',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cmd$
);
SELECT cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'aidwar-knowledge-refresh'), active := false);

-- aidwar-knowledge-worker: * * * * *, timeout 120000 ms
SELECT cron.unschedule('aidwar-knowledge-worker') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-knowledge-worker');
SELECT cron.schedule(
  'aidwar-knowledge-worker',
  '* * * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/knowledge-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cmd$
);

-- aidwar-reprocess-events: */5 * * * *, timeout not set
SELECT cron.unschedule('aidwar-reprocess-events') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-reprocess-events');
SELECT cron.schedule(
  'aidwar-reprocess-events',
  '*/5 * * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/reprocess-events',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- aidwar-shopify-sync: * * * * *, timeout not set
SELECT cron.unschedule('aidwar-shopify-sync') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-shopify-sync');
SELECT cron.schedule(
  'aidwar-shopify-sync',
  '* * * * *',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/shopify-sync-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $cmd$
);

-- aidwar-reprice-sweep: */10 * * * *
SELECT cron.unschedule('aidwar-reprice-sweep') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-reprice-sweep');
SELECT cron.schedule('aidwar-reprice-sweep', '*/10 * * * *', $cmd$select public.reprice_unpriced_messages();$cmd$);

-- aidwar-retention-purge: 0 2 * * *
SELECT cron.unschedule('aidwar-retention-purge') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-retention-purge');
SELECT cron.schedule('aidwar-retention-purge', '0 2 * * *', $cmd$SELECT public.retention_purge();$cmd$);
