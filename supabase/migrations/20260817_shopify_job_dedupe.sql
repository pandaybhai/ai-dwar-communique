-- Only one non-terminal sync job per integration.
-- Retire duplicates first: keep the oldest queued/running row per integration.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY integration_id ORDER BY started_at) AS rn
  FROM public.integration_sync_jobs
  WHERE status IN ('queued', 'running')
)
UPDATE public.integration_sync_jobs j
SET status = 'failed',
    error = 'Superseded by another sync job for the same store.',
    finished_at = now(),
    updated_at = now()
FROM ranked r
WHERE r.id = j.id AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS integration_sync_jobs_one_active_idx
  ON public.integration_sync_jobs (integration_id)
  WHERE status IN ('queued', 'running');
