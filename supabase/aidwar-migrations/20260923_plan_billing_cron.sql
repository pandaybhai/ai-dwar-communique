-- Plan fees and the dunning ladder run once a day, early, before anyone is
-- likely to be sending. Both steps are idempotent per billing period, and the
-- cron secret is read from the Vault like every other worker.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('aidwar-plan-billing')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-plan-billing');

SELECT cron.schedule(
  'aidwar-plan-billing',
  '30 3 * * *',
  $$
  select net.http_post(
    url := 'https://aidwar.in/api/internal/plan-billing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
