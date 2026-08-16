-- Event spine, usage meters and the AI tool column.
-- Capture only: existing analytics RPCs keep reading the entity tables.

-- ============================================================ analytics_events
CREATE TABLE IF NOT EXISTS public.analytics_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  whatsapp_account_id uuid REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analytics_events_org_type_time_idx
  ON public.analytics_events (organization_id, event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_org_time_idx
  ON public.analytics_events (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS analytics_events_properties_idx
  ON public.analytics_events USING gin (properties);

-- Reads are for people holding analytics.view; every write is service role.
GRANT SELECT ON public.analytics_events TO authenticated;
GRANT ALL ON public.analytics_events TO service_role;
ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "analytics_events_select" ON public.analytics_events;
CREATE POLICY "analytics_events_select" ON public.analytics_events
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'analytics.view') OR public.is_super_admin());

-- ============================================================== usage_records
CREATE TABLE IF NOT EXISTS public.usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  meter_key text NOT NULL,
  quantity numeric NOT NULL DEFAULT 1,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS usage_records_org_meter_time_idx
  ON public.usage_records (organization_id, meter_key, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_records_org_time_idx
  ON public.usage_records (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_records_metadata_idx
  ON public.usage_records USING gin (metadata);

GRANT SELECT ON public.usage_records TO authenticated;
GRANT ALL ON public.usage_records TO service_role;
ALTER TABLE public.usage_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "usage_records_select" ON public.usage_records;
CREATE POLICY "usage_records_select" ON public.usage_records
  FOR SELECT TO authenticated
  USING (
    public.has_permission(organization_id, 'analytics.view')
    OR public.has_permission(organization_id, 'billing.manage')
    OR public.is_super_admin()
  );

-- Rollup by organization and calendar-month billing period. security_invoker
-- keeps the reader's RLS in force.
CREATE OR REPLACE VIEW public.usage_rollup
WITH (security_invoker = true) AS
  SELECT
    organization_id,
    meter_key,
    date_trunc('month', occurred_at) AS period_start,
    (date_trunc('month', occurred_at) + interval '1 month') AS period_end,
    sum(quantity) AS quantity,
    count(*) AS record_count,
    max(occurred_at) AS last_recorded_at
  FROM public.usage_records
  GROUP BY organization_id, meter_key, date_trunc('month', occurred_at);

GRANT SELECT ON public.usage_rollup TO authenticated, service_role;

-- ===================================================== AI tools on the registry
ALTER TABLE public.feature_registry
  ADD COLUMN IF NOT EXISTS ai_tools jsonb NOT NULL DEFAULT '[]'::jsonb;
