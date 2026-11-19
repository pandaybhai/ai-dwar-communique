-- The cron secret that was written here in plain text has been removed (it is
-- rotated; see docs/cron-secret-rotation.md): the job reads it from the Vault
-- (vault.decrypted_secrets, name 'aidwar_cron_secret'), as every live job does
-- (20261053_cron_jobs.sql). Already applied — editing this file re-runs nothing.

SELECT cron.unschedule('aidwar-campaign-worker')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-campaign-worker');

SELECT cron.schedule(
  'aidwar-campaign-worker',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--51455eca-09ce-4838-a463-2f6ecd0c72cd.lovable.app/api/internal/campaign-worker',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'aidwar_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);