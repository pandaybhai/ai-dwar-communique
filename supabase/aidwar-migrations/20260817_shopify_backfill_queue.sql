-- Shopify backfill becomes a cron-driven, resumable job.
-- Jobs are enqueued (status 'queued') and processed one bounded chunk per tick.

ALTER TABLE public.integration_sync_jobs
  DROP CONSTRAINT IF EXISTS integration_sync_jobs_status_check;

ALTER TABLE public.integration_sync_jobs
  ADD CONSTRAINT integration_sync_jobs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed'));

ALTER TABLE public.integration_sync_jobs
  ADD COLUMN IF NOT EXISTS cursor text;

ALTER TABLE public.integration_sync_jobs
  ALTER COLUMN status SET DEFAULT 'queued',
  ALTER COLUMN phase SET DEFAULT 'queued';

CREATE INDEX IF NOT EXISTS integration_sync_jobs_pending_idx
  ON public.integration_sync_jobs (status, started_at)
  WHERE status IN ('queued', 'running');
