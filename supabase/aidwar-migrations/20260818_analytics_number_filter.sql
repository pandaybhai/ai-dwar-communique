-- Analytics: whatsapp_account_id becomes part of the shared filter contract.
-- Every panel must accept it; NULL means "all numbers combined".
-- The remaining three RPCs (contacts summary, source breakdown, automations)
-- previously had no number dimension. Contacts are org-wide, so "on this
-- number" means "has a conversation on this number"; automation runs carry
-- the conversation they replied on.

-- Old single-arg signatures are dropped first: keeping them alongside a
-- defaulted overload makes a one-argument call ambiguous.
DROP FUNCTION IF EXISTS public.analytics_contacts_summary(uuid);
DROP FUNCTION IF EXISTS public.contacts_source_breakdown(uuid);
DROP FUNCTION IF EXISTS public.analytics_automation_performance(uuid, date, date);

CREATE OR REPLACE FUNCTION public.analytics_contacts_summary(
  p_organization_id uuid,
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
  result jsonb;
BEGIN
  PERFORM public.analytics_guard(p_organization_id);
  SELECT jsonb_build_object(
    'total', COUNT(*),
    'opted_in', COUNT(*) FILTER (WHERE opt_in_status = 'opted_in'),
    'opted_out', COUNT(*) FILTER (WHERE opt_in_status = 'opted_out'),
    'unknown', COUNT(*) FILTER (WHERE opt_in_status = 'unknown')
  ) INTO result
  FROM public.contacts c
  WHERE c.organization_id = p_organization_id
    AND (p_whatsapp_account_id IS NULL OR EXISTS (
      SELECT 1 FROM public.conversations cv
      WHERE cv.contact_id = c.id
        AND cv.whatsapp_account_id = p_whatsapp_account_id
    ));
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.analytics_contacts_summary(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.analytics_contacts_summary(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.contacts_source_breakdown(
  p_organization_id uuid,
  p_whatsapp_account_id uuid DEFAULT NULL
)
RETURNS TABLE (source text, contacts bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.source, count(*)::bigint
  FROM public.contacts c
  WHERE c.organization_id = p_organization_id
    AND public.is_org_member(p_organization_id)
    AND (p_whatsapp_account_id IS NULL OR EXISTS (
      SELECT 1 FROM public.conversations cv
      WHERE cv.contact_id = c.id
        AND cv.whatsapp_account_id = p_whatsapp_account_id
    ))
  GROUP BY c.source
  ORDER BY count(*) DESC;
$$;

REVOKE ALL ON FUNCTION public.contacts_source_breakdown(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.contacts_source_breakdown(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analytics_automation_performance(
  p_organization_id uuid, p_from date, p_to date,
  p_whatsapp_account_id uuid DEFAULT NULL
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
      AND (p_whatsapp_account_id IS NULL OR EXISTS (
        SELECT 1 FROM public.conversations cv
        WHERE cv.id = ar.conversation_id
          AND cv.whatsapp_account_id = p_whatsapp_account_id
      ))
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

REVOKE ALL ON FUNCTION public.analytics_automation_performance(uuid, date, date, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.analytics_automation_performance(uuid, date, date, uuid)
  TO authenticated, service_role;
