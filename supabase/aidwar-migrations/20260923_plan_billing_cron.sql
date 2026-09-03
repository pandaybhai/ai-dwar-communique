-- Plan fees and the dunning ladder run once a day, early, before anyone is
-- likely to be sending. Both steps are idempotent per billing period.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('aidwar-plan-billing')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-plan-billing');

SELECT cron.schedule(
  'aidwar-plan-billing',
  '30 3 * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--51455eca-09ce-4838-a463-2f6ecd0c72cd.lovable.app/api/internal/plan-billing',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
