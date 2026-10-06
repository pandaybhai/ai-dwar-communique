-- Batch 12: run the campaign sender in parallel lanes. Idempotent. NOT applied
-- by the PR that adds it — apply when sending at scale (e.g. before a day of
-- 10 x 10,000-message campaigns).
--
-- Every 30 seconds pg_cron starts one call per lane, each with
-- {"lane": i, "lanes": n}: two lanes per phone number with a running (or due)
-- campaign, between 1 and 32. Each call sends for ~22 s
-- (CAMPAIGN_WORKER_BUDGET_MS). Numbers are split across the lanes, and a
-- number's speed (CAMPAIGN_NUMBER_MPS, default 60 msg/s) is divided across
-- the lanes that send for it, so together they stay under it. Lane 0 alone
-- starts campaigns, reserves credits and settles runs that died. One
-- Cloudflare request keeps at most 6 outgoing requests open, so lanes are how
-- sending goes parallel (see the PR for the load-test numbers).
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
    body := jsonb_build_object('lane', lane, 'lanes', n.lanes),
    timeout_milliseconds := 40000
  )
  from (
    select greatest(1, least(32, 2 * count(distinct whatsapp_account_id)))::int as lanes
    from public.campaigns
    where status = 'sending' or (status = 'scheduled' and scheduled_at <= now())
  ) n,
  generate_series(0, n.lanes - 1) as lane;
  $$
);
