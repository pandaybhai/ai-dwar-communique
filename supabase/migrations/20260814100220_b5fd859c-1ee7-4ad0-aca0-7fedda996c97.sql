CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('aidwar-campaign-worker')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-campaign-worker');

SELECT cron.schedule(
  'aidwar-campaign-worker',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--51455eca-09ce-4838-a463-2f6ecd0c72cd.lovable.app/api/internal/campaign-worker',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "d044b3bd41a41878cc639875a4181554751916c5b7f4332f"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);