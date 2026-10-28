-- Batch 38: Public API v1.2. Idempotent. NOT applied: apply by hand to the
-- Mumbai project (hcsacmqzspnfqoftoifu) after 20261120_batch34_public_api.sql
-- (and, when it is applied, 20261150_batch37_public_api_v11.sql — in either
-- order: whatever they share is written IF NOT EXISTS here and there).
--
-- Only additions: no existing column, default or row changes, and the one
-- rebuilt CHECK keeps every value it already allows (read from its own
-- definition) — never narrower than before. No existing row is rewritten
-- (conversations is replicated to the inbox in realtime: a backfill would
-- send every open inbox one update per conversation).
--
-- Before this file is applied (tested in batch38-sql / batch38-campaigns /
-- batch38-inbox / batch38-console): the campaigns API, the inbox actions and
-- the plan table work as written (they need nothing here);
-- campaign.completed is refused by the event CHECK, logged and never
-- queued — the campaign completes exactly as before; GET
-- /api/v1/conversations answers 503 unavailable (its function is missing);
-- the Try-it console answers "isn't available yet" (its table is missing)
-- and no console credential exists.
--
-- (1) api_webhook_deliveries carries campaign.completed: the event CHECK also
--     allows it, and dedupe_key (with a unique index on organization_id +
--     dedupe_key — the same column and index Batch 37 adds) queues it once
--     per campaign.
-- (2) conversations.updated_at: set by the existing update_updated_at_column()
--     trigger from now on, NULL on rows nobody has touched since (no
--     backfill). public.api_list_conversations(): one page of a workspace's
--     conversations for GET /api/v1/conversations — oldest change first by
--     coalesce(updated_at, last_message_at, created_at), id; after a cursor;
--     filtered by status / assignee (or unassigned) / changed since. Service
--     role only; reads only the workspace it is given (the API passes the
--     key's own). conversations_org_changed_idx serves it.
-- (3) public.api_console_credentials: the Try-it console's short-lived
--     credentials (Settings -> API & webhooks). One row per credential — its
--     sha256 (token_hash), never the credential — for one workspace and the
--     member who opened the console, expiring 10 minutes after it is made.
--     Service role only: no member can read one back.
-- (4) the inbox's feature_registry row lists the two new activity actions.

SET lock_timeout = '5s';

-- (1) ------------------------------------------------------- webhook events
ALTER TABLE public.api_webhook_deliveries ADD COLUMN IF NOT EXISTS dedupe_key text;
-- Not partial: PostgREST's on_conflict needs a plain unique index; NULLs never conflict.
CREATE UNIQUE INDEX IF NOT EXISTS api_webhook_deliveries_org_dedupe_key
  ON public.api_webhook_deliveries (organization_id, dedupe_key);

DO $$
DECLARE
  c record;
  current_values text[];
  wanted text[] := array['campaign.completed'];
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

-- (2) ------------------------------------------------------- conversations
-- No default: existing rows keep NULL (no rewrite, no realtime burst); new rows get one below.
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE public.conversations ALTER COLUMN updated_at SET DEFAULT now();
DROP TRIGGER IF EXISTS conversations_updated_at ON public.conversations;
CREATE TRIGGER conversations_updated_at BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX IF NOT EXISTS conversations_org_changed_idx
  ON public.conversations (organization_id, (coalesce(updated_at, last_message_at, created_at)), id);

CREATE OR REPLACE FUNCTION public.api_list_conversations(
  p_org uuid,
  p_limit integer DEFAULT 25,
  p_after_at timestamptz DEFAULT NULL,
  p_after_id uuid DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_assignee uuid DEFAULT NULL,
  p_unassigned boolean DEFAULT false,
  p_changed_since timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id uuid, contact_id uuid, whatsapp_account_id uuid, status text, assigned_to uuid,
  last_message_at timestamptz, last_customer_message_at timestamptz, unread_count integer,
  needs_human boolean, created_at timestamptz, changed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cv.id, cv.contact_id, cv.whatsapp_account_id, cv.status, cv.assigned_to,
         cv.last_message_at, cv.last_customer_message_at, cv.unread_count,
         coalesce(cv.needs_human, false), cv.created_at,
         coalesce(cv.updated_at, cv.last_message_at, cv.created_at)
  FROM public.conversations cv
  WHERE cv.organization_id = p_org
    AND (p_status IS NULL OR cv.status = p_status)
    AND (p_assignee IS NULL OR cv.assigned_to = p_assignee)
    AND (NOT coalesce(p_unassigned, false) OR cv.assigned_to IS NULL)
    AND (p_changed_since IS NULL OR coalesce(cv.updated_at, cv.last_message_at, cv.created_at) >= p_changed_since)
    AND (p_after_at IS NULL OR (coalesce(cv.updated_at, cv.last_message_at, cv.created_at), cv.id)
         > (p_after_at, coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
  ORDER BY coalesce(cv.updated_at, cv.last_message_at, cv.created_at), cv.id
  LIMIT least(greatest(coalesce(p_limit, 25), 1), 101);
$$;
REVOKE ALL ON FUNCTION public.api_list_conversations(uuid, integer, timestamptz, uuid, text, uuid, boolean, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_list_conversations(uuid, integer, timestamptz, uuid, text, uuid, boolean, timestamptz) TO service_role;

-- (3) ------------------------------------------------------- console credentials
CREATE TABLE IF NOT EXISTS public.api_console_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- The member who opened the console (owner or admin with public_api.manage).
  created_by uuid NOT NULL,
  -- sha256 (hex) of the whole credential. The credential itself is never stored.
  token_hash text NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  CHECK (expires_at <= created_at + interval '10 minutes')
);
CREATE UNIQUE INDEX IF NOT EXISTS api_console_credentials_token_hash_key ON public.api_console_credentials (token_hash);
CREATE INDEX IF NOT EXISTS api_console_credentials_expires_idx ON public.api_console_credentials (expires_at);
ALTER TABLE public.api_console_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_console_credentials FROM anon, authenticated;
GRANT ALL ON public.api_console_credentials TO service_role;

-- (4) ------------------------------------------------------- registry
-- The inbox's activity actions also list the two the API's inbox actions
-- write (as scripts/sync-feature-registry.ts writes them for the manifest).
UPDATE public.feature_registry
SET activity_actions = (
  SELECT array_agg(DISTINCT a ORDER BY a)
  FROM unnest(activity_actions || array['conversation_reopened', 'contact_tags_changed']::text[]) AS a
)
WHERE key = 'inbox'
  AND NOT (activity_actions @> array['conversation_reopened', 'contact_tags_changed']::text[]);

RESET lock_timeout;
