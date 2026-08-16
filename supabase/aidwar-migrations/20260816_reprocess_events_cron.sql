DO $do$
DECLARE cmd text;
BEGIN
  SELECT command INTO cmd FROM cron.job WHERE jobname = 'aidwar-campaign-worker';
  cmd := replace(cmd, '/api/internal/campaign-worker', '/api/internal/reprocess-events');
  PERFORM cron.unschedule('aidwar-reprocess-events')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-reprocess-events');
  PERFORM cron.schedule('aidwar-reprocess-events', '*/5 * * * *', cmd);
END
$do$;
