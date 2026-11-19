-- Batch 82 (NOT applied; to be applied by hand after review): the /199 paid
-- trial — ₹199 for 30 days of Basic, our team calls and converts.
-- Additive and idempotent: one nullable column, one partial index, and the
-- demo_leads rule extended to the new source. No backfill (a NULL period
-- means no banner and no Renewals row, exactly as today).
--
--   (1) organizations.plan_period_ends_at: when a paid plan's access period
--       ends. Every successful plan_fee payment adds 30 days
--       (src/lib/plan-period.server.ts, once per payment). Nothing locks on
--       it; it drives the in-app banner and Admin → Renewals due.
--   (2) demo_leads: source 'landing_199' joins 'landing_start' and
--       'landing_999' in the Batch 72 rule (a checkout lead has no
--       qualification answers).
--
-- The code works without this file: the period read/write fails quietly
-- (plan-period.server.ts logs "read_failed" and changes nothing), and the
-- banner / Renewals list read nothing.

-- (1) ------------------------------------------------- the access period
ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS plan_period_ends_at timestamptz;

CREATE INDEX IF NOT EXISTS organizations_plan_period_ends_at_idx
  ON public.organizations (plan_period_ends_at)
  WHERE plan_period_ends_at IS NOT NULL;

-- (2) ------------------------------------------------------------ demo_leads
ALTER TABLE public.demo_leads DROP CONSTRAINT IF EXISTS demo_leads_qualified_unless_landing_start;
ALTER TABLE public.demo_leads DROP CONSTRAINT IF EXISTS demo_leads_qualified_unless_landing;
ALTER TABLE public.demo_leads
  ADD CONSTRAINT demo_leads_qualified_unless_landing CHECK (
    source IN ('landing_start', 'landing_999', 'landing_199')
    OR (
      business_type IS NOT NULL
      AND enquiry_band IS NOT NULL
      AND primary_need IS NOT NULL
      AND name IS NOT NULL
      AND business_name IS NOT NULL
    )
  );

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
