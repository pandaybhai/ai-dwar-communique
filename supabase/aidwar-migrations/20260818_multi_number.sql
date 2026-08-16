-- Multi-number support: an organization may connect several WhatsApp numbers,
-- across one or more WABAs. Credentials become one-per-WABA, accounts gain a
-- default marker, and campaigns / templates / conversations are pinned to a
-- number. Every backfill below is idempotent so a single-number workspace keeps
-- behaving exactly as it does today with no manual intervention.

-- ============================================================ credentials
ALTER TABLE public.whatsapp_credentials ADD COLUMN IF NOT EXISTS waba_id text;

UPDATE public.whatsapp_credentials c
SET waba_id = a.waba_id
FROM (
  SELECT DISTINCT ON (organization_id) organization_id, waba_id
  FROM public.whatsapp_accounts
  WHERE waba_id IS NOT NULL
  ORDER BY organization_id, (status = 'active') DESC, connected_at DESC NULLS LAST
) a
WHERE a.organization_id = c.organization_id AND c.waba_id IS NULL;

-- A token we can no longer attribute to a WABA is unusable, but deleting a
-- client's credential row is never our call — park it under a sentinel.
UPDATE public.whatsapp_credentials
SET waba_id = 'unlinked:' || id::text
WHERE waba_id IS NULL;

ALTER TABLE public.whatsapp_credentials ALTER COLUMN waba_id SET NOT NULL;
ALTER TABLE public.whatsapp_credentials
  DROP CONSTRAINT IF EXISTS whatsapp_credentials_organization_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_credentials_org_waba_key
  ON public.whatsapp_credentials (organization_id, waba_id);

-- ============================================================ accounts
ALTER TABLE public.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

WITH pick AS (
  SELECT DISTINCT ON (organization_id) id
  FROM public.whatsapp_accounts
  ORDER BY organization_id, (status = 'active') DESC, connected_at DESC NULLS LAST, created_at DESC
)
UPDATE public.whatsapp_accounts a
SET is_default = true
FROM pick
WHERE a.id = pick.id
  AND NOT EXISTS (
    SELECT 1 FROM public.whatsapp_accounts d
    WHERE d.organization_id = a.organization_id AND d.is_default
  );

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_accounts_one_default_idx
  ON public.whatsapp_accounts (organization_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS whatsapp_accounts_org_waba_idx
  ON public.whatsapp_accounts (organization_id, waba_id);

-- Resolves the workspace default number. Used by backfills and by server code
-- when nothing else specifies a number.
CREATE OR REPLACE FUNCTION public.default_whatsapp_account(p_organization_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.whatsapp_accounts
  WHERE organization_id = p_organization_id AND is_default
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.default_whatsapp_account(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.default_whatsapp_account(uuid) TO authenticated, service_role;

-- ============================================================ campaigns
ALTER TABLE public.campaigns
  ADD COLUMN IF NOT EXISTS whatsapp_account_id uuid
  REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL;

UPDATE public.campaigns c
SET whatsapp_account_id = a.id
FROM public.whatsapp_accounts a
WHERE a.organization_id = c.organization_id
  AND a.is_default
  AND c.whatsapp_account_id IS NULL;

CREATE INDEX IF NOT EXISTS campaigns_org_account_idx
  ON public.campaigns (organization_id, whatsapp_account_id);

-- ============================================================ templates
-- Templates live inside a WABA in Meta. Two WABAs mean two separate libraries,
-- so the uniqueness key has to include the WABA or a sync would overwrite one
-- library with the other.
ALTER TABLE public.message_templates ADD COLUMN IF NOT EXISTS waba_id text;

UPDATE public.message_templates t
SET waba_id = a.waba_id
FROM (
  SELECT DISTINCT ON (organization_id) organization_id, waba_id
  FROM public.whatsapp_accounts
  WHERE waba_id IS NOT NULL
  ORDER BY organization_id, is_default DESC, (status = 'active') DESC, connected_at DESC NULLS LAST
) a
WHERE a.organization_id = t.organization_id AND t.waba_id IS NULL;

ALTER TABLE public.message_templates
  DROP CONSTRAINT IF EXISTS message_templates_organization_id_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_org_waba_name_lang_key
  ON public.message_templates (organization_id, COALESCE(waba_id, ''), name, language);
CREATE INDEX IF NOT EXISTS message_templates_waba_idx
  ON public.message_templates (organization_id, waba_id, status);

-- ============================================================ conversations
UPDATE public.conversations c
SET whatsapp_account_id = a.id
FROM public.whatsapp_accounts a
WHERE a.organization_id = c.organization_id
  AND a.is_default
  AND c.whatsapp_account_id IS NULL;

-- One live thread per contact per number. The same customer writing to sales
-- and to support is two threads against one contact record.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY organization_id, contact_id, whatsapp_account_id
           ORDER BY last_message_at DESC NULLS LAST, created_at DESC
         ) AS rn
  FROM public.conversations
  WHERE status <> 'closed' AND contact_id IS NOT NULL AND whatsapp_account_id IS NOT NULL
)
UPDATE public.conversations c
SET status = 'closed'
FROM ranked
WHERE c.id = ranked.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_live_per_number_idx
  ON public.conversations (organization_id, contact_id, whatsapp_account_id)
  WHERE status <> 'closed';

-- Only enforce NOT NULL once every row is attributable, so a workspace that
-- somehow has threads without a connected number still migrates cleanly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.conversations WHERE whatsapp_account_id IS NULL
  ) THEN
    ALTER TABLE public.conversations ALTER COLUMN whatsapp_account_id SET NOT NULL;
  END IF;
END $$;

-- ============================================================ opt-out audit
-- Opt-out stays workspace-wide; this only records which number it arrived on.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS opt_status_account_id uuid
  REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL;

-- ============================================================ analytics filters
-- Every dashboard read gains an optional number filter. The old three-argument
-- overloads are dropped so a three-argument call is never ambiguous.
DROP FUNCTION IF EXISTS public.analytics_overview(uuid, date, date);
DROP FUNCTION IF EXISTS public.analytics_timeseries(uuid, date, date);
DROP FUNCTION IF EXISTS public.analytics_campaign_performance(uuid, date, date);
DROP FUNCTION IF EXISTS public.analytics_response_times(uuid, date, date);
DROP FUNCTION IF EXISTS public.analytics_team_performance(uuid, date, date);
DROP FUNCTION IF EXISTS public.analytics_quality_history(uuid, date, date);

CREATE OR REPLACE FUNCTION public.analytics_overview(
  p_organization_id uuid, p_from date, p_to date,
  p_whatsapp_account_id uuid DEFAULT NULL
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
      CASE WHEN m.created_at >= cur_start AND m.created_at < cur_end THEN 'current'
           WHEN m.created_at >= prev_start AND m.created_at < prev_end THEN 'previous' END AS bucket,
      m.direction, m.status
    FROM public.messages m
    WHERE m.organization_id = p_organization_id
      AND m.created_at >= prev_start AND m.created_at < cur_end
      AND (p_whatsapp_account_id IS NULL OR EXISTS (
        SELECT 1 FROM public.conversations cv
        WHERE cv.id = m.conversation_id AND cv.whatsapp_account_id = p_whatsapp_account_id
      ))
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
    FROM public.conversations
    WHERE organization_id = p_organization_id
      AND (p_whatsapp_account_id IS NULL OR whatsapp_account_id = p_whatsapp_account_id)
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

REVOKE ALL ON FUNCTION public.analytics_overview(uuid, date, date, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.analytics_overview(uuid, date, date, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analytics_timeseries(
  p_organization_id uuid, p_from date, p_to date,
  p_whatsapp_account_id uuid DEFAULT NULL
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
      AND (p_whatsapp_account_id IS NULL OR EXISTS (
        SELECT 1 FROM public.conversations cv
        WHERE cv.id = m.conversation_id AND cv.whatsapp_account_id = p_whatsapp_account_id
      ))
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
      AND (p_whatsapp_account_id IS NULL OR cv.whatsapp_account_id = p_whatsapp_account_id)
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

REVOKE ALL ON FUNCTION public.analytics_timeseries(uuid, date, date, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.analytics_timeseries(uuid, date, date, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analytics_campaign_performance(
  p_organization_id uuid, p_from date, p_to date,
  p_whatsapp_account_id uuid DEFAULT NULL
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
    AND (p_whatsapp_account_id IS NULL OR c.whatsapp_account_id = p_whatsapp_account_id)
    AND COALESCE(c.started_at, c.created_at) >= cur_start
    AND COALESCE(c.started_at, c.created_at) < cur_end
  GROUP BY c.id
  ORDER BY COALESCE(c.started_at, c.created_at) DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_campaign_performance(uuid, date, date, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.analytics_campaign_performance(uuid, date, date, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analytics_response_times(
  p_organization_id uuid, p_from date, p_to date,
  p_whatsapp_account_id uuid DEFAULT NULL
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
    JOIN public.conversations cv ON cv.id = m.conversation_id
    WHERE m.organization_id = p_organization_id
      AND m.conversation_id IS NOT NULL
      AND (p_whatsapp_account_id IS NULL OR cv.whatsapp_account_id = p_whatsapp_account_id)
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

REVOKE ALL ON FUNCTION public.analytics_response_times(uuid, date, date, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.analytics_response_times(uuid, date, date, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analytics_team_performance(
  p_organization_id uuid, p_from date, p_to date,
  p_whatsapp_account_id uuid DEFAULT NULL
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
      AND (p_whatsapp_account_id IS NULL OR EXISTS (
        SELECT 1 FROM public.conversations cv
        WHERE cv.id = m.conversation_id AND cv.whatsapp_account_id = p_whatsapp_account_id
      ))
    GROUP BY 1
  ), closes AS (
    SELECT a.user_id AS uid, COUNT(*) AS conversations_closed
    FROM public.activity_log a
    WHERE a.organization_id = p_organization_id
      AND a.action = 'conversation_closed'
      AND a.user_id IS NOT NULL
      AND a.created_at >= cur_start AND a.created_at < cur_end
      AND (p_whatsapp_account_id IS NULL OR EXISTS (
        SELECT 1 FROM public.conversations cv
        WHERE cv.id = NULLIF(a.details ->> 'conversation_id', '')::uuid
          AND cv.whatsapp_account_id = p_whatsapp_account_id
      ))
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

REVOKE ALL ON FUNCTION public.analytics_team_performance(uuid, date, date, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.analytics_team_performance(uuid, date, date, uuid)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analytics_quality_history(
  p_organization_id uuid, p_from date, p_to date,
  p_whatsapp_account_id uuid DEFAULT NULL
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
  target text;
BEGIN
  SELECT starts_at, ends_at INTO cur_start, cur_end
  FROM public.analytics_window(tz, p_from, p_to);

  IF p_whatsapp_account_id IS NOT NULL THEN
    SELECT a.phone_number_id INTO target
    FROM public.whatsapp_accounts a
    WHERE a.id = p_whatsapp_account_id AND a.organization_id = p_organization_id;
  END IF;

  RETURN QUERY
  SELECT h.recorded_at, h.quality_rating, h.phone_number_id
  FROM public.whatsapp_quality_history h
  WHERE h.organization_id = p_organization_id
    AND h.recorded_at >= cur_start AND h.recorded_at < cur_end
    AND (target IS NULL OR h.phone_number_id = target)
  ORDER BY h.recorded_at;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_quality_history(uuid, date, date, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.analytics_quality_history(uuid, date, date, uuid)
  TO authenticated, service_role;
