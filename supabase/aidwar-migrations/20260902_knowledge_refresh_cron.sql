-- Live knowledge re-reads itself. Websites and other live sources carry a
-- refresh window; this job wakes every six hours and re-reads whatever is due.
-- Uploaded files have refresh_days = 0 and are never queued.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule('aidwar-knowledge-refresh')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-knowledge-refresh');

SELECT cron.schedule(
  'aidwar-knowledge-refresh',
  '20 */6 * * *',
  $$
  SELECT net.http_post(
    url := 'https://project--51455eca-09ce-4838-a463-2f6ecd0c72cd.lovable.app/api/internal/knowledge-refresh',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
