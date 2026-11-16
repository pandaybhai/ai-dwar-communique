-- Batch 80b (NOT applied): every Meta Conversions API call is logged, so the
-- /999 events (ViewContent, InitiateCheckout, AddPaymentInfo, Purchase) can be
-- proven from SQL.
--
-- Additive and idempotent:
--   (1) public.meta_capi_log — one row per server event: sent / failed /
--       skipped (and why), Graph's http status, events_received and
--       fbtrace_id, the error, and the test_event_code when the call was a
--       Test Events call. Never a person's data: no user_data, no ip, no
--       hashes. Service role only (RLS on, no policies).
--   (2) public.meta_capi_log_purge(): rows older than 14 days, added to the
--       nightly retention job, which keeps its three calls.
-- Without this file the code works exactly as before: a failed log write is
-- ignored and the send is unchanged.

-- ---------------------------------------------------------------- (1) log
CREATE TABLE IF NOT EXISTS public.meta_capi_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  event_name text NOT NULL,
  event_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('sent', 'failed', 'skipped')),
  reason text,
  http_status integer,
  events_received integer,
  fbtrace_id text,
  error text,
  test_event_code text,
  action_source text,
  source_url text
);

CREATE INDEX IF NOT EXISTS meta_capi_log_created_idx ON public.meta_capi_log (created_at DESC);
CREATE INDEX IF NOT EXISTS meta_capi_log_event_idx ON public.meta_capi_log (event_name, created_at DESC);

ALTER TABLE public.meta_capi_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.meta_capi_log FROM anon, authenticated;
GRANT ALL ON public.meta_capi_log TO service_role;

-- ---------------------------------------------------------- (2) 14 days
CREATE OR REPLACE FUNCTION public.meta_capi_log_purge()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_deleted integer := 0;
BEGIN
  WITH d AS (
    DELETE FROM public.meta_capi_log WHERE created_at < now() - interval '14 days' RETURNING 1
  ) SELECT count(*) INTO v_deleted FROM d;
  RETURN v_deleted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.meta_capi_log_purge() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.meta_capi_log_purge() TO service_role;

-- The nightly job ('0 2 * * *'). Its current command (20261420_batch78.sql):
--   SELECT public.retention_purge(); SELECT public.api_refusals_purge(); SELECT public.lead_verifications_purge();
-- After: the same three calls, then the log purge.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('aidwar-retention-purge')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-retention-purge');
    PERFORM cron.schedule(
      'aidwar-retention-purge',
      '0 2 * * *',
      $cmd$SELECT public.retention_purge(); SELECT public.api_refusals_purge(); SELECT public.lead_verifications_purge(); SELECT public.meta_capi_log_purge();$cmd$
    );
  END IF;
END $$;

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
