-- Shopify now issues expiring offline access tokens (apps created after
-- 2026-04-01 cannot use non-expiring tokens on the Admin API). We store the
-- access-token expiry plus the rotating refresh token.
--
-- integration_credentials is already service-role only (see 20260821); the
-- refresh token inherits that lockdown and is re-asserted here so no client
-- role can ever read it.

ALTER TABLE public.integration_credentials
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS refresh_token text,
  ADD COLUMN IF NOT EXISTS refresh_token_expires_at timestamptz;

REVOKE ALL ON public.integration_credentials FROM anon, authenticated;
GRANT ALL ON public.integration_credentials TO service_role;
ALTER TABLE public.integration_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "integration_credentials_service_only" ON public.integration_credentials;
CREATE POLICY "integration_credentials_service_only" ON public.integration_credentials
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Jobs abandoned by the old non-expiring token flow are retired, not failed.
ALTER TABLE public.integration_sync_jobs
  DROP CONSTRAINT IF EXISTS integration_sync_jobs_status_check;

ALTER TABLE public.integration_sync_jobs
  ADD CONSTRAINT integration_sync_jobs_status_check
  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'superseded'));
