-- Embedded Signup hardening:
-- 1. store the granted scopes alongside the real token expiry
-- 2. whatsapp_credentials is service-role only — no client role may read tokens

ALTER TABLE public.whatsapp_credentials
  ADD COLUMN IF NOT EXISTS granted_scopes text[];

-- No client role may touch this table under any circumstance.
REVOKE ALL ON public.whatsapp_credentials FROM anon, authenticated;
GRANT ALL ON public.whatsapp_credentials TO service_role;

ALTER TABLE public.whatsapp_credentials ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role manages whatsapp credentials" ON public.whatsapp_credentials;
CREATE POLICY "Service role manages whatsapp credentials"
  ON public.whatsapp_credentials
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
