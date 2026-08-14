-- Schedules the campaign sender worker every minute (applied to the aidwar-mumbai project).
-- Replace <CRON_SECRET> with the value stored in the CRON_SECRET project secret.
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
    headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
