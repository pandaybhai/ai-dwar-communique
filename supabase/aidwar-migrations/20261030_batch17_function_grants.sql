-- Batch 17 (1): workspace-scoped DB functions are server-only.
-- Idempotent. Apply by hand to the Mumbai project (hcsacmqzspnfqoftoifu); do not auto-apply.
-- Nothing here changes data or a function body.
--
-- Found (7 Oct health check, re-verified live): any signed-in user could call
-- these SECURITY DEFINER functions with ANY workspace id —
--   ai_month_spend(uuid)              reads another workspace's AI spend
--   org_flag_enabled(uuid, text)      reads another workspace's plan features
--   record_knowledge_use(uuid, uuid[]) bumps another workspace's use counts
--   seed_org_ai_skills(uuid)          inserts default skills into any workspace
--                                     (live already lacks the authenticated grant;
--                                     the repo migration still grants it)
--
-- Who calls them: only server code, always with the service-role client
-- (ai-run.server.ts, billing.server.ts, api/ai/employee.ts) and SECURITY
-- DEFINER SQL (billing_debit_message, trg_guard_plan_status,
-- seed_org_ai_defaults, trg_ai_runs_billing), which runs as the owner. No RLS
-- policy uses them and the browser never calls them, so no membership check
-- is needed: the browser simply loses the door.

SET lock_timeout = '5s';

REVOKE ALL ON FUNCTION public.ai_month_spend(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_month_spend(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.org_flag_enabled(uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_flag_enabled(uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.record_knowledge_use(uuid, uuid[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_knowledge_use(uuid, uuid[]) TO service_role;

REVOKE ALL ON FUNCTION public.seed_org_ai_skills(uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_org_ai_skills(uuid) TO service_role;

RESET lock_timeout;
