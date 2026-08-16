-- Analytics: quality history table, indexes and SECURITY DEFINER aggregation RPCs.
-- Every RPC takes (p_organization_id, p_from, p_to) and gates on
-- has_permission(org, 'analytics.view'). All bucketing happens in the
-- organization's own timezone. Signatures are stable so a nightly rollup can
-- later slot in behind them without touching callers.

-- ---------------------------------------------------------------- quality history
CREATE TABLE IF NOT EXISTS public.whatsapp_quality_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  phone_number_id text,
  quality_rating text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.whatsapp_quality_history TO authenticated;
GRANT ALL ON public.whatsapp_quality_history TO service_role;
ALTER TABLE public.whatsapp_quality_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "quality_history_select_members" ON public.whatsapp_quality_history;
CREATE POLICY "quality_history_select_members" ON public.whatsapp_quality_history
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'analytics.view'));

CREATE INDEX IF NOT EXISTS whatsapp_quality_history_org_idx
  ON public.whatsapp_quality_history (organization_id, recorded_at DESC);

-- ---------------------------------------------------------------- indexes
CREATE INDEX IF NOT EXISTS messages_org_created_idx
  ON public.messages (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_org_direction_status_idx
  ON public.messages (organization_id, direction, status);
CREATE INDEX IF NOT EXISTS campaign_recipients_org_status_idx
  ON public.campaign_recipients (organization_id, status);

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION public.analytics_guard(p_organization_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  tz text;
BEGIN
  IF NOT public.has_permission(p_organization_id, 'analytics.view') THEN
    RAISE EXCEPTION 'You need the "View analytics" permission for this workspace.'
      USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(o.timezone, 'UTC') INTO tz
  FROM public.organizations o WHERE o.id = p_organization_id;
  RETURN COALESCE(tz, 'UTC');
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_guard(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_guard(uuid) TO authenticated, service_role;

-- Local date window -> absolute timestamp range in the org timezone.
CREATE OR REPLACE FUNCTION public.analytics_window(p_tz text, p_from date, p_to date)
RETURNS TABLE (starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (p_from::timestamp AT TIME ZONE p_tz),
         ((p_to + 1)::timestamp AT TIME ZONE p_tz);
$$;

-- ---------------------------------------------------------------- overview
CREATE OR REPLACE FUNCTION public.analytics_overview(
  p_organization_id uuid, p_from date, p_to date
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
  span int := GREATEST((p_to - p_from) + 1, 1);
  cur_start timestamptz;
  cur_end timestamptz;
  prev_start timestamptz;
  prev_end timestamptz;
  result jsonb;
BEGIN
  SELECT starts_at, ends_at INTO cur_start, cur_end
  FROM public.analytics_window(tz, p_from, p_to);
  SELECT starts_at, ends_at INTO prev_start, prev_end
  FROM public.analytics_window(tz, p_from - span, p_to - span);

  WITH msg AS (
    SELECT
      CASE WHEN created_at >= cur_start AND created_at < cur_end THEN 'current'
           WHEN created_at >= prev_start AND created_at < prev_end THEN 'previous' END AS bucket,
      direction, status
    FROM public.messages
    WHERE organization_id = p_organization_id
      AND created_at >= prev_start AND created_at < cur_end
  ), agg AS (
    SELECT bucket,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND status IN ('sent','delivered','read')) AS sent,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND status IN ('delivered','read')) AS delivered,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'read') AS read,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE direction = 'inbound') AS replies
    FROM msg WHERE bucket IS NOT NULL GROUP BY bucket
  ), contacts_agg AS (
    SELECT
      COUNT(*) FILTER (WHERE created_at >= cur_start AND created_at < cur_end) AS cur_new,
      COUNT(*) FILTER (WHERE created_at >= prev_start AND created_at < prev_end) AS prev_new
    FROM public.contacts WHERE organization_id = p_organization_id
  ), optouts AS (
    SELECT
      COUNT(*) FILTER (WHERE created_at >= cur_start AND created_at < cur_end) AS cur_out,
      COUNT(*) FILTER (WHERE created_at >= prev_start AND created_at < prev_end) AS prev_out
    FROM public.activity_log
    WHERE organization_id = p_organization_id AND action = 'contact_opted_out'
  ), convo AS (
    SELECT COUNT(*) FILTER (WHERE status = 'open') AS open_now
    FROM public.conversations WHERE organization_id = p_organization_id
  )
  SELECT jsonb_build_object(
    'timezone', tz,
    'from', p_from, 'to', p_to, 'days', span,
    'current', jsonb_build_object(
      'sent', COALESCE((SELECT sent FROM agg WHERE bucket = 'current'), 0),
      'delivered', COALESCE((SELECT delivered FROM agg WHERE bucket = 'current'), 0),
      'read', COALESCE((SELECT read FROM agg WHERE bucket = 'current'), 0),
      'failed', COALESCE((SELECT failed FROM agg WHERE bucket = 'current'), 0),
      'replies', COALESCE((SELECT replies FROM agg WHERE bucket = 'current'), 0),
      'new_contacts', (SELECT cur_new FROM contacts_agg),
      'opt_outs', (SELECT cur_out FROM optouts)
    ),
    'previous', jsonb_build_object(
      'sent', COALESCE((SELECT sent FROM agg WHERE bucket = 'previous'), 0),
      'delivered', COALESCE((SELECT delivered FROM agg WHERE bucket = 'previous'), 0),
      'read', COALESCE((SELECT read FROM agg WHERE bucket = 'previous'), 0),
      'failed', COALESCE((SELECT failed FROM agg WHERE bucket = 'previous'), 0),
      'replies', COALESCE((SELECT replies FROM agg WHERE bucket = 'previous'), 0),
      'new_contacts', (SELECT prev_new FROM contacts_agg),
      'opt_outs', (SELECT prev_out FROM optouts)
    ),
    'open_conversations', (SELECT open_now FROM convo)
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_overview(uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_overview(uuid, date, date) TO authenticated, service_role;

-- ---------------------------------------------------------------- daily series
CREATE OR REPLACE FUNCTION public.analytics_timeseries(
  p_organization_id uuid, p_from date, p_to date
)
RETURNS TABLE (
  day date, sent bigint, delivered bigint, read bigint, failed bigint,
  replies bigint, new_contacts bigint, opt_outs bigint,
  conversations_opened bigint, conversations_closed bigint
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
  WITH days AS (
    SELECT generate_series(p_from, p_to, interval '1 day')::date AS day
  ), msg AS (
    SELECT (m.created_at AT TIME ZONE tz)::date AS day, m.direction, m.status
    FROM public.messages m
    WHERE m.organization_id = p_organization_id
      AND m.created_at >= cur_start AND m.created_at < cur_end
  ), msg_agg AS (
    SELECT day,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND status IN ('sent','delivered','read')) AS sent,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND status IN ('delivered','read')) AS delivered,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'read') AS read,
      COUNT(*) FILTER (WHERE direction = 'outbound' AND status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE direction = 'inbound') AS replies
    FROM msg GROUP BY day
  ), contact_agg AS (
    SELECT (c.created_at AT TIME ZONE tz)::date AS day, COUNT(*) AS new_contacts
    FROM public.contacts c
    WHERE c.organization_id = p_organization_id
      AND c.created_at >= cur_start AND c.created_at < cur_end
    GROUP BY 1
  ), act_agg AS (
    SELECT (a.created_at AT TIME ZONE tz)::date AS day,
      COUNT(*) FILTER (WHERE a.action = 'contact_opted_out') AS opt_outs,
      COUNT(*) FILTER (WHERE a.action = 'conversation_closed') AS closed
    FROM public.activity_log a
    WHERE a.organization_id = p_organization_id
      AND a.action IN ('contact_opted_out', 'conversation_closed')
      AND a.created_at >= cur_start AND a.created_at < cur_end
    GROUP BY 1
  ), convo_agg AS (
    SELECT (cv.created_at AT TIME ZONE tz)::date AS day, COUNT(*) AS opened
    FROM public.conversations cv
    WHERE cv.organization_id = p_organization_id
      AND cv.created_at >= cur_start AND cv.created_at < cur_end
    GROUP BY 1
  )
  SELECT d.day,
    COALESCE(m.sent, 0), COALESCE(m.delivered, 0), COALESCE(m.read, 0),
    COALESCE(m.failed, 0), COALESCE(m.replies, 0),
    COALESCE(c.new_contacts, 0), COALESCE(a.opt_outs, 0),
    COALESCE(v.opened, 0), COALESCE(a.closed, 0)
  FROM days d
  LEFT JOIN msg_agg m ON m.day = d.day
  LEFT JOIN contact_agg c ON c.day = d.day
  LEFT JOIN act_agg a ON a.day = d.day
  LEFT JOIN convo_agg v ON v.day = d.day
  ORDER BY d.day;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_timeseries(uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_timeseries(uuid, date, date) TO authenticated, service_role;

-- ---------------------------------------------------------------- campaigns
CREATE OR REPLACE FUNCTION public.analytics_campaign_performance(
  p_organization_id uuid, p_from date, p_to date
)
RETURNS TABLE (
  campaign_id uuid, name text, status text, started_at timestamptz, created_at timestamptz,
  recipients bigint, sent bigint, delivered bigint, read bigint, replied bigint,
  failed bigint, skipped bigint
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
  SELECT c.id, c.name, c.status, c.started_at, c.created_at,
    COUNT(r.id),
    COUNT(r.id) FILTER (WHERE r.status IN ('sent','delivered','read')),
    COUNT(r.id) FILTER (WHERE r.status IN ('delivered','read')),
    COUNT(r.id) FILTER (WHERE r.status = 'read'),
    COUNT(r.id) FILTER (WHERE r.replied_at IS NOT NULL),
    COUNT(r.id) FILTER (WHERE r.status = 'failed'),
    COUNT(r.id) FILTER (WHERE r.status = 'skipped')
  FROM public.campaigns c
  LEFT JOIN public.campaign_recipients r ON r.campaign_id = c.id
  WHERE c.organization_id = p_organization_id
    AND COALESCE(c.started_at, c.created_at) >= cur_start
    AND COALESCE(c.started_at, c.created_at) < cur_end
  GROUP BY c.id
  ORDER BY COALESCE(c.started_at, c.created_at) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_campaign_performance(uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_campaign_performance(uuid, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analytics_campaign_failures(
  p_organization_id uuid, p_campaign_id uuid
)
RETURNS TABLE (reason text, recipients bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.analytics_guard(p_organization_id);
  RETURN QUERY
  SELECT COALESCE(NULLIF(TRIM(r.error), ''), 'Unknown error') AS reason, COUNT(*)
  FROM public.campaign_recipients r
  WHERE r.organization_id = p_organization_id
    AND r.campaign_id = p_campaign_id
    AND r.status = 'failed'
  GROUP BY 1
  ORDER BY 2 DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_campaign_failures(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_campaign_failures(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analytics_campaign_recipients(
  p_organization_id uuid, p_campaign_id uuid, p_status text DEFAULT NULL,
  p_limit int DEFAULT 50, p_offset int DEFAULT 0
)
RETURNS TABLE (
  recipient_id uuid, phone text, contact_name text, status text,
  error text, replied_at timestamptz, updated_at timestamptz, total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  PERFORM public.analytics_guard(p_organization_id);
  RETURN QUERY
  WITH rows AS (
    SELECT r.id, r.phone, ct.name AS contact_name, r.status, r.error, r.replied_at, r.updated_at
    FROM public.campaign_recipients r
    LEFT JOIN public.contacts ct ON ct.id = r.contact_id
    WHERE r.organization_id = p_organization_id
      AND r.campaign_id = p_campaign_id
      AND (p_status IS NULL OR r.status = p_status)
  )
  SELECT rows.id, rows.phone, rows.contact_name, rows.status, rows.error,
         rows.replied_at, rows.updated_at, (SELECT COUNT(*) FROM rows)
  FROM rows
  ORDER BY rows.updated_at DESC
  LIMIT GREATEST(p_limit, 1) OFFSET GREATEST(p_offset, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_campaign_recipients(uuid, uuid, text, int, int) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_campaign_recipients(uuid, uuid, text, int, int)
  TO authenticated, service_role;

-- ---------------------------------------------------------------- contacts
CREATE OR REPLACE FUNCTION public.analytics_contacts_summary(p_organization_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  result jsonb;
BEGIN
  PERFORM public.analytics_guard(p_organization_id);
  SELECT jsonb_build_object(
    'total', COUNT(*),
    'opted_in', COUNT(*) FILTER (WHERE opt_in_status = 'opted_in'),
    'opted_out', COUNT(*) FILTER (WHERE opt_in_status = 'opted_out'),
    'unknown', COUNT(*) FILTER (WHERE opt_in_status = 'unknown')
  ) INTO result
  FROM public.contacts WHERE organization_id = p_organization_id;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_contacts_summary(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_contacts_summary(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------- inbox & team
-- First response time: pairs the first inbound message of each customer burst
-- with the next human outbound reply in the same conversation. Automation
-- sends and opt-out confirmations carry no sent_by, so they never count.
CREATE OR REPLACE FUNCTION public.analytics_response_times(
  p_organization_id uuid, p_from date, p_to date
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

  WITH ordered AS (
    SELECT m.id, m.conversation_id, m.direction, m.created_at, m.sent_by,
           LAG(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at) AS prev_direction
    FROM public.messages m
    WHERE m.organization_id = p_organization_id
      AND m.conversation_id IS NOT NULL
      AND m.created_at >= cur_start - interval '7 days'
      AND m.created_at < cur_end
  ), bursts AS (
    SELECT * FROM ordered
    WHERE direction = 'inbound'
      AND (prev_direction IS NULL OR prev_direction = 'outbound')
      AND created_at >= cur_start AND created_at < cur_end
  ), paired AS (
    SELECT b.id,
      (SELECT MIN(o.created_at) FROM ordered o
        WHERE o.conversation_id = b.conversation_id
          AND o.direction = 'outbound'
          AND o.sent_by IS NOT NULL
          AND o.created_at > b.created_at
          AND NOT EXISTS (
            SELECT 1 FROM public.automation_runs ar WHERE ar.outbound_message_id = o.id
          )
      ) - b.created_at AS gap
    FROM bursts b
  ), answered AS (
    SELECT EXTRACT(EPOCH FROM gap) AS seconds FROM paired WHERE gap IS NOT NULL
  )
  SELECT jsonb_build_object(
    'inbound_bursts', (SELECT COUNT(*) FROM bursts),
    'answered', (SELECT COUNT(*) FROM answered),
    'median_seconds', (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) FROM answered),
    'p90_seconds', (SELECT percentile_cont(0.9) WITHIN GROUP (ORDER BY seconds) FROM answered)
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_response_times(uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_response_times(uuid, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analytics_team_performance(
  p_organization_id uuid, p_from date, p_to date
)
RETURNS TABLE (
  user_id uuid, full_name text, email text,
  conversations_handled bigint, replies_sent bigint, conversations_closed bigint
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
  WITH replies AS (
    SELECT m.sent_by AS uid, COUNT(*) AS replies_sent,
           COUNT(DISTINCT m.conversation_id) AS conversations_handled
    FROM public.messages m
    WHERE m.organization_id = p_organization_id
      AND m.direction = 'outbound' AND m.sent_by IS NOT NULL
      AND m.created_at >= cur_start AND m.created_at < cur_end
    GROUP BY 1
  ), closes AS (
    SELECT a.user_id AS uid, COUNT(*) AS conversations_closed
    FROM public.activity_log a
    WHERE a.organization_id = p_organization_id
      AND a.action = 'conversation_closed'
      AND a.user_id IS NOT NULL
      AND a.created_at >= cur_start AND a.created_at < cur_end
    GROUP BY 1
  ), people AS (
    SELECT uid FROM replies UNION SELECT uid FROM closes
  )
  SELECT p.uid, pr.full_name, pr.email,
    COALESCE(r.conversations_handled, 0), COALESCE(r.replies_sent, 0),
    COALESCE(cl.conversations_closed, 0)
  FROM people p
  LEFT JOIN replies r ON r.uid = p.uid
  LEFT JOIN closes cl ON cl.uid = p.uid
  LEFT JOIN public.profiles pr ON pr.id = p.uid
  ORDER BY COALESCE(r.replies_sent, 0) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_team_performance(uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_team_performance(uuid, date, date) TO authenticated, service_role;

-- ---------------------------------------------------------------- automations
CREATE OR REPLACE FUNCTION public.analytics_automation_performance(
  p_organization_id uuid, p_from date, p_to date
)
RETURNS TABLE (
  automation_id uuid, name text, trigger_type text, is_active boolean,
  runs bigint, sent bigint, skipped bigint, failed bigint, skip_reasons jsonb
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
  WITH runs AS (
    SELECT ar.automation_id, ar.status, ar.skip_reason
    FROM public.automation_runs ar
    WHERE ar.organization_id = p_organization_id
      AND ar.created_at >= cur_start AND ar.created_at < cur_end
  ), reasons AS (
    SELECT automation_id,
           jsonb_object_agg(COALESCE(skip_reason, 'unspecified'), n) AS skip_reasons
    FROM (
      SELECT automation_id, skip_reason, COUNT(*) AS n
      FROM runs WHERE status = 'skipped' GROUP BY 1, 2
    ) s GROUP BY automation_id
  ), totals AS (
    SELECT automation_id, COUNT(*) AS runs,
      COUNT(*) FILTER (WHERE status = 'sent') AS sent,
      COUNT(*) FILTER (WHERE status = 'skipped') AS skipped,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed
    FROM runs GROUP BY 1
  )
  SELECT a.id, a.name, a.trigger_type, a.is_active,
    COALESCE(t.runs, 0), COALESCE(t.sent, 0), COALESCE(t.skipped, 0), COALESCE(t.failed, 0),
    COALESCE(rs.skip_reasons, '{}'::jsonb)
  FROM public.automations a
  LEFT JOIN totals t ON t.automation_id = a.id
  LEFT JOIN reasons rs ON rs.automation_id = a.id
  WHERE a.organization_id = p_organization_id
  ORDER BY COALESCE(t.runs, 0) DESC, a.name;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_automation_performance(uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_automation_performance(uuid, date, date)
  TO authenticated, service_role;

-- ---------------------------------------------------------------- quality timeline
CREATE OR REPLACE FUNCTION public.analytics_quality_history(
  p_organization_id uuid, p_from date, p_to date
)
RETURNS TABLE (
  recorded_at timestamptz, quality_rating text, phone_number_id text
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
  SELECT h.recorded_at, h.quality_rating, h.phone_number_id
  FROM public.whatsapp_quality_history h
  WHERE h.organization_id = p_organization_id
    AND h.recorded_at >= cur_start AND h.recorded_at < cur_end
  ORDER BY h.recorded_at;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_quality_history(uuid, date, date) FROM public;
GRANT EXECUTE ON FUNCTION public.analytics_quality_history(uuid, date, date) TO authenticated, service_role;
