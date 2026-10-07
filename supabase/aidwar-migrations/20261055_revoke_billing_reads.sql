-- Batch 20 item 7, separate and OPTIONAL (NOT applied): take EXECUTE on the
-- two SECURITY DEFINER billing reads away from browsers. Apply on its own,
-- after 20261054_live_only_functions.sql — same class as Batch 17's revokes
-- (20261030_batch17_function_grants.sql).
--
-- Live today both are executable by `authenticated` for ANY p_org, so any
-- signed-in user can read another workspace's client rates
-- (client_rate_for) and AI-answer allowance (ai_answers_allowance).
--
-- Checked on main @ 399ec41: no browser code calls either one (no .rpc of
-- them under src/components, src/routes/app, src/hooks or
-- src/integrations). Their only callers are in src/lib/billing.server.ts
-- (clientRatesUnchecked, rateFor, summaryUnchecked), reached from
-- /api/billing/summary, /api/campaigns/estimate, /api/campaigns/launch,
-- /api/admin/billing and queueTopupTask — every one through the
-- service-role client (requireOrgMember / getServiceClient), which keeps
-- its grant here.
--
-- Idempotent. To undo:
--   GRANT EXECUTE ON FUNCTION public.ai_answers_allowance(uuid) TO authenticated;
--   GRANT EXECUTE ON FUNCTION public.client_rate_for(uuid, text, text, timestamp with time zone) TO authenticated;

SET lock_timeout = '5s';

REVOKE ALL ON FUNCTION public.ai_answers_allowance(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_answers_allowance(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.client_rate_for(uuid, text, text, timestamp with time zone) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.client_rate_for(uuid, text, text, timestamp with time zone) TO service_role;
