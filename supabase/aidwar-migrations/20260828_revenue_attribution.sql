-- Revenue attribution: link orders back to the message that plausibly caused them.
--
-- Model: last touch, windowed. When an order arrives we look back over the
-- attribution window for the most recent *sent* outbound marketing message to
-- that contact that came from a campaign or a flow. If there isn't one we write
-- nothing — "we couldn't link this sale to any message" is a real answer and
-- must never be papered over with a default attribution.

-- ------------------------------------------------------------ 1. message attribution columns
ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES public.campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS flow_id uuid REFERENCES public.flows(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS flow_step_id uuid REFERENCES public.flow_steps(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS scheduled_send_id uuid REFERENCES public.scheduled_sends(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_campaign_idx ON public.messages (campaign_id) WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_flow_idx ON public.messages (flow_id) WHERE flow_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_outbound_created_idx
  ON public.messages (organization_id, created_at DESC)
  WHERE direction = 'outbound';

-- Backfill what can be reconstructed: campaign sends via campaign_recipients,
-- flow sends via scheduled_sends.
UPDATE public.messages m
SET campaign_id = r.campaign_id
FROM public.campaign_recipients r
WHERE r.message_id = m.id AND m.campaign_id IS NULL;

UPDATE public.messages m
SET flow_id = s.flow_id, flow_step_id = s.flow_step_id, scheduled_send_id = s.id
FROM public.scheduled_sends s
WHERE s.message_id = m.id AND m.flow_id IS NULL;

-- ------------------------------------------------------------ 2. per-org attribution window
ALTER TABLE public.organization_send_settings
  ADD COLUMN IF NOT EXISTS attribution_window_hours integer NOT NULL DEFAULT 72;

ALTER TABLE public.organization_send_settings
  DROP CONSTRAINT IF EXISTS organization_send_settings_attribution_window_check;
ALTER TABLE public.organization_send_settings
  ADD CONSTRAINT organization_send_settings_attribution_window_check
  CHECK (attribution_window_hours BETWEEN 1 AND 720);

-- ------------------------------------------------------------ 3. revenue_attributions
CREATE TABLE IF NOT EXISTS public.revenue_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  source_type text NOT NULL CHECK (source_type IN ('campaign','flow')),
  source_id uuid,
  attributed_at timestamptz NOT NULL DEFAULT now(),
  order_total numeric,
  currency text,
  hours_to_conversion numeric,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS revenue_attributions_org_idx
  ON public.revenue_attributions (organization_id, attributed_at DESC);
CREATE INDEX IF NOT EXISTS revenue_attributions_source_idx
  ON public.revenue_attributions (organization_id, source_type, source_id);

GRANT SELECT ON public.revenue_attributions TO authenticated;
GRANT ALL ON public.revenue_attributions TO service_role;

ALTER TABLE public.revenue_attributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "revenue_attributions_select_members" ON public.revenue_attributions;
CREATE POLICY "revenue_attributions_select_members" ON public.revenue_attributions
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'analytics.view'));

DROP TRIGGER IF EXISTS revenue_attributions_updated_at ON public.revenue_attributions;
CREATE TRIGGER revenue_attributions_updated_at
  BEFORE UPDATE ON public.revenue_attributions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ------------------------------------------------------------ 4. attribution logic
CREATE OR REPLACE FUNCTION public.attribute_order(p_order_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  o record;
  m record;
  window_hours integer;
  attribution_id uuid;
BEGIN
  SELECT id, organization_id, contact_id, total, currency, placed_at, cancelled_at
    INTO o
  FROM public.orders WHERE id = p_order_id;

  IF o.id IS NULL OR o.contact_id IS NULL OR o.placed_at IS NULL OR o.cancelled_at IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(s.attribution_window_hours, 72) INTO window_hours
  FROM public.organization_send_settings s
  WHERE s.organization_id = o.organization_id;
  window_hours := COALESCE(window_hours, 72);

  -- Last touch: most recent qualifying message before the order.
  --  * actually sent (pending / failed / skipped never earn credit)
  --  * from a campaign or a flow (a hand-typed inbox reply is not a channel)
  --  * marketing class only — an order confirmation cannot cause its own order
  SELECT m2.id, m2.created_at, m2.campaign_id, m2.flow_id
    INTO m
  FROM public.messages m2
  JOIN public.conversations c ON c.id = m2.conversation_id
  WHERE m2.organization_id = o.organization_id
    AND c.contact_id = o.contact_id
    AND m2.direction = 'outbound'
    AND m2.status IN ('sent','delivered','read')
    AND (m2.campaign_id IS NOT NULL OR m2.flow_id IS NOT NULL)
    AND m2.created_at <= o.placed_at
    AND m2.created_at >= o.placed_at - make_interval(hours => window_hours)
    AND EXISTS (
      SELECT 1 FROM public.message_templates t
      WHERE t.organization_id = o.organization_id
        AND t.name = m2.template_name
        AND UPPER(COALESCE(t.category, '')) = 'MARKETING'
    )
  ORDER BY m2.created_at DESC
  LIMIT 1;

  IF m.id IS NULL THEN
    -- Unattributed is a real answer: leave no row behind.
    DELETE FROM public.revenue_attributions WHERE order_id = p_order_id;
    RETURN NULL;
  END IF;

  INSERT INTO public.revenue_attributions AS ra (
    organization_id, order_id, contact_id, message_id, source_type, source_id,
    attributed_at, order_total, currency, hours_to_conversion
  ) VALUES (
    o.organization_id, o.id, o.contact_id, m.id,
    CASE WHEN m.campaign_id IS NOT NULL THEN 'campaign' ELSE 'flow' END,
    COALESCE(m.campaign_id, m.flow_id),
    o.placed_at, o.total, o.currency,
    ROUND(EXTRACT(EPOCH FROM (o.placed_at - m.created_at))::numeric / 3600.0, 2)
  )
  ON CONFLICT (order_id) DO UPDATE SET
    contact_id = EXCLUDED.contact_id,
    message_id = EXCLUDED.message_id,
    source_type = EXCLUDED.source_type,
    source_id = EXCLUDED.source_id,
    attributed_at = EXCLUDED.attributed_at,
    order_total = EXCLUDED.order_total,
    currency = EXCLUDED.currency,
    hours_to_conversion = EXCLUDED.hours_to_conversion
  RETURNING ra.id INTO attribution_id;

  RETURN attribution_id;
END;
$$;

REVOKE ALL ON FUNCTION public.attribute_order(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.attribute_order(uuid) TO service_role;

-- Live attribution: every ingested or updated order re-evaluates itself.
CREATE OR REPLACE FUNCTION public.orders_attribute_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public.attribute_order(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_attribute ON public.orders;
CREATE TRIGGER orders_attribute
  AFTER INSERT OR UPDATE OF placed_at, contact_id, total, cancelled_at ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.orders_attribute_trigger();

-- One-time (and re-runnable) backfill over orders already ingested.
CREATE OR REPLACE FUNCTION public.backfill_revenue_attributions(p_organization_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  linked integer := 0;
BEGIN
  FOR r IN
    SELECT id FROM public.orders
    WHERE p_organization_id IS NULL OR organization_id = p_organization_id
    ORDER BY placed_at
  LOOP
    IF public.attribute_order(r.id) IS NOT NULL THEN
      linked := linked + 1;
    END IF;
  END LOOP;
  RETURN linked;
END;
$$;

REVOKE ALL ON FUNCTION public.backfill_revenue_attributions(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.backfill_revenue_attributions(uuid) TO service_role;

-- ------------------------------------------------------------ 5. reporting RPCs
-- Attributed vs unattributed for the period, so coverage is visible rather than
-- implied. Message counts come from the messages table so "revenue per message
-- sent" is honest even when no cost data exists.
CREATE OR REPLACE FUNCTION public.analytics_attribution_summary(
  p_organization_id uuid, p_from date, p_to date, p_whatsapp_account_id uuid DEFAULT NULL
)
RETURNS jsonb
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
  result jsonb;
BEGIN
  SELECT starts_at, ends_at INTO cur_start, cur_end
  FROM public.analytics_window(tz, p_from, p_to);

  SELECT jsonb_build_object(
    'timezone', tz,
    'from', p_from,
    'to', p_to,
    'window_hours', COALESCE(
      (SELECT s.attribution_window_hours FROM public.organization_send_settings s
        WHERE s.organization_id = p_organization_id), 72),
    'currency', (
      SELECT o.currency FROM public.orders o
      WHERE o.organization_id = p_organization_id
        AND o.placed_at >= cur_start AND o.placed_at < cur_end
        AND o.currency IS NOT NULL
      GROUP BY o.currency ORDER BY COUNT(*) DESC LIMIT 1),
    'orders_total', COALESCE(t.orders_total, 0),
    'revenue_total', COALESCE(t.revenue_total, 0),
    'orders_attributed', COALESCE(t.orders_attributed, 0),
    'revenue_attributed', COALESCE(t.revenue_attributed, 0),
    'orders_unattributed', COALESCE(t.orders_total, 0) - COALESCE(t.orders_attributed, 0),
    'revenue_unattributed', COALESCE(t.revenue_total, 0) - COALESCE(t.revenue_attributed, 0),
    'median_hours_to_conversion', t.median_hours,
    'messages_sent', COALESCE((
      SELECT COUNT(*) FROM public.messages m
      LEFT JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.organization_id = p_organization_id
        AND m.direction = 'outbound'
        AND m.status IN ('sent','delivered','read')
        AND (m.campaign_id IS NOT NULL OR m.flow_id IS NOT NULL)
        AND m.created_at >= cur_start AND m.created_at < cur_end
        AND (p_whatsapp_account_id IS NULL OR c.whatsapp_account_id = p_whatsapp_account_id)
    ), 0)
  ) INTO result
  FROM (
    SELECT
      COUNT(o.id) AS orders_total,
      COALESCE(SUM(o.total), 0) AS revenue_total,
      COUNT(ra.id) AS orders_attributed,
      COALESCE(SUM(o.total) FILTER (WHERE ra.id IS NOT NULL), 0) AS revenue_attributed,
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ra.hours_to_conversion) AS median_hours
    FROM public.orders o
    LEFT JOIN public.revenue_attributions ra ON ra.order_id = o.id
    WHERE o.organization_id = p_organization_id
      AND o.cancelled_at IS NULL
      AND o.placed_at >= cur_start AND o.placed_at < cur_end
  ) t;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_attribution_summary(uuid, date, date, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_attribution_summary(uuid, date, date, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analytics_attribution_sources(
  p_organization_id uuid, p_from date, p_to date, p_whatsapp_account_id uuid DEFAULT NULL
)
RETURNS TABLE (
  source_type text, source_id uuid, name text,
  messages_sent bigint, orders bigint, revenue numeric,
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
  WITH sends AS (
    SELECT
      CASE WHEN m.campaign_id IS NOT NULL THEN 'campaign' ELSE 'flow' END AS source_type,
      COALESCE(m.campaign_id, m.flow_id) AS source_id,
      COUNT(*) AS messages_sent
    FROM public.messages m
    LEFT JOIN public.conversations c ON c.id = m.conversation_id
    WHERE m.organization_id = p_organization_id
      AND m.direction = 'outbound'
      AND m.status IN ('sent','delivered','read')
      AND (m.campaign_id IS NOT NULL OR m.flow_id IS NOT NULL)
      AND m.created_at >= cur_start AND m.created_at < cur_end
      AND (p_whatsapp_account_id IS NULL OR c.whatsapp_account_id = p_whatsapp_account_id)
    GROUP BY 1, 2
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
  merged AS (
    SELECT COALESCE(s.source_type, x.source_type) AS source_type,
           COALESCE(s.source_id, x.source_id) AS source_id,
           COALESCE(s.messages_sent, 0) AS messages_sent,
           COALESCE(x.orders, 0) AS orders,
           COALESCE(x.revenue, 0) AS revenue,
           x.median_hours,
           x.currency
    FROM sends s
    FULL OUTER JOIN sales x
      ON x.source_type = s.source_type AND x.source_id = s.source_id
  )
  SELECT g.source_type, g.source_id,
    COALESCE(
      (SELECT c.name FROM public.campaigns c WHERE c.id = g.source_id),
      (SELECT f.name FROM public.flows f WHERE f.id = g.source_id),
      'Unknown'
    )::text,
    g.messages_sent, g.orders, g.revenue::numeric, ROUND(g.median_hours::numeric, 1), g.currency
  FROM merged g
  ORDER BY g.revenue DESC, g.messages_sent DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_attribution_sources(uuid, date, date, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_attribution_sources(uuid, date, date, uuid)
  TO authenticated, service_role;
