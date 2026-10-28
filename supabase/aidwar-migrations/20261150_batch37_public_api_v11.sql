-- Batch 37: Public API v1.1. Idempotent. NOT applied: apply by hand to the
-- Mumbai project (hcsacmqzspnfqoftoifu) after 20261120_batch34_public_api.sql.
--
-- Only additions: no existing column, default or row changes, and the one
-- rebuilt CHECK keeps every value it already allows (read from its own
-- definition) — never narrower than before.
--
-- Before this file is applied (tested in batch37-sql / batch37-events):
-- the template send, the session send, media links, templates and balance
-- work as written (they need nothing here); the new webhook events are
-- refused by the event CHECK, logged and never queued — the inbound message,
-- the STOP / START and the template status are handled exactly as before;
-- GET /api/v1/contacts answers 503 unavailable (its function is missing).
--
-- (3) api_webhook_deliveries carries Batch 37's events: dedupe_key (with a
--     unique index on organization_id + dedupe_key) dedupes an event that
--     isn't about one message — contact.created per contact, an opt change
--     per change, a template event per Meta notice; the event CHECK also
--     allows message.received, contact.created, contact.opted_out,
--     contact.opted_in, template.status_changed and template.category_changed.

SET lock_timeout = '5s';

-- (3) ------------------------------------------------------- webhook events
ALTER TABLE public.api_webhook_deliveries ADD COLUMN IF NOT EXISTS dedupe_key text;
-- Not partial: PostgREST's on_conflict needs a plain unique index; NULLs never conflict.
CREATE UNIQUE INDEX IF NOT EXISTS api_webhook_deliveries_org_dedupe_key
  ON public.api_webhook_deliveries (organization_id, dedupe_key);

DO $$
DECLARE
  c record;
  current_values text[];
  wanted text[] := array[
    'message.received', 'contact.created', 'contact.opted_out', 'contact.opted_in',
    'template.status_changed', 'template.category_changed'
  ];
  allowed text;
BEGIN
  FOR c IN
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'public.api_webhook_deliveries'::regclass
      AND con.contype = 'c'
      AND att.attname = 'event'
  LOOP
    SELECT coalesce(array_agg(m[1]), '{}') INTO current_values
    FROM regexp_matches(c.def, '''([^'']*)''', 'g') AS m;
    IF NOT (current_values @> wanted) THEN
      SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO allowed
      FROM (
        SELECT unnest(current_values) AS v
        UNION SELECT DISTINCT event FROM public.api_webhook_deliveries WHERE event IS NOT NULL
        UNION SELECT unnest(wanted)
      ) s;
      EXECUTE format('ALTER TABLE public.api_webhook_deliveries DROP CONSTRAINT %I', c.conname);
      EXECUTE format('ALTER TABLE public.api_webhook_deliveries ADD CONSTRAINT %I CHECK (event IN (%s))', c.conname, allowed);
    END IF;
  END LOOP;
END $$;

RESET lock_timeout;
