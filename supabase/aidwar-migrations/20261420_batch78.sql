-- Batch 78 (NOT applied): /start verifies the WhatsApp number before Meta's
-- Lead fires.
--
-- After step 3 a visitor proves the number is theirs by sending
-- "VERIFY V-7K2P" from it to AiDwar's own number. The code is bound to the
-- lead, the E.164 number it was issued for and a random browser nonce kept
-- in an httpOnly cookie (only its sha256 is stored). It lives 15 minutes and
-- is used once. (From the parked Batch 74 SQL, verification only.)
--
-- Additive and idempotent:
--   (1) public.lead_verifications — service role only (RLS on, no policies).
--   (2) demo_leads.verified_at.
--   (3) public.lead_verifications_purge(): used or expired codes older than
--       7 days, added to the nightly retention job, which keeps its calls.
-- No data changes. Without this file /start still works: the lead is saved,
-- verification answers "not available" and the page goes on to /signup.

-- ---------------------------------------------- (1) verification codes
CREATE TABLE IF NOT EXISTS public.lead_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL REFERENCES public.demo_leads(id) ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  phone text NOT NULL,
  browser_nonce_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_verifications_phone_created_idx
  ON public.lead_verifications (phone, created_at DESC);

ALTER TABLE public.lead_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_verifications FROM anon, authenticated;
GRANT ALL ON public.lead_verifications TO service_role;

-- ---------------------------------------------- (2) demo_leads
ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS verified_at timestamptz;

-- ---------------------------------------------- (3) 7-day purge
CREATE OR REPLACE FUNCTION public.lead_verifications_purge()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_deleted integer := 0;
BEGIN
  WITH d AS (
    DELETE FROM public.lead_verifications
    WHERE created_at < now() - interval '7 days'
      AND (used_at IS NOT NULL OR expires_at < now())
    RETURNING 1
  ) SELECT count(*) INTO v_deleted FROM d;
  RETURN v_deleted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.lead_verifications_purge() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_verifications_purge() TO service_role;

-- The nightly job ('0 2 * * *'). Its current command (20261370_batch67.sql):
--   SELECT public.retention_purge(); SELECT public.api_refusals_purge();
-- After: the same two calls, then the verification purge.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('aidwar-retention-purge')
      WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-retention-purge');
    PERFORM cron.schedule(
      'aidwar-retention-purge',
      '0 2 * * *',
      $cmd$SELECT public.retention_purge(); SELECT public.api_refusals_purge(); SELECT public.lead_verifications_purge();$cmd$
    );
  END IF;
END $$;

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
