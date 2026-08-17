-- Message cost, and the reporting behind the Receipts page.
--
-- Meta bills per *delivered* message, and the amount depends on the country,
-- the template category and whether a service window was already open. So cost
-- is never derived by counting sends: it comes from the pricing object Meta
-- sends on the status webhook, priced against a rate row that is data, not
-- code — Meta revises rates and every country differs.

-- ------------------------------------------------------------ 1. rate card
CREATE TABLE IF NOT EXISTS public.message_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ISO 3166-1 alpha-2, e.g. 'IN'.
  country_code text NOT NULL,
  -- E.164 calling code without '+', e.g. '91'. Used to price a phone number.
  dial_code text NOT NULL,
  category text NOT NULL CHECK (category IN ('marketing','utility','authentication','service')),
  rate numeric NOT NULL CHECK (rate >= 0),
  currency text NOT NULL,
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS message_rates_unique_period_idx
  ON public.message_rates (country_code, category, effective_from);
CREATE INDEX IF NOT EXISTS message_rates_lookup_idx
  ON public.message_rates (dial_code, category, effective_from DESC);

GRANT SELECT ON public.message_rates TO authenticated;
GRANT ALL ON public.message_rates TO service_role;

ALTER TABLE public.message_rates ENABLE ROW LEVEL SECURITY;

-- The rate card is platform reference data, not tenant data: readable by any
-- signed-in member, writable only by the platform.
DROP POLICY IF EXISTS "message_rates_select_authenticated" ON public.message_rates;
CREATE POLICY "message_rates_select_authenticated" ON public.message_rates
  FOR SELECT TO authenticated USING (true);

DROP TRIGGER IF EXISTS message_rates_updated_at ON public.message_rates;
CREATE TRIGGER message_rates_updated_at
  BEFORE UPDATE ON public.message_rates
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.message_rates (country_code, dial_code, category, rate, currency, effective_from)
VALUES
  ('IN', '91', 'marketing',      0.8631, 'INR', DATE '2026-01-01'),
  ('IN', '91', 'utility',        0.115,  'INR', DATE '2026-01-01'),
  ('IN', '91', 'authentication', 0.115,  'INR', DATE '2026-01-01'),
  ('IN', '91', 'service',        0,      'INR', DATE '2026-01-01')
ON CONFLICT (country_code, category, effective_from) DO NOTHING;

-- ------------------------------------------------------------ 2. what Meta charged
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS billable boolean,
  ADD COLUMN IF NOT EXISTS pricing_model text,
  ADD COLUMN IF NOT EXISTS pricing_category text,
  ADD COLUMN IF NOT EXISTS cost_amount numeric,
  ADD COLUMN IF NOT EXISTS cost_currency text;

CREATE INDEX IF NOT EXISTS messages_cost_idx
  ON public.messages (organization_id, created_at DESC)
  WHERE direction = 'outbound';

-- India charges GST on top of Meta's rate. It is configurable because it is
-- India-specific, not universal.
ALTER TABLE public.organization_send_settings
  ADD COLUMN IF NOT EXISTS gst_percent numeric NOT NULL DEFAULT 18;

ALTER TABLE public.organization_send_settings
  DROP CONSTRAINT IF EXISTS organization_send_settings_gst_percent_check;
ALTER TABLE public.organization_send_settings
  ADD CONSTRAINT organization_send_settings_gst_percent_check
  CHECK (gst_percent >= 0 AND gst_percent <= 100);

-- Campaign sends have no scheduled_sends row, so a clicked link records its
-- campaign directly.
ALTER TABLE public.short_links
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL;

-- ------------------------------------------------------------ 3. rate lookup
-- Longest matching dial code wins, so '1' never prices a '1868' number.
CREATE OR REPLACE FUNCTION public.message_rate_for(
  p_phone text, p_category text, p_at timestamptz DEFAULT now()
)
RETURNS TABLE (rate numeric, currency text, country_code text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.rate, r.currency, r.country_code
  FROM public.message_rates r
  WHERE REGEXP_REPLACE(COALESCE(p_phone, ''), '\D', '', 'g') LIKE r.dial_code || '%'
    AND r.category = LOWER(COALESCE(p_category, ''))
    AND r.effective_from <= (p_at AT TIME ZONE 'UTC')::date
    AND (r.effective_to IS NULL OR r.effective_to > (p_at AT TIME ZONE 'UTC')::date)
  ORDER BY LENGTH(r.dial_code) DESC, r.effective_from DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.message_rate_for(text, text, timestamptz) FROM public;
GRANT EXECUTE ON FUNCTION public.message_rate_for(text, text, timestamptz)
  TO authenticated, service_role;

-- Prices one message from the pricing Meta reported. Returns true when a cost
-- was written; false means no rate matched — the caller must warn rather than
-- guess a number.
CREATE OR REPLACE FUNCTION public.price_message(p_message_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m record;
  phone text;
  found record;
BEGIN
  SELECT id, conversation_id, billable, pricing_category, status, created_at, cost_amount
    INTO m
  FROM public.messages WHERE id = p_message_id;

  IF m.id IS NULL THEN RETURN false; END IF;

  -- Only billable, actually-delivered messages cost anything. A utility message
  -- inside an open service window is free, and Meta says so on the webhook.
  IF COALESCE(m.billable, false) = false THEN
    UPDATE public.messages SET cost_amount = 0, cost_currency = COALESCE(cost_currency, 'INR')
    WHERE id = m.id AND cost_amount IS DISTINCT FROM 0;
    RETURN true;
  END IF;

  IF m.status NOT IN ('delivered','read') THEN RETURN true; END IF;

  SELECT c2.phone INTO phone
  FROM public.conversations cv
  JOIN public.contacts c2 ON c2.id = cv.contact_id
  WHERE cv.id = m.conversation_id;

  SELECT * INTO found FROM public.message_rate_for(phone, m.pricing_category, m.created_at);

  IF found.rate IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.messages
  SET cost_amount = found.rate, cost_currency = found.currency
  WHERE id = m.id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.price_message(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.price_message(uuid) TO service_role;

-- ------------------------------------------------------------ 4. reporting
-- Extends the existing attribution reporting rather than adding a second
-- stack: the same function the Sales tab already reads now also returns the
-- delivery funnel, clicks and spend.
DROP FUNCTION IF EXISTS public.analytics_attribution_sources(uuid, date, date, uuid);

CREATE OR REPLACE FUNCTION public.analytics_attribution_sources(
  p_organization_id uuid, p_from date, p_to date, p_whatsapp_account_id uuid DEFAULT NULL
)
RETURNS TABLE (
  source_type text, source_id uuid, name text, created_at timestamptz,
  messages_sent bigint, delivered bigint, read_count bigint, clicked bigint,
  orders bigint, revenue numeric,
  spent numeric, cost_complete boolean,
  median_hours numeric, currency text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  tz text := public.analytics_guard(p_organization_id);
  cur_start timestamptz;
  cur_end timestamptz;
BEGIN
  SELECT starts_at, ends_at INTO cur_start, cur_end
  FROM public.analytics_window(tz, p_from, p_to);

  RETURN QUERY
  WITH msgs AS (
    SELECT
      CASE WHEN m.campaign_id IS NOT NULL THEN 'campaign' ELSE 'flow' END AS source_type,
      COALESCE(m.campaign_id, m.flow_id) AS source_id,
      m.id AS message_id,
      m.status,
      m.billable,
      m.cost_amount
    FROM public.messages m
    LEFT JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.organization_id = p_organization_id
      AND m.direction = 'outbound'
      AND (m.campaign_id IS NOT NULL OR m.flow_id IS NOT NULL)
      AND m.created_at >= cur_start AND m.created_at < cur_end
      AND (p_whatsapp_account_id IS NULL OR c.whatsapp_account_id = p_whatsapp_account_id)
  ),
  spend AS (
    SELECT source_type, source_id,
      COALESCE(SUM(cost_amount), 0) AS spent,
      -- A row whose messages have no billable verdict yet cannot show a final
      -- cost, and must never present a partial figure as complete.
      BOOL_AND(billable IS NOT NULL OR status NOT IN ('sent','delivered','read')) AS cost_complete
    FROM msgs GROUP BY 1, 2
  ),
  funnel AS (
    SELECT
      CASE WHEN e.properties->>'campaign_id' IS NOT NULL THEN 'campaign' ELSE 'flow' END AS source_type,
      COALESCE(
        NULLIF(e.properties->>'campaign_id','')::uuid,
        NULLIF(e.properties->>'flow_id','')::uuid
      ) AS source_id,
      COUNT(DISTINCT e.properties->>'message_id')
        FILTER (WHERE e.event_type = 'message.sent') AS sent,
      COUNT(DISTINCT e.properties->>'message_id')
        FILTER (WHERE e.event_type = 'message.delivered') AS delivered,
      COUNT(DISTINCT e.properties->>'message_id')
        FILTER (WHERE e.event_type = 'message.read') AS read_count,
      COUNT(DISTINCT COALESCE(e.properties->>'scheduled_send_id', e.id::text))
        FILTER (WHERE e.event_type = 'flow.clicked') AS clicked
    FROM public.analytics_events e
    WHERE e.organization_id = p_organization_id
      AND e.event_type IN ('message.sent','message.delivered','message.read','flow.clicked')
      AND e.occurred_at >= cur_start AND e.occurred_at < cur_end
      AND (NULLIF(e.properties->>'campaign_id','') IS NOT NULL
        OR NULLIF(e.properties->>'flow_id','') IS NOT NULL)
      AND (p_whatsapp_account_id IS NULL
        OR NULLIF(e.properties->>'whatsapp_account_id','')::uuid = p_whatsapp_account_id)
    GROUP BY 1, 2
  ),
  sends AS (
    SELECT source_type, source_id, COUNT(*) AS messages_sent
    FROM msgs WHERE status IN ('sent','delivered','read') GROUP BY 1, 2
  ),
  sales AS (
    SELECT ra.source_type, ra.source_id,
      COUNT(*) AS orders,
      COALESCE(SUM(ra.order_total), 0) AS revenue,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ra.hours_to_conversion) AS median_hours,
      (ARRAY_AGG(ra.currency ORDER BY ra.attributed_at DESC))[1] AS currency
    FROM public.revenue_attributions ra
    WHERE ra.organization_id = p_organization_id
      AND ra.attributed_at >= cur_start AND ra.attributed_at < cur_end
    GROUP BY 1, 2
  ),
  keys AS (
    SELECT source_type, source_id FROM sends
    UNION SELECT source_type, source_id FROM sales
    UNION SELECT source_type, source_id FROM funnel
  )
  SELECT
    k.source_type,
    k.source_id,
    COALESCE(
      (SELECT c.name FROM public.campaigns c WHERE c.id = k.source_id),
      (SELECT f.name FROM public.flows f WHERE f.id = k.source_id),
      'Unknown'
    )::text,
    COALESCE(
      (SELECT c.created_at FROM public.campaigns c WHERE c.id = k.source_id),
      (SELECT f.created_at FROM public.flows f WHERE f.id = k.source_id)
    ),
    COALESCE(s.messages_sent, 0),
    COALESCE(fn.delivered, 0),
    COALESCE(fn.read_count, 0),
    COALESCE(fn.clicked, 0),
    COALESCE(x.orders, 0),
    COALESCE(x.revenue, 0)::numeric,
    COALESCE(sp.spent, 0)::numeric,
    COALESCE(sp.cost_complete, true),
    ROUND(x.median_hours::numeric, 1),
    x.currency
  FROM keys k
  LEFT JOIN sends s ON s.source_type = k.source_type AND s.source_id = k.source_id
  LEFT JOIN sales x ON x.source_type = k.source_type AND x.source_id = k.source_id
  LEFT JOIN funnel fn ON fn.source_type = k.source_type AND fn.source_id = k.source_id
  LEFT JOIN spend sp ON sp.source_type = k.source_type AND sp.source_id = k.source_id
  WHERE k.source_id IS NOT NULL
  ORDER BY COALESCE(x.revenue, 0) DESC, COALESCE(s.messages_sent, 0) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_attribution_sources(uuid, date, date, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_attribution_sources(uuid, date, date, uuid)
  TO authenticated, service_role;

-- Per-step detail, so a flow row can be opened up. Campaigns have one step by
-- nature and return a single row keyed on the template that was sent.
CREATE OR REPLACE FUNCTION public.analytics_attribution_steps(
  p_organization_id uuid, p_from date, p_to date, p_whatsapp_account_id uuid DEFAULT NULL
)
RETURNS TABLE (
  source_type text, source_id uuid, step_id uuid, step_order integer, name text,
  messages_sent bigint, delivered bigint, read_count bigint, clicked bigint,
  orders bigint, revenue numeric, spent numeric, cost_complete boolean, currency text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  tz text := public.analytics_guard(p_organization_id);
  cur_start timestamptz;
  cur_end timestamptz;
BEGIN
  SELECT starts_at, ends_at INTO cur_start, cur_end
  FROM public.analytics_window(tz, p_from, p_to);

  RETURN QUERY
  WITH msgs AS (
    SELECT
      CASE WHEN m.campaign_id IS NOT NULL THEN 'campaign' ELSE 'flow' END AS source_type,
      COALESCE(m.campaign_id, m.flow_id) AS source_id,
      m.flow_step_id AS step_id,
      COALESCE(m.template_name, 'Message') AS template_name,
      m.id AS message_id,
      m.status, m.billable, m.cost_amount, m.cost_currency
    FROM public.messages m
    LEFT JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.organization_id = p_organization_id
      AND m.direction = 'outbound'
      AND (m.campaign_id IS NOT NULL OR m.flow_id IS NOT NULL)
      AND m.created_at >= cur_start AND m.created_at < cur_end
      AND (p_whatsapp_account_id IS NULL OR c.whatsapp_account_id = p_whatsapp_account_id)
  ),
  agg AS (
    SELECT source_type, source_id, step_id,
      MIN(template_name) AS template_name,
      COUNT(*) FILTER (WHERE status IN ('sent','delivered','read')) AS messages_sent,
      COUNT(*) FILTER (WHERE status IN ('delivered','read')) AS delivered,
      COUNT(*) FILTER (WHERE status = 'read') AS read_count,
      COALESCE(SUM(cost_amount), 0) AS spent,
      BOOL_AND(billable IS NOT NULL OR status NOT IN ('sent','delivered','read')) AS cost_complete,
      (ARRAY_AGG(cost_currency) FILTER (WHERE cost_currency IS NOT NULL))[1] AS currency
    FROM msgs GROUP BY 1, 2, 3
  ),
  clicks AS (
    SELECT
      NULLIF(e.properties->>'flow_step_id','')::uuid AS step_id,
      COALESCE(
        NULLIF(e.properties->>'campaign_id','')::uuid,
        NULLIF(e.properties->>'flow_id','')::uuid
      ) AS source_id,
      COUNT(DISTINCT COALESCE(e.properties->>'scheduled_send_id', e.id::text)) AS clicked
    FROM public.analytics_events e
    WHERE e.organization_id = p_organization_id
      AND e.event_type = 'flow.clicked'
      AND e.occurred_at >= cur_start AND e.occurred_at < cur_end
    GROUP BY 1, 2
  ),
  sales AS (
    SELECT m2.flow_step_id AS step_id, ra.source_type, ra.source_id,
      COUNT(*) AS orders, COALESCE(SUM(ra.order_total), 0) AS revenue
    FROM public.revenue_attributions ra
    LEFT JOIN public.messages m2 ON m2.id = ra.message_id
    WHERE ra.organization_id = p_organization_id
      AND ra.attributed_at >= cur_start AND ra.attributed_at < cur_end
    GROUP BY 1, 2, 3
  )
  SELECT a.source_type, a.source_id, a.step_id,
    (SELECT fs.step_order FROM public.flow_steps fs WHERE fs.id = a.step_id),
    a.template_name::text,
    a.messages_sent, a.delivered, a.read_count,
    COALESCE(cl.clicked, 0),
    COALESCE(sa.orders, 0), COALESCE(sa.revenue, 0)::numeric,
    a.spent::numeric, COALESCE(a.cost_complete, true), a.currency
  FROM agg a
  LEFT JOIN clicks cl
    ON cl.source_id = a.source_id AND cl.step_id IS NOT DISTINCT FROM a.step_id
  LEFT JOIN sales sa
    ON sa.source_id = a.source_id AND sa.source_type = a.source_type
   AND sa.step_id IS NOT DISTINCT FROM a.step_id
  WHERE a.source_id IS NOT NULL
  ORDER BY a.source_id, COALESCE((SELECT fs.step_order FROM public.flow_steps fs WHERE fs.id = a.step_id), 0);
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_attribution_steps(uuid, date, date, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_attribution_steps(uuid, date, date, uuid)
  TO authenticated, service_role;
