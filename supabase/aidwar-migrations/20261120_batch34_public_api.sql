-- Batch 34: the Public API — a merchant's own billing software sends an
-- invoice PDF through the workspace's approved template, and hears back
-- (sent / delivered / read / failed) on its own webhook. Idempotent. NOT
-- applied: apply by hand to the Mumbai project (hcsacmqzspnfqoftoifu).
--
-- Applying it changes nothing for anyone who doesn't call the API: the
-- public_api flag is created OFF, and is on only for a workspace on the Scale
-- or Enterprise plan or with an override row (Super Admin -> Flags). Without
-- this file the API answers 401/503 and sends nothing (no api_keys table: no
-- key can match), and the status webhook skips its enqueue (logged).
--
-- (1) the public_api flag, its feature_registry row and its one permission
--     public_api.manage (owner + admin), as scripts/sync-feature-registry.ts
--     writes them for the manifest in src/lib/feature-registry.ts; the Scale
--     and Enterprise plan versions list 'public_api' in features.
-- (2) public.api_keys: one row per key — its sha256 (key_hash), never the key.
--     Members with public_api.manage may read every column but key_hash and
--     set revoked_at on their own workspace's keys; creation is server-only.

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

RESET lock_timeout;
