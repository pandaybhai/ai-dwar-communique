-- Schedules the Shopify backfill worker every minute, reusing the campaign
-- worker's command (and therefore its stored CRON_SECRET header).
DO $do$
DECLARE cmd text;
BEGIN
  SELECT command INTO cmd FROM cron.job WHERE jobname = 'aidwar-campaign-worker';
  cmd := replace(cmd, '/api/internal/campaign-worker', '/api/internal/shopify-sync-worker');
  PERFORM cron.unschedule('aidwar-shopify-sync')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-shopify-sync');
  PERFORM cron.schedule('aidwar-shopify-sync', '* * * * *', cmd);
END
$do$;
