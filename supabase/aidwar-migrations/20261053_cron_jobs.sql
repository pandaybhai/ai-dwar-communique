-- Batch 20 item 8 (NOT applied, DRAFT): every pg_cron job the live database
-- runs, saved in the repo as the one source of truth. Idempotent: each job is
-- unscheduled by name (if present) and scheduled again with the same name.
--
-- The cron secret is NEVER written here: every command reads it from the
-- Vault (vault.decrypted_secrets, name 'aidwar_cron_secret') when it runs,
-- exactly like 20260923_plan_billing_cron.sql and
-- 20261016_campaign_worker_lanes.sql. Every route under
-- src/routes/api/internal/ checks that header (x-cron-secret) against its
-- CRON_SECRET env var.
--
-- DRAFT: the six jobs marked "live: ?" have no definition anywhere in the
-- repo, and the names of the others may differ live (the repo's older
-- migrations used 'aidwar-*' names). The live schedules, commands, timeouts
-- and job names are asked for in the PR (select jobname, schedule, command,
-- active from cron.job — with the secret redacted). Until they are filled in
-- this file stops itself, so it can never be run half-done:
DO $$ BEGIN
  RAISE EXCEPTION 'Batch 20 draft: fill in the live cron schedules before applying 20261053_cron_jobs.sql';
END $$;

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- One POST to an internal worker route, the secret read from the Vault at
-- run time. Session-only helper: nothing is left behind in the schema.
CREATE OR REPLACE FUNCTION pg_temp.aidwar_cron_command(p_path text, p_body text, p_timeout_ms int)
RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT format(
    $cmd$
  select net.http_post(
    url := 'https://aidwar.in%s',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := %s,
    timeout_milliseconds := %s
  );
  $cmd$,
    p_path, p_body, p_timeout_ms
  );
$f$;

CREATE OR REPLACE FUNCTION pg_temp.aidwar_reschedule(p_name text, p_schedule text, p_command text, p_active boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM cron.unschedule(p_name) WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = p_name);
  PERFORM cron.schedule(p_name, p_schedule, p_command);
  IF NOT p_active THEN
    PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = p_name), active := false);
  END IF;
END
$f$;

-- campaign-worker — every 30 s, one call per lane (two lanes per sending
-- number, 1..32), as 20261016_campaign_worker_lanes.sql (applied). Live: ?
SELECT pg_temp.aidwar_reschedule(
  'campaign-worker',
  '30 seconds',
  $cmd$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/campaign-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := jsonb_build_object('lane', lane, 'lanes', n.lanes),
    timeout_milliseconds := 40000
  )
  from (
    select greatest(1, least(32, 2 * count(distinct whatsapp_account_id)))::int as lanes
    from public.campaigns
    where status = 'sending' or (status = 'scheduled' and scheduled_at <= now())
  ) n,
  generate_series(0, n.lanes - 1) as lane;
  $cmd$
);

-- reprocess-events — every 5 min (20260816_reprocess_events_cron.sql). Live: ?
SELECT pg_temp.aidwar_reschedule('reprocess-events', '*/5 * * * *',
  pg_temp.aidwar_cron_command('/api/internal/reprocess-events', '''{}''::jsonb', 30000 /* proposed; live: ? */));

-- shopify-sync-worker — every minute (20260817_shopify_sync_cron.sql). Live: ?
SELECT pg_temp.aidwar_reschedule('shopify-sync-worker', '* * * * *',
  pg_temp.aidwar_cron_command('/api/internal/shopify-sync-worker', '''{}''::jsonb', 30000 /* proposed; live: ? */));

-- flow-worker — minute tick (flow-worker.ts). Live: ? (no repo definition)
SELECT pg_temp.aidwar_reschedule('flow-worker', 'LIVE-SCHEDULE?',
  pg_temp.aidwar_cron_command('/api/internal/flow-worker', '''{}''::jsonb', 0 /* LIVE-TIMEOUT? */));

-- flow-scan — daily 04:00 UTC (20260901_flow_scan_cron.sql). Live: ?
SELECT pg_temp.aidwar_reschedule('flow-scan', '0 4 * * *',
  pg_temp.aidwar_cron_command('/api/internal/flow-scan', '''{}''::jsonb', 30000 /* proposed; live: ? */));

-- knowledge-refresh — PAUSED (active = false): sites are re-read only when
-- the merchant asks (Vinay, 7 Oct; the route is also gated by
-- platform_settings.knowledge_auto_refresh). 20260902 had '20 */6 * * *'. Live: ?
SELECT pg_temp.aidwar_reschedule('knowledge-refresh', '20 */6 * * *',
  pg_temp.aidwar_cron_command('/api/internal/knowledge-refresh', '''{}''::jsonb', 90000 /* proposed; live: ? */), false);

-- billing-notify — drains the billing notice queue. Live: ? (no repo definition)
SELECT pg_temp.aidwar_reschedule('billing-notify', 'LIVE-SCHEDULE?',
  pg_temp.aidwar_cron_command('/api/internal/billing-notify', '''{}''::jsonb', 0 /* LIVE-TIMEOUT? */));

-- billing-sweep — nightly. Live: ? (no repo definition)
SELECT pg_temp.aidwar_reschedule('billing-sweep', 'LIVE-SCHEDULE?',
  pg_temp.aidwar_cron_command('/api/internal/billing-sweep', '''{}''::jsonb', 0 /* LIVE-TIMEOUT? */));

-- billing-monthly — daily (plan fees, dunning; /plan-billing is its alias,
-- 20260923 scheduled 'aidwar-plan-billing' at '30 3 * * *'). Live: ?
SELECT pg_temp.aidwar_reschedule('billing-monthly', 'LIVE-SCHEDULE?',
  pg_temp.aidwar_cron_command('/api/internal/billing-monthly', '''{}''::jsonb', 0 /* LIVE-TIMEOUT? */));

-- knowledge-worker — minute tick, ~95 s budget (pg_net drops at 120 s). Live: ?
SELECT pg_temp.aidwar_reschedule('knowledge-worker', 'LIVE-SCHEDULE?',
  pg_temp.aidwar_cron_command('/api/internal/knowledge-worker', '''{}''::jsonb', 0 /* LIVE-TIMEOUT? */));

-- knowledge-backfill — nightly (also price check, purgeDeletedSources). Live: ?
SELECT pg_temp.aidwar_reschedule('knowledge-backfill', 'LIVE-SCHEDULE?',
  pg_temp.aidwar_cron_command('/api/internal/knowledge-backfill', '''{}''::jsonb', 0 /* LIVE-TIMEOUT? */));
