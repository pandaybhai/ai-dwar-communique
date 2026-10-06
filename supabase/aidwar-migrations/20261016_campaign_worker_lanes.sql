-- Batch 12: run the campaign sender in parallel lanes. Idempotent. NOT applied
-- by the PR that adds it — apply when sending at scale (e.g. before a day of
-- 10 x 10,000-message campaigns).
--
-- Every 30 seconds pg_cron starts LANES calls at once, each with
-- {"lane": i, "lanes": LANES}. Each call sends for ~22 s (CAMPAIGN_WORKER_BUDGET_MS)
-- across every running campaign; a phone number's speed (CAMPAIGN_NUMBER_MPS,
-- default 60 msg/s) is split across the lanes, so all of them together stay
-- under it. Lane 0 alone starts campaigns, reserves credits and settles runs
-- that died. One Cloudflare request keeps at most 6 outgoing requests open,
-- so more lanes = more parallel sends (see the PR for the load-test numbers).
--
-- To go back to one call a minute, re-run 20260814_campaign_cron.sql's schedule.

select cron.unschedule('aidwar-campaign-worker')
where exists (select 1 from cron.job where jobname = 'aidwar-campaign-worker');

select cron.schedule(
  'aidwar-campaign-worker',
  '30 seconds',
  $$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/campaign-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := jsonb_build_object('lane', lane, 'lanes', 16),
    timeout_milliseconds := 40000
  )
  from generate_series(0, 15) as lane;
  $$
);
