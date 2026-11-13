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
--   (4) The no-website interview's six Scripts (interview_q1–q4,
--       interview_media, interview_done) as ai_prompt_blocks rows, so they
--       are editable in /admin/aiden — inserted only when missing (an
--       admin's own wording is never overwritten). Same text as the code's
--       built-in defaults (src/lib/scripts.ts), which are used until then.
-- Without this file /start still works: the lead is saved, verification
-- answers "not available" and the page goes on to /signup; the interview
-- uses the built-in Script texts.

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

-- ---------------------------------------------- (4) interview Scripts
INSERT INTO public.ai_prompt_blocks (key, name, description, content, default_content)
VALUES
  (E'interview_q1', E'No website: question 1', E'First of the no-website interview (the owner chose "I don''t have a website"). Saved as a fact: products and prices.', E'No website? No problem — I''ll ask you 4 quick questions, one at a time. Type skip to skip any.\n\n1/4 — What do you sell, and what''s your price range? (For example: cotton kurtas, ₹600–₹2,500.)', E'No website? No problem — I''ll ask you 4 quick questions, one at a time. Type skip to skip any.\n\n1/4 — What do you sell, and what''s your price range? (For example: cotton kurtas, ₹600–₹2,500.)'),
  (E'interview_q2', E'No website: question 2', E'Saved as a fact: timings and location / delivery area.', E'2/4 — What are your timings, and where are you? If you deliver, which areas?', E'2/4 — What are your timings, and where are you? If you deliver, which areas?'),
  (E'interview_q3', E'No website: question 3', E'Saved as a fact: payment options / COD.', E'3/4 — How can customers pay? UPI, cards, cash on delivery?', E'3/4 — How can customers pay? UPI, cards, cash on delivery?'),
  (E'interview_q4', E'No website: question 4', E'Saved as a fact: return / exchange policy.', E'4/4 — What''s your return or exchange policy?', E'4/4 — What''s your return or exchange policy?'),
  (E'interview_media', E'No website: price list', E'After the 4 questions: asks for a photo or PDF of the price list or catalogue (with a Skip button).', E'Last thing: send me a photo or PDF of your price list or catalogue — or tap Skip.', E'Last thing: send me a photo or PDF of your price list or catalogue — or tap Skip.'),
  (E'interview_done', E'No website: done', E'The owner skipped the price list: Aiden is ready to be tested.', E'Thanks — I''ve saved all that for {business}. Now test me: ask me anything a customer would ask, like your prices or your timings.', E'Thanks — I''ve saved all that for {business}. Now test me: ask me anything a customer would ask, like your prices or your timings.')
ON CONFLICT (key) DO NOTHING;

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
