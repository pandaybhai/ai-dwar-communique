-- Batch 74 (NOT applied): verified, WhatsApp-only sign-up and log-in.
--
-- A visitor proves they own a WhatsApp number by sending a short code
-- ("VERIFY V-7K2P" / "LOGIN L-4QX9") from it to AiDwar's own number. The code
-- is bound to the lead (or the user, for log-in), the E.164 number it was
-- issued for, and a random browser nonce kept in an httpOnly cookie (only its
-- sha256 is stored). It lives 15 minutes and is used once.
--
-- Additive and idempotent:
--   (1) public.lead_verifications — service role only (RLS on, no policies).
--   (2) demo_leads.verified_at, demo_leads.nudged_at.
--   (3) profiles.email_is_placeholder — a WhatsApp-only account has a
--       non-deliverable wa+<digits>@users.aidwar.in address because Supabase's
--       server-minted sessions (magic-link token hash) need an email; nothing
--       may ever email it (guarded in code).
--   (4) public.lead_verifications_purge() and the nightly job, which keeps
--       its existing calls and adds this one.
-- No data changes.

-- ---------------------------------------------- (1) verification codes
CREATE TABLE IF NOT EXISTS public.lead_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.demo_leads(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify', 'login')),
  code text NOT NULL UNIQUE,
  phone text NOT NULL,
  browser_nonce_hash text NOT NULL,
  user_id uuid,
  expires_at timestamptz NOT NULL,
  -- The WhatsApp message with the code arrived from the right number.
  used_at timestamptz,
  -- Wrong-number / wrong-nonce tries against this code (capped in code).
  attempts integer NOT NULL DEFAULT 0,
  -- sha256 of the one-time fallback link sent in the WhatsApp reply.
  link_token_hash text,
  -- The browser (by nonce) or the fallback link took the result: once only.
  claimed_at timestamptz,
  -- sha256(ip + salt) for the per-IP limit on new codes; never the IP.
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_verifications_phone_created_idx
  ON public.lead_verifications (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS lead_verifications_ip_created_idx
  ON public.lead_verifications (ip_hash, created_at DESC);

ALTER TABLE public.lead_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_verifications FROM anon, authenticated;
GRANT ALL ON public.lead_verifications TO service_role;

-- ---------------------------------------------- (2) demo_leads
ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS verified_at timestamptz;
ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS nudged_at timestamptz;

-- ---------------------------------------------- (3) profiles
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email_is_placeholder boolean NOT NULL DEFAULT false;

-- ---------------------------------------------- (4) 7-day purge
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
      AND (used_at IS NOT NULL OR claimed_at IS NOT NULL OR expires_at < now())
    RETURNING 1
  ) SELECT count(*) INTO v_deleted FROM d;
  RETURN v_deleted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.lead_verifications_purge() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_verifications_purge() TO service_role;

-- The nightly job ('0 2 * * *'). Before (20261370_batch67.sql):
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
