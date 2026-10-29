-- Batch 44: the new_design flag (the new AiDwar design, rolled out per
-- workspace). Idempotent and additive. NOT applied: apply by hand to the
-- Mumbai project (hcsacmqzspnfqoftoifu).
--
-- Applying it changes nothing for any workspace: the new_design flag is
-- created OFF, and only a workspace with it switched on (an
-- organization_feature_overrides row, Super Admin -> Flags) sees the new
-- design. Everyone else keeps the Batch 39 to 41 look and sidebar.
--
-- The code works without this file (tested in batch44-shell.test.ts):
-- useNewDesign() reads isFeatureEnabled('new_design'), and a flag that
-- doesn't exist yet is off = the classic look.
--
-- Rollback: switch the workspace's override off (or delete it). Nothing else
-- reads these rows.
--
-- (1) feature_flags 'new_design' (default_enabled false), its
--     feature_registry row (feature 'new_design', no page, no dependencies)
--     and its one permission 'new_design.view' (every role, like seeing any
--     page) - what scripts/sync-feature-registry.ts writes for the manifest
--     in src/lib/feature-registry.ts. permissions_category_check, where it
--     exists, also allows the category 'new_design'.

SET lock_timeout = '5s';

INSERT INTO public.feature_flags (key, name, description, default_enabled)
VALUES (
  'new_design',
  'New design',
  'Show this workspace the new AiDwar design: top-bar navigation, the new colours and type, and the restyled controls.',
  false
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description;

INSERT INTO public.feature_registry (
  key, name, description, icon, nav_path, nav_order, nav_permission, flag_key, settings_path,
  permissions, analytics, activity_actions, usage_meters, ai_tools, data_tables, depends_on, synced_at
) VALUES (
  'new_design', 'New design',
  'Show this workspace the new AiDwar design: top-bar navigation, the new colours and type, and the restyled controls.',
  'sparkles', null, null, null, 'new_design', null,
  '[{"key":"new_design.view","name":"See the new design","description":"Use the app in the new design when it is switched on for the workspace.","min_role":"agent"}]'::jsonb,
  '{"event_types":[],"metrics":[],"dashboard_section":false}'::jsonb,
  array[]::text[], '[]'::jsonb, '[]'::jsonb, '{}'::text[], array[]::text[], now()
)
ON CONFLICT (key) DO UPDATE SET
  name = excluded.name, description = excluded.description, icon = excluded.icon,
  flag_key = excluded.flag_key, permissions = excluded.permissions, analytics = excluded.analytics,
  activity_actions = excluded.activity_actions, depends_on = excluded.depends_on,
  synced_at = now();

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
  IF def IS NOT NULL AND position('new_design' IN def) = 0 THEN
    SELECT string_agg(quote_literal(c), ', ' ORDER BY c) INTO allowed
    FROM (
      SELECT DISTINCT category AS c FROM public.permissions WHERE category IS NOT NULL
      UNION SELECT key FROM public.feature_registry
      UNION SELECT 'new_design'
    ) s;
    ALTER TABLE public.permissions DROP CONSTRAINT permissions_category_check;
    EXECUTE format('ALTER TABLE public.permissions ADD CONSTRAINT permissions_category_check CHECK (category IN (%s))', allowed);
  END IF;
END $$;

INSERT INTO public.permissions (key, name, description, category, min_role)
VALUES (
  'new_design.view', 'See the new design',
  'Use the app in the new design when it is switched on for the workspace.',
  'new_design', 'agent'
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description,
  category = excluded.category, min_role = excluded.min_role;

INSERT INTO public.role_permissions (role, permission_key)
VALUES ('owner', 'new_design.view'), ('admin', 'new_design.view'),
       ('marketer', 'new_design.view'), ('agent', 'new_design.view')
ON CONFLICT DO NOTHING;
