-- Batch 28 (3): one SQL aggregate for AI cost, so /admin/ai, the /admin/billing
-- AI margin and the platform monthly AI ceiling read the same numbers.
-- Idempotent. NOT applied: apply by hand to the Mumbai project
-- (hcsacmqzspnfqoftoifu).
--
-- Found (8 Oct): /admin/ai showed provider cost Rs 22.01 and "Runs · 30 days
-- 1000" while the real 30-day cost was ~Rs 830. The page read ai_runs rows
-- through PostgREST, which caps a response at 1,000 rows, and summed them in
-- the server route. The billing overview's model mix read raw ai_runs the
-- same way (.limit(100000) is still cut to 1,000).
--
-- public.ai_cost_totals(p_from, p_to, p_org, p_breakdown) sums public.ai_runs
-- in [p_from, p_to) (p_to null = up to now), optionally for one workspace:
--   runs           every run, any status
--   ok_runs        runs with status 'ok' (not "answers": an answer is a reply
--                  to a customer — ai_run_is_customer_answer, 20261084 — and
--                  is counted on ai_usage_months)
--   provider_cost  sum(cost_amount), any status — what the providers charged us
--   billed         sum(billed_amount), any status — the marked-up price; this is
--                  exactly what platform_ai_month_spend() summed for the ceiling
--   everyday / careful   ok runs by tier ('careful' vs anything else)
-- With p_breakdown = true it also returns
--   charged        what the debit_ai wallet entries took for these runs
--                  (sum(-amount), as trg_ai_runs_billing freezes it) — the
--                  revenue side of /admin/billing's AI margin
--   by_org_month   the same figures per workspace and Asia/Kolkata month
-- (otherwise charged is null and by_org_month is []), so the ceiling check
-- made before every AI run stays one aggregate scan.
--
-- STABLE: both statements see the calling query's snapshot, so the totals and
-- the breakdown always add up. Server-only: called with the service-role
-- client; anon and authenticated never get EXECUTE.
--
-- Until this is applied the app reads PGRST202: /admin/ai and the AI runs
-- dialog show the totals as unavailable with that reason, /admin/billing keeps
-- the frozen ai_usage_months totals and says so, and the platform ceiling
-- falls back to platform_ai_month_spend() exactly as before.

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.ai_cost_totals(
  p_from timestamptz,
  p_to timestamptz DEFAULT NULL,
  p_org uuid DEFAULT NULL,
  p_breakdown boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  totals jsonb;
  groups jsonb := '[]'::jsonb;
  charged numeric := NULL;
BEGIN
  IF p_from IS NULL THEN
    RAISE EXCEPTION 'ai_cost_totals: p_from is required' USING ERRCODE = '22004';
  END IF;

  SELECT jsonb_build_object(
           'runs', count(*),
           'ok_runs', count(*) FILTER (WHERE r.status = 'ok'),
           'provider_cost', COALESCE(sum(r.cost_amount), 0),
           'billed', COALESCE(sum(r.billed_amount), 0),
           'everyday', count(*) FILTER (WHERE r.status = 'ok' AND r.tier IS DISTINCT FROM 'careful'),
           'careful', count(*) FILTER (WHERE r.status = 'ok' AND r.tier = 'careful')
         )
    INTO totals
    FROM public.ai_runs r
   WHERE r.created_at >= p_from
     AND (p_to IS NULL OR r.created_at < p_to)
     AND (p_org IS NULL OR r.organization_id = p_org);

  IF p_breakdown THEN
    SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY g.organization_id, g.month), '[]'::jsonb),
           COALESCE(sum(g.charged), 0)
      INTO groups, charged
      FROM (
        SELECT r.organization_id,
               to_char(r.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month,
               count(*) AS runs,
               count(*) FILTER (WHERE r.status = 'ok') AS ok_runs,
               COALESCE(sum(r.cost_amount), 0) AS provider_cost,
               COALESCE(sum(r.billed_amount), 0) AS billed,
               COALESCE(sum(d.charged), 0) AS charged,
               count(*) FILTER (WHERE r.status = 'ok' AND r.tier IS DISTINCT FROM 'careful') AS everyday,
               count(*) FILTER (WHERE r.status = 'ok' AND r.tier = 'careful') AS careful
          FROM public.ai_runs r
          LEFT JOIN LATERAL (
            SELECT sum(-l.amount) AS charged
              FROM public.wallet_ledger l
             WHERE l.reference_type = 'ai_run'
               AND l.reference_id = r.id
               AND l.entry_type = 'debit_ai'
          ) d ON true
         WHERE r.created_at >= p_from
           AND (p_to IS NULL OR r.created_at < p_to)
           AND (p_org IS NULL OR r.organization_id = p_org)
         GROUP BY 1, 2
      ) g;
  END IF;

  RETURN totals || jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'organization_id', p_org,
    'charged', charged,
    'by_org_month', groups
  );
END
$$;

REVOKE ALL ON FUNCTION public.ai_cost_totals(timestamptz, timestamptz, uuid, boolean) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_cost_totals(timestamptz, timestamptz, uuid, boolean) TO service_role;

RESET lock_timeout;

-- Read-only checks once applied:
--   select has_function_privilege('anon', 'public.ai_cost_totals(timestamptz, timestamptz, uuid, boolean)', 'execute'),
--          has_function_privilege('authenticated', 'public.ai_cost_totals(timestamptz, timestamptz, uuid, boolean)', 'execute');
--   -- false | false
--   select public.ai_cost_totals(now() - interval '30 days') ->> 'provider_cost';
--   -- the real 30-day provider cost (~830 on 8 Oct), not 22.01
--   select (public.ai_cost_totals(date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata') ->> 'billed')::numeric
--          = public.platform_ai_month_spend();   -- true: the ceiling reads the same sum
