-- Batch 61: copies ("cc") of Public API template sends.
-- Idempotent and additive. NOT applied: apply by hand to the Mumbai project.
-- Applying it twice changes nothing the second time (batch61-sql.test.ts
-- applies it twice to a throwaway Postgres). Nothing is set for any workspace.
--
-- (1) organizations.api_cc_numbers text[] NOT NULL DEFAULT '{}': the
--     workspace's default copy numbers (Settings → API & webhooks → "Also send
--     every API template message to"). Used by every API template send whose
--     request has no `cc` of its own. At most 3 numbers, each "+" and 8–15
--     digits (the CHECK below; the app checks the same in
--     src/lib/public-api-cc.ts). RLS: the column lives on organizations, so
--     members read it as they read the rest of their workspace row; writes
--     are server-only (the trigger below keeps the old value for any other
--     caller), so every change goes through /api/developer/copies
--     (public_api.manage = owner / admin) and is in the activity log as
--     api_cc_default_saved.
--     The code works without this column: a failed read is "no default", so
--     API sends go exactly as before (loadApiCcDefault,
--     src/lib/public-api-cc.server.ts); Settings says copies aren't set up yet.
--
-- (2) analytics: exclude cc copies — analytics_overview and
--     analytics_timeseries re-created from their current repo definitions
--     (20260818_multi_number.sql) with ONE added line each:
--       AND coalesce(m.metadata->>'copy','') <> 'true'
--     (coalesce, so a message with NULL metadata still counts). Same
--     signatures, return types, security and grants. The live definitions
--     must be diffed against these (pg_get_functiondef) before this is run.

-- ------------------------------------------------- (1) default copy numbers
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS api_cc_numbers text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.organizations.api_cc_numbers IS
  'Batch 61: up to 3 numbers (E.164) that get a copy of every Public API template send without its own cc. Written only by the server (/api/developer/copies).';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.organizations'::regclass
       AND conname = 'organizations_api_cc_numbers_check'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_api_cc_numbers_check
      CHECK (
        cardinality(api_cc_numbers) <= 3
        AND array_position(api_cc_numbers, NULL) IS NULL
        AND array_to_string(api_cc_numbers, ',') ~ '^(\+[0-9]{8,15}(,\+[0-9]{8,15}){0,2})?$'
      );
  END IF;
END
$$;

-- Only the server (service role / db owner) and super admins write it.
CREATE OR REPLACE FUNCTION public.trg_guard_api_cc_numbers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role')
     and not public.is_super_admin() then
    if tg_op = 'INSERT' then
      new.api_cc_numbers := '{}';
    else
      new.api_cc_numbers := old.api_cc_numbers;
    end if;
  end if;
  return new;
end; $function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'guard_api_cc_numbers' AND tgrelid = 'public.organizations'::regclass
  ) THEN
    CREATE TRIGGER guard_api_cc_numbers
      BEFORE INSERT OR UPDATE OF api_cc_numbers ON public.organizations
      FOR EACH ROW EXECUTE FUNCTION public.trg_guard_api_cc_numbers();
  END IF;
END
$$;

-- ------------------------------------------------------------------------
-- analytics: exclude cc copies
-- (each function below is 20260818_multi_number.sql's text plus one line)
-- ------------------------------------------------------------------------
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
      AND coalesce(m.metadata->>'copy','') <> 'true'
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
      AND coalesce(m.metadata->>'copy','') <> 'true'
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

SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
