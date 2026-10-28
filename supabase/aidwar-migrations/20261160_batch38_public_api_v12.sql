-- Batch 38: Public API v1.2. Idempotent. NOT applied: apply by hand to the
-- Mumbai project (hcsacmqzspnfqoftoifu) after 20261120_batch34_public_api.sql
-- and 20261150_batch37_public_api_v11.sql (applied on live; whatever they
-- share — dedupe_key and its index — is written IF NOT EXISTS here too).
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
-- and no console credential exists; webhooks work exactly as before — the
-- one Settings webhook (workspace_connections, provider api_webhook) gets
-- every event, /api/v1/webhooks answers 503 unavailable; the three account
-- events are refused by the event CHECK, logged and never queued.
--
-- (1) api_webhook_deliveries carries the v1.2 events: the event CHECK also
--     allows campaign.completed, phone_number.quality_changed,
--     account.status_changed and messaging_limit.changed, and dedupe_key (with a unique index on organization_id +
--     dedupe_key — the same column and index Batch 37 adds) queues it once
--     per campaign (and the account events once per Meta notice).
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
-- (5) Webhook management (up to 5 per workspace):
--     public.api_webhook_endpoints — one row per webhook: its https url, the
--     events it hears (NULL = every event), active / disabled, its signing
--     secret in Vault (api_webhook_endpoint_<id>, never in the table). A
--     trigger refuses a sixth. public.api_webhook_attempts — one row per
--     (delivery, webhook): each webhook's own attempts, retry time and result.
--     The existing Settings webhook (workspace_connections, provider
--     api_webhook) becomes the workspace's first entry with the same url and
--     the SAME signing secret (copied in Vault), so a merchant's signature
--     check keeps working; its workspace_connections row is kept as it is.
--     api_webhook_adopt_legacy() does that copy (here for every workspace,
--     and again on read for one saved by older code after this file ran);
--     api_webhook_endpoints_for() reads a workspace's webhooks with their
--     secrets; api_webhook_endpoint_set_secret() / _delete() write them.
--     Everything service role only.

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
  wanted text[] := array['campaign.completed', 'phone_number.quality_changed', 'account.status_changed', 'messaging_limit.changed'];
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

-- (5) ------------------------------------------------------- webhook management
CREATE TABLE IF NOT EXISTS public.api_webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  url text NOT NULL CHECK (url ~ '^https://' AND char_length(url) <= 2048),
  -- NULL: every event (as the one Settings webhook always heard).
  events text[],
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  secret_vault_name text,
  -- The Settings webhook it was copied from (one copy per webhook).
  legacy_connection_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_webhook_endpoints_legacy_key
  ON public.api_webhook_endpoints (legacy_connection_id);
CREATE INDEX IF NOT EXISTS api_webhook_endpoints_org_idx
  ON public.api_webhook_endpoints (organization_id, created_at);
ALTER TABLE public.api_webhook_endpoints ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_webhook_endpoints FROM anon, authenticated;
GRANT ALL ON public.api_webhook_endpoints TO service_role;
DROP TRIGGER IF EXISTS api_webhook_endpoints_updated_at ON public.api_webhook_endpoints;
CREATE TRIGGER api_webhook_endpoints_updated_at BEFORE UPDATE ON public.api_webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- At most 5 per workspace (two inserts at once: the advisory lock makes the second wait and count).
CREATE OR REPLACE FUNCTION public.api_webhook_endpoints_limit() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('api_webhook_endpoints:' || NEW.organization_id::text));
  IF (SELECT count(*) FROM public.api_webhook_endpoints WHERE organization_id = NEW.organization_id) >= 5 THEN
    RAISE EXCEPTION 'webhook_limit_reached: a workspace can have 5 webhooks' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS api_webhook_endpoints_limit ON public.api_webhook_endpoints;
CREATE TRIGGER api_webhook_endpoints_limit BEFORE INSERT ON public.api_webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.api_webhook_endpoints_limit();

CREATE TABLE IF NOT EXISTS public.api_webhook_attempts (
  delivery_id uuid NOT NULL REFERENCES public.api_webhook_deliveries(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL REFERENCES public.api_webhook_endpoints(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  last_status integer,
  last_error text,
  delivered_at timestamptz,
  PRIMARY KEY (delivery_id, endpoint_id)
);
CREATE INDEX IF NOT EXISTS api_webhook_attempts_endpoint_idx ON public.api_webhook_attempts (endpoint_id);
ALTER TABLE public.api_webhook_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_webhook_attempts FROM anon, authenticated;
GRANT ALL ON public.api_webhook_attempts TO service_role;

CREATE OR REPLACE FUNCTION public.api_webhook_endpoint_set_secret(p_id uuid, p_secret text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  v_name text := 'api_webhook_endpoint_' || p_id::text;
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = v_name;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(p_secret, v_name, 'API webhook signing secret');
  ELSE
    PERFORM vault.update_secret(v_id, p_secret);
  END IF;
  UPDATE public.api_webhook_endpoints SET secret_vault_name = v_name WHERE id = p_id;
END; $$;

-- The Settings webhook of one workspace becomes its first entry, once:
-- same url, same signing secret (a new Vault entry with the same value).
CREATE OR REPLACE FUNCTION public.api_webhook_adopt_legacy(p_org uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  c record;
  v_secret text;
  v_id uuid;
BEGIN
  SELECT wc.id, wc.status, wc.public_config->>'url' AS url, wc.created_at, wc.connected_by, wc.secret_vault_name
    INTO c
  FROM public.workspace_connections wc
  WHERE wc.organization_id = p_org AND wc.provider = 'api_webhook';
  IF c.id IS NULL OR c.url IS NULL OR c.url !~ '^https://' THEN RETURN NULL; END IF;
  SELECT e.id INTO v_id FROM public.api_webhook_endpoints e WHERE e.legacy_connection_id = c.id;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;
  SELECT s.decrypted_secret::jsonb->>'signing_secret' INTO v_secret
  FROM vault.decrypted_secrets s WHERE s.name = c.secret_vault_name;
  IF v_secret IS NULL THEN RETURN NULL; END IF;
  INSERT INTO public.api_webhook_endpoints (organization_id, url, events, status, legacy_connection_id, created_by, created_at)
  VALUES (p_org, c.url, NULL, CASE WHEN c.status = 'active' THEN 'active' ELSE 'disabled' END, c.id, c.connected_by, c.created_at)
  ON CONFLICT (legacy_connection_id) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT e.id INTO v_id FROM public.api_webhook_endpoints e WHERE e.legacy_connection_id = c.id;
    RETURN v_id;
  END IF;
  PERFORM public.api_webhook_endpoint_set_secret(v_id, v_secret);
  RETURN v_id;
END; $$;

CREATE OR REPLACE FUNCTION public.api_webhook_endpoints_for(p_org uuid)
RETURNS TABLE (
  id uuid, url text, events text[], status text, legacy boolean,
  created_at timestamptz, updated_at timestamptz, secret text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
BEGIN
  PERFORM public.api_webhook_adopt_legacy(p_org);
  RETURN QUERY
    SELECT e.id, e.url, e.events, e.status, e.legacy_connection_id IS NOT NULL,
           e.created_at, e.updated_at, s.decrypted_secret
    FROM public.api_webhook_endpoints e
    LEFT JOIN vault.decrypted_secrets s ON s.name = e.secret_vault_name
    WHERE e.organization_id = p_org
    ORDER BY e.created_at, e.id;
END; $$;

-- A webhook removed: its secret, its row, and the Settings webhook it came
-- from (so it is never copied in again).
CREATE OR REPLACE FUNCTION public.api_webhook_endpoint_delete(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  v_legacy uuid;
BEGIN
  SELECT legacy_connection_id INTO v_legacy FROM public.api_webhook_endpoints WHERE id = p_id;
  DELETE FROM vault.secrets WHERE name = 'api_webhook_endpoint_' || p_id::text;
  DELETE FROM public.api_webhook_endpoints WHERE id = p_id;
  IF v_legacy IS NOT NULL THEN
    DELETE FROM vault.secrets WHERE name = 'workspace_conn_' || v_legacy::text;
    DELETE FROM public.workspace_connections WHERE id = v_legacy AND provider = 'api_webhook';
  END IF;
END; $$;

REVOKE ALL ON FUNCTION public.api_webhook_endpoint_set_secret(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_webhook_adopt_legacy(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_webhook_endpoints_for(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.api_webhook_endpoint_delete(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_webhook_endpoint_set_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.api_webhook_adopt_legacy(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.api_webhook_endpoints_for(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.api_webhook_endpoint_delete(uuid) TO service_role;

-- Every Settings webhook that exists now becomes its workspace's first entry.
DO $$
DECLARE o uuid;
BEGIN
  FOR o IN SELECT DISTINCT organization_id FROM public.workspace_connections WHERE provider = 'api_webhook' LOOP
    PERFORM public.api_webhook_adopt_legacy(o);
  END LOOP;
END $$;

RESET lock_timeout;
