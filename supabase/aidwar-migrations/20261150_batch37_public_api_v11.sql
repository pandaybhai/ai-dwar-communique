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
-- (4) public.api_list_contacts(): one page of a workspace's contacts for
--     GET /api/v1/contacts — oldest change first (updated_at, id), after a
--     cursor, filtered by tag (any case) / opt-in status / updated_since, each
--     with its tag names. Service role only; reads only the workspace it is
--     given (the API passes the key's own). contacts_org_updated_idx serves it.

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

-- (4) ------------------------------------------------------- contacts list
CREATE INDEX IF NOT EXISTS contacts_org_updated_idx
  ON public.contacts (organization_id, updated_at, id);

CREATE OR REPLACE FUNCTION public.api_list_contacts(
  p_org uuid,
  p_limit integer DEFAULT 50,
  p_after_updated timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_tag text DEFAULT NULL,
  p_opt_in text DEFAULT NULL,
  p_updated_since timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid, phone text, wa_id text, name text, opt_in_status text, attributes jsonb,
  source text, created_at timestamptz, updated_at timestamptz, tags text[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.phone, c.wa_id, c.name, c.opt_in_status, c.attributes, c.source,
         c.created_at, c.updated_at,
         coalesce((
           SELECT array_agg(t.name ORDER BY t.name)
           FROM public.contact_tags ct JOIN public.tags t ON t.id = ct.tag_id
           WHERE ct.contact_id = c.id AND t.organization_id = p_org
         ), '{}'::text[])
  FROM public.contacts c
  WHERE c.organization_id = p_org
    AND (p_opt_in IS NULL OR c.opt_in_status = p_opt_in)
    AND (p_updated_since IS NULL OR c.updated_at >= p_updated_since)
    AND (p_after_updated IS NULL OR (c.updated_at, c.id) > (p_after_updated, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
    AND (p_tag IS NULL OR EXISTS (
      SELECT 1 FROM public.contact_tags ct JOIN public.tags t ON t.id = ct.tag_id
      WHERE ct.contact_id = c.id AND t.organization_id = p_org AND lower(t.name) = lower(p_tag)
    ))
  ORDER BY c.updated_at, c.id
  LIMIT least(greatest(coalesce(p_limit, 50), 1), 101);
$$;
REVOKE ALL ON FUNCTION public.api_list_contacts(uuid, integer, timestamptz, uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_list_contacts(uuid, integer, timestamptz, uuid, text, text, timestamptz) TO service_role;

RESET lock_timeout;
