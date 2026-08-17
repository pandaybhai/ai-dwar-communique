-- Daily retention purge (applied to the aidwar-mumbai project).
-- Deletes: webhook_events > 90 days, analytics_events > 24 months, and contacts
-- with no message activity in 24 months (plus their dependent rows).
-- Each run records its deleted counts in activity_log as 'retention_purge'.

CREATE EXTENSION IF NOT EXISTS pg_cron;

CREATE OR REPLACE FUNCTION public.retention_purge()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_webhook_events int := 0;
  v_analytics_events int := 0;
  v_contacts int := 0;
  v_messages int := 0;
  v_conversations int := 0;
  v_stale uuid[];
BEGIN
  WITH d AS (
    DELETE FROM public.webhook_events
    WHERE received_at < now() - interval '90 days'
    RETURNING 1
  ) SELECT count(*) INTO v_webhook_events FROM d;

  WITH d AS (
    DELETE FROM public.analytics_events
    WHERE occurred_at < now() - interval '24 months'
    RETURNING 1
  ) SELECT count(*) INTO v_analytics_events FROM d;

  -- Contacts with no message in the last 24 months, and none ever created recently.
  SELECT coalesce(array_agg(c.id), '{}')
    INTO v_stale
  FROM public.contacts c
  WHERE c.created_at < now() - interval '24 months'
    AND NOT EXISTS (
      SELECT 1
      FROM public.conversations cv
      JOIN public.messages m ON m.conversation_id = cv.id
      WHERE cv.contact_id = c.id
        AND m.created_at >= now() - interval '24 months'
    );

  IF array_length(v_stale, 1) IS NOT NULL THEN
    WITH d AS (
      DELETE FROM public.messages m
      USING public.conversations cv
      WHERE m.conversation_id = cv.id AND cv.contact_id = ANY(v_stale)
      RETURNING 1
    ) SELECT count(*) INTO v_messages FROM d;

    WITH d AS (
      DELETE FROM public.conversations WHERE contact_id = ANY(v_stale) RETURNING 1
    ) SELECT count(*) INTO v_conversations FROM d;

    DELETE FROM public.contact_tags WHERE contact_id = ANY(v_stale);

    WITH d AS (
      DELETE FROM public.contacts WHERE id = ANY(v_stale) RETURNING 1
    ) SELECT count(*) INTO v_contacts FROM d;
  END IF;

  INSERT INTO public.activity_log (organization_id, user_id, action, details)
  VALUES (
    NULL, NULL, 'retention_purge',
    jsonb_build_object(
      'webhook_events_deleted', v_webhook_events,
      'analytics_events_deleted', v_analytics_events,
      'contacts_deleted', v_contacts,
      'messages_deleted', v_messages,
      'conversations_deleted', v_conversations,
      'ran_at', now()
    )
  );

  RETURN jsonb_build_object(
    'webhook_events_deleted', v_webhook_events,
    'analytics_events_deleted', v_analytics_events,
    'contacts_deleted', v_contacts
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.retention_purge() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retention_purge() TO service_role;

SELECT cron.unschedule('aidwar-retention-purge')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'aidwar-retention-purge');

SELECT cron.schedule('aidwar-retention-purge', '0 2 * * *', $$SELECT public.retention_purge();$$);
