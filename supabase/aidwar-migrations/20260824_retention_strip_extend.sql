-- Extend raw PII stripping in retention_purge() to cover additional Shopify payload keys:
-- contact_email, client_details, note_attributes and customer_locale.

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
  v_orders int := 0;
  v_order_items int := 0;
  v_checkouts int := 0;
  v_orders_stripped int := 0;
  v_checkouts_stripped int := 0;
  v_stale uuid[];
  v_counts jsonb;
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

  -- Commerce data past the 24-month retention commitment.
  WITH d AS (
    DELETE FROM public.order_items oi
    USING public.orders o
    WHERE oi.order_id = o.id
      AND o.placed_at < now() - interval '24 months'
    RETURNING 1
  ) SELECT count(*) INTO v_order_items FROM d;

  WITH d AS (
    DELETE FROM public.orders
    WHERE placed_at < now() - interval '24 months'
    RETURNING 1
  ) SELECT count(*) INTO v_orders FROM d;

  WITH d AS (
    DELETE FROM public.abandoned_checkouts
    WHERE abandoned_at < now() - interval '24 months'
    RETURNING 1
  ) SELECT count(*) INTO v_checkouts FROM d;

  -- Strip PII from raw payloads kept for debugging beyond 90 days.
  WITH u AS (
    UPDATE public.orders
       SET raw = raw - 'customer' - 'billing_address' - 'shipping_address'
                     - 'shipping_lines' - 'email' - 'phone'
                     - 'contact_email' - 'client_details' - 'note_attributes'
                     - 'customer_locale'
     WHERE created_at < now() - interval '90 days'
       AND (
         raw ? 'customer' OR raw ? 'billing_address' OR raw ? 'email'
         OR raw ? 'phone' OR raw ? 'contact_email' OR raw ? 'client_details'
         OR raw ? 'note_attributes' OR raw ? 'customer_locale'
       )
    RETURNING 1
  ) SELECT count(*) INTO v_orders_stripped FROM u;

  WITH u AS (
    UPDATE public.abandoned_checkouts
       SET raw = raw - 'customer' - 'billing_address' - 'shipping_address'
                     - 'shipping_lines' - 'email' - 'phone'
                     - 'contact_email' - 'client_details' - 'note_attributes'
                     - 'customer_locale'
     WHERE created_at < now() - interval '90 days'
       AND (
         raw ? 'customer' OR raw ? 'billing_address' OR raw ? 'email'
         OR raw ? 'phone' OR raw ? 'contact_email' OR raw ? 'client_details'
         OR raw ? 'note_attributes' OR raw ? 'customer_locale'
       )
    RETURNING 1
  ) SELECT count(*) INTO v_checkouts_stripped FROM u;

  -- Contacts with no message in the last 24 months (unchanged).
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

  v_counts := jsonb_build_object(
    'webhook_events_deleted', v_webhook_events,
    'analytics_events_deleted', v_analytics_events,
    'contacts_deleted', v_contacts,
    'messages_deleted', v_messages,
    'conversations_deleted', v_conversations,
    'orders_deleted', v_orders,
    'order_items_deleted', v_order_items,
    'checkouts_deleted', v_checkouts,
    'orders_stripped', v_orders_stripped,
    'checkouts_stripped', v_checkouts_stripped
  );

  INSERT INTO public.activity_log (organization_id, user_id, action, details)
  VALUES (NULL, NULL, 'retention_purge', v_counts || jsonb_build_object('ran_at', now()));

  RETURN v_counts;
END;
$fn$;

REVOKE ALL ON FUNCTION public.retention_purge() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.retention_purge() TO service_role;
