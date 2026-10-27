-- Batch 34: the Public API — a merchant's own billing software sends an
-- invoice PDF through the workspace's approved template, and hears back
-- (sent / delivered / read / failed) on its own webhook. Idempotent. NOT
-- applied: apply by hand to the Mumbai project (hcsacmqzspnfqoftoifu).
--
-- Applying it changes nothing for anyone who doesn't call the API: the
-- public_api flag is created OFF, and is on only for a workspace on the Scale
-- or Enterprise plan or with an override row (Super Admin -> Flags).
--
-- Before this file is applied (tested in batch34-keys / batch34-webhooks):
-- every API call answers 401 (a malformed key) or 503 (the api_keys read
-- fails) and nothing is sent; no message can carry metadata.source "api",
-- so the status webhook never queues anything; the flow-worker tick's
-- delivery step reports the missing api_webhook_claim and the flow tick runs
-- exactly as before. Settings -> API & webhooks stays hidden (flag absent = off).
--
-- (1) the public_api flag, its feature_registry row and its one permission
--     public_api.manage (owner + admin), as scripts/sync-feature-registry.ts
--     writes them for the manifest in src/lib/feature-registry.ts; the Scale
--     and Enterprise plan versions list 'public_api' in features.
-- (2) public.api_keys: one row per key — its sha256 (key_hash), never the key.
--     Members with public_api.manage may read every column but key_hash and
--     set revoked_at on their own workspace's keys; creation is server-only.
-- (3) public.api_requests: one row per (workspace, idempotency_key) — the
--     reservation taken before a send and the answer it gave, so a repeat
--     within 24 h gets the same answer and never a second message.
--     public.api_rate_windows + api_rate_take(): the per-key (60/min) and
--     per-workspace (300/min) counts, shared by every server instance.
--     Service role only.
-- (4) the webhook: public.workspace_connections also allows provider
--     'api_webhook' (one per workspace: the URL in public_config, the signing
--     secret in Vault through the existing workspace_connection_* functions);
--     public.api_webhook_deliveries queues one row per (message, event),
--     delivered by the minute flow-worker tick through api_webhook_claim()
--     (FOR UPDATE SKIP LOCKED) with backoff for up to 24 h. Service role only.

SET lock_timeout = '5s';

-- (1) ------------------------------------------------------- flag rows
INSERT INTO public.feature_flags (key, name, description, default_enabled)
VALUES (
  'public_api',
  'Public API & webhooks',
  'Send approved WhatsApp templates (an invoice PDF, for one) from your own software with an API key, and get delivery updates on your webhook.',
  false
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description;

INSERT INTO public.feature_registry (
  key, name, description, icon, nav_path, nav_order, nav_permission, flag_key, settings_path,
  permissions, analytics, activity_actions, usage_meters, ai_tools, data_tables, depends_on, synced_at
) VALUES (
  'public_api', 'Public API & webhooks',
  'Send approved WhatsApp templates (an invoice PDF, for one) from your own software with an API key, and get delivery updates on your webhook.',
  'settings', null, null, null, 'public_api', '/app/settings',
  '[{"key":"public_api.manage","name":"Manage API keys and webhooks","description":"Create and revoke API keys and set the webhook that receives message updates.","min_role":"admin"}]'::jsonb,
  '{"event_types":[],"metrics":[],"dashboard_section":false}'::jsonb,
  array['api_key_created','api_key_revoked','api_webhook_saved','api_webhook_secret_rotated','api_webhook_removed','api_webhook_test_sent']::text[],
  '[]'::jsonb, '[]'::jsonb,
  array['api_keys','api_requests','api_webhook_deliveries']::text[],
  array['inbox','templates']::text[], now()
)
ON CONFLICT (key) DO UPDATE SET
  name = excluded.name, description = excluded.description, icon = excluded.icon,
  flag_key = excluded.flag_key, settings_path = excluded.settings_path, permissions = excluded.permissions,
  analytics = excluded.analytics, activity_actions = excluded.activity_actions,
  data_tables = excluded.data_tables, depends_on = excluded.depends_on, synced_at = now();

-- The permission's category is its feature key; a category check that
-- doesn't know it yet is rebuilt with every category already stored.
DO $$
DECLARE
  def text;
  allowed text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'permissions_category_check' AND conrelid = 'public.permissions'::regclass;
  IF def IS NOT NULL AND position('public_api' IN def) = 0 THEN
    SELECT string_agg(quote_literal(c), ', ' ORDER BY c) INTO allowed
    FROM (
      SELECT DISTINCT category AS c FROM public.permissions WHERE category IS NOT NULL
      UNION SELECT key FROM public.feature_registry
      UNION SELECT 'public_api'
    ) s;
    ALTER TABLE public.permissions DROP CONSTRAINT permissions_category_check;
    EXECUTE format('ALTER TABLE public.permissions ADD CONSTRAINT permissions_category_check CHECK (category IN (%s))', allowed);
  END IF;
END $$;

INSERT INTO public.permissions (key, name, description, category, min_role)
VALUES (
  'public_api.manage', 'Manage API keys and webhooks',
  'Create and revoke API keys and set the webhook that receives message updates.',
  'public_api', 'admin'
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description,
  category = excluded.category, min_role = excluded.min_role;

INSERT INTO public.role_permissions (role, permission_key)
VALUES ('owner', 'public_api.manage'), ('admin', 'public_api.manage')
ON CONFLICT DO NOTHING;

-- Scale and Enterprise include the API ("Public API & webhooks"): every
-- version of those plans lists it, so a workspace on an older version of the
-- plan has it too. org_flag_enabled reads plan_versions.features after any
-- override row, so a by-hand override (on or off) still wins.
UPDATE public.plan_versions pv
SET features = array_append(coalesce(pv.features, '{}'::text[]), 'public_api')
FROM public.plans p
WHERE p.id = pv.plan_id
  AND (lower(p.key) IN ('scale', 'enterprise') OR lower(p.name) IN ('scale', 'enterprise'))
  AND NOT ('public_api' = ANY (coalesce(pv.features, '{}'::text[])));

-- (2) ------------------------------------------------------- api_keys
CREATE TABLE IF NOT EXISTS public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  -- The first 8 characters after "adw_live_", shown in the list.
  prefix text NOT NULL CHECK (char_length(prefix) = 8),
  -- sha256 (hex) of the whole key. The key itself is never stored.
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_key ON public.api_keys (key_hash);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON public.api_keys (organization_id, created_at DESC);

ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_keys FROM anon, authenticated;
GRANT ALL ON public.api_keys TO service_role;
-- Every column but key_hash; and revoked_at is the one thing a member may change.
GRANT SELECT (id, organization_id, name, prefix, created_by, created_at, last_used_at, revoked_at)
  ON public.api_keys TO authenticated;
GRANT UPDATE (revoked_at) ON public.api_keys TO authenticated;

DROP POLICY IF EXISTS api_keys_select_managers ON public.api_keys;
CREATE POLICY api_keys_select_managers ON public.api_keys
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'public_api.manage'));
DROP POLICY IF EXISTS api_keys_revoke_managers ON public.api_keys;
CREATE POLICY api_keys_revoke_managers ON public.api_keys
  FOR UPDATE TO authenticated
  USING (public.has_permission(organization_id, 'public_api.manage'))
  WITH CHECK (public.has_permission(organization_id, 'public_api.manage') AND revoked_at IS NOT NULL);

-- (3) ------------------------------------------------------- idempotency
CREATE TABLE IF NOT EXISTS public.api_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  api_key_id uuid REFERENCES public.api_keys(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  request_hash text NOT NULL,
  state text NOT NULL DEFAULT 'processing' CHECK (state IN ('processing', 'done')),
  http_status integer,
  response jsonb,
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_requests_org_key_key ON public.api_requests (organization_id, idempotency_key);
CREATE INDEX IF NOT EXISTS api_requests_created_idx ON public.api_requests (created_at);
ALTER TABLE public.api_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_requests FROM anon, authenticated;
GRANT ALL ON public.api_requests TO service_role;

-- ------------------------------------------------------------ rate limits
CREATE TABLE IF NOT EXISTS public.api_rate_windows (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
ALTER TABLE public.api_rate_windows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_rate_windows FROM anon, authenticated;
GRANT ALL ON public.api_rate_windows TO service_role;

-- One call counted in the current fixed window (one row upsert, so two
-- instances counting at once both count). retry_after = seconds to the
-- window's end when over the limit.
CREATE OR REPLACE FUNCTION public.api_rate_take(p_bucket text, p_limit integer, p_window_seconds integer DEFAULT 60)
RETURNS TABLE (allowed boolean, retry_after integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w timestamptz := to_timestamp(floor(extract(epoch FROM now()) / p_window_seconds) * p_window_seconds);
  n integer;
BEGIN
  INSERT INTO public.api_rate_windows AS r (bucket, window_start, hits)
  VALUES (p_bucket, w, 1)
  ON CONFLICT (bucket, window_start) DO UPDATE SET hits = r.hits + 1
  RETURNING r.hits INTO n;
  RETURN QUERY SELECT
    n <= p_limit,
    CASE WHEN n <= p_limit THEN 0
         ELSE greatest(1, ceil(extract(epoch FROM (w + make_interval(secs => p_window_seconds) - now())))::integer) END;
END;
$$;
REVOKE ALL ON FUNCTION public.api_rate_take(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_rate_take(text, integer, integer) TO service_role;

-- (4) ------------------------------------------------------- webhooks
-- The provider check on workspace_connections, where it doesn't name
-- 'api_webhook' yet, is rebuilt with every provider already stored.
DO $$
DECLARE
  c record;
  allowed text;
BEGIN
  FOR c IN
    SELECT con.conname, pg_get_constraintdef(con.oid) AS def
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.conrelid = 'public.workspace_connections'::regclass
      AND con.contype = 'c'
      AND att.attname = 'provider'
  LOOP
    IF position('api_webhook' IN c.def) = 0 THEN
      SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO allowed
      FROM (
        SELECT DISTINCT provider AS v FROM public.workspace_connections WHERE provider IS NOT NULL
        UNION SELECT unnest(ARRAY['google', 'razorpay', 'api_webhook'])
      ) s;
      EXECUTE format('ALTER TABLE public.workspace_connections DROP CONSTRAINT %I', c.conname);
      EXECUTE format('ALTER TABLE public.workspace_connections ADD CONSTRAINT %I CHECK (provider IN (%s))', c.conname, allowed);
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS public.api_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Null only for a "Send test event".
  message_id uuid REFERENCES public.messages(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('message.sent', 'message.delivered', 'message.read', 'message.failed', 'webhook.test')),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'delivered', 'failed', 'skipped')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_attempt_at timestamptz,
  last_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One delivery per message and event: a status Meta sends twice is queued once.
CREATE UNIQUE INDEX IF NOT EXISTS api_webhook_deliveries_message_event_key
  ON public.api_webhook_deliveries (message_id, event);
CREATE INDEX IF NOT EXISTS api_webhook_deliveries_due_idx
  ON public.api_webhook_deliveries (next_attempt_at) WHERE state = 'pending';
CREATE INDEX IF NOT EXISTS api_webhook_deliveries_org_idx
  ON public.api_webhook_deliveries (organization_id, created_at DESC);
ALTER TABLE public.api_webhook_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.api_webhook_deliveries FROM anon, authenticated;
GRANT ALL ON public.api_webhook_deliveries TO service_role;

-- Due, unleased deliveries for one tick, leased so an overlapping tick
-- (or a second instance) never sends the same one at the same time.
CREATE OR REPLACE FUNCTION public.api_webhook_claim(p_limit integer DEFAULT 25, p_lease_seconds integer DEFAULT 120)
RETURNS SETOF public.api_webhook_deliveries
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.api_webhook_deliveries d
  SET lease_until = now() + make_interval(secs => p_lease_seconds)
  WHERE d.id IN (
    SELECT id FROM public.api_webhook_deliveries
    WHERE state = 'pending'
      AND next_attempt_at <= now()
      AND (lease_until IS NULL OR lease_until < now())
    ORDER BY next_attempt_at
    LIMIT greatest(p_limit, 0)
    FOR UPDATE SKIP LOCKED
  )
  RETURNING d.*;
$$;
REVOKE ALL ON FUNCTION public.api_webhook_claim(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.api_webhook_claim(integer, integer) TO service_role;

RESET lock_timeout;
