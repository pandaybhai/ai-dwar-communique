-- Batch 67: Public API sends that didn't go out ("Refused").
-- Idempotent and additive. NOT applied: apply by hand to the Mumbai project,
-- after 20261360_batch66.sql. Applying it twice changes nothing the second
-- time (batch67-sql.test.ts applies it twice to a throwaway Postgres).
-- No data changes.
--
-- (1) public.api_refusals: one row per POST /api/v1/messages/template or
--     /session request answered 4xx/5xx before any messages row existed
--     (invalid_phone, template_not_approved, document_unreachable,
--     param_count_mismatch, invalid_cc, rate_limited, our own 5xx, …),
--     written only by the service role (api-refusals.server.ts, after the
--     answer; never the answer's bytes or timing). 401 (no valid key) is never
--     recorded. Never stored: the API key or Authorization header,
--     body_params values, document bytes or links (a link in the reason is
--     "[link]"); `to_received` is the `to` as received, at most 32 characters.
--     dedupe_key (endpoint:idempotency_key:error_code) keeps a retry with
--     the same key from being recorded twice.
--     Members read their workspace's rows (RLS), for Templates → Sent,
--     Home's Needs attention and the daily summary.
--     The code works without this table: the insert fails, is logged and
--     never changes the API's answer; the reads show no refusals.
--
-- (2) public.api_refusals_purge(): rows older than 90 days, run by the
--     existing nightly aidwar-retention-purge job (its command gains the call;
--     public.retention_purge() itself is unchanged). Skipped where pg_cron
--     isn't installed (a test database).

-- ------------------------------------------------ (1) the table
CREATE TABLE IF NOT EXISTS public.api_refusals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  api_key_id text,
  source text NOT NULL DEFAULT 'api' CHECK (source IN ('api', 'api_console')),
  endpoint text NOT NULL CHECK (endpoint IN ('template', 'session')),
  http_status integer NOT NULL CHECK (http_status BETWEEN 400 AND 599),
  error_code text NOT NULL CHECK (char_length(error_code) <= 64),
  reason text NOT NULL CHECK (char_length(reason) <= 300),
  template_name text CHECK (char_length(template_name) <= 200),
  to_received text CHECK (char_length(to_received) <= 32),
  idempotency_key text CHECK (char_length(idempotency_key) <= 255),
  field text CHECK (char_length(field) <= 32),
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_refusals_org_created_idx
  ON public.api_refusals (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS api_refusals_org_template_created_idx
  ON public.api_refusals (organization_id, template_name, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS api_refusals_org_dedupe_key
  ON public.api_refusals (organization_id, dedupe_key);

COMMENT ON TABLE public.api_refusals IS
  'Batch 67: Public API send requests refused before any messages row existed. Written only by the service role; members read their own. Kept 90 days (api_refusals_purge).';

ALTER TABLE public.api_refusals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_refusals_select_members ON public.api_refusals;
CREATE POLICY api_refusals_select_members ON public.api_refusals
  FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));

REVOKE ALL ON public.api_refusals FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.api_refusals FROM authenticated;
GRANT SELECT ON public.api_refusals TO authenticated;
GRANT ALL ON public.api_refusals TO service_role;

-- ------------------------------------------------ (2) 90-day retention
CREATE OR REPLACE FUNCTION public.api_refusals_purge()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_deleted integer := 0;
BEGIN
  WITH d AS (
    DELETE FROM public.api_refusals
    WHERE created_at < now() - interval '90 days'
    RETURNING 1
  ) SELECT count(*) INTO v_deleted FROM d;
  RETURN v_deleted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.api_refusals_purge() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_refusals_purge() TO service_role;

-- The nightly job (20261053_cron_jobs.sql: '0 2 * * *') also purges refusals.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('aidwar-retention-purge')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-retention-purge');
    PERFORM cron.schedule(
      'aidwar-retention-purge',
      '0 2 * * *',
      $cmd$SELECT public.retention_purge(); SELECT public.api_refusals_purge();$cmd$
    );
  END IF;
END $$;

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
