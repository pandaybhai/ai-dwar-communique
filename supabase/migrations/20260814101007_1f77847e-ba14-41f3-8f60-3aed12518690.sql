SELECT cron.unschedule('aidwar-campaign-worker')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-campaign-worker');