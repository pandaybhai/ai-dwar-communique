-- Daily scan for the time-based flows (winback, reorder). These are day-scale
-- triggers, so once a day at 04:00 UTC is enough — the per-minute flow worker
-- still dispatches whatever the scan enrols.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('aidwar-flow-scan')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-flow-scan');

SELECT cron.schedule(
  'aidwar-flow-scan',
  '0 4 * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--51455eca-09ce-4838-a463-2f6ecd0c72cd.lovable.app/api/internal/flow-scan',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
