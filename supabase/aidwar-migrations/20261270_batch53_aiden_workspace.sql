-- Batch 53: "Aiden Workspace" (the new design's name in the UI) — who sees
-- it — and the AI assistants page. Idempotent and additive. NOT applied:
-- apply by hand to the Mumbai project (hcsacmqzspnfqoftoifu).
--
-- SHIPPED DARK. Applying this file changes nothing anyone sees: the release
-- flag aiden_workspace is created OFF, and while it is off the app answers
-- exactly as today (only the Super Admin new_design overrides — Meezoy,
-- Aidwar demo — see Aiden Workspace; nobody has the avatar-menu switch).
-- The unlock timestamps are recorded and backfilled anyway, so switching the
-- flag's GLOBAL default on (Super Admin -> Flags) applies the rule at once:
--   Super Admin new_design override > the person's own choice >
--   workspace unlocked (its Aiden was ever switched on) > Classic.
--
-- The code works without this file (batch53-*.test.ts*): a missing flag row
-- is off, a missing column / table / function reads as "nothing recorded",
-- and every write here is skipped.
--
-- (1) organizations.aiden_workspace_unlocked_at: the first time the
--     workspace's Aiden moves from off to draft or replying. Stamped by the
--     server path that switches Aiden on (setAgentMode, the owner channel's
--     switchAgentOn) through aiden_workspace_stamp_unlock(), which only
--     fills an empty column and only while Aiden really is on. No trigger:
--     the mode change can never be blocked or slowed by it. Never cleared:
--     a workspace stays unlocked when Aiden is switched off again.
-- (2) Backfill: every workspace whose Aiden is on today is unlocked now.
-- (3) public.user_design_preferences: one row per person (their choice,
--     every device, and when they saw the intro). RLS: a person reads and
--     writes only their own row; the app writes it through /api/design.
-- (4) The release flag aiden_workspace (default OFF), its registry row and
--     its permission aiden_workspace.switch (every role).
-- (5) The mcp registry row: the AI assistants page (/app/ai-assistants,
--     gated by mcp.use) and the activity action mcp_access_changed.
-- (6) mcp_workspace_apps(): the AI apps the members of one workspace
--     allowed (Supabase Auth's OAuth consents), when each was last used,
--     for the AI assistants page. Read-only, service role only; answers
--     nothing when this project's Auth has no OAuth server tables.
-- (7) select public.mcp_block_oauth_writes(); — the Batch 52 rule: the new
--     table gets the no-OAuth-write policies.
--
-- Rollback:
--   update public.feature_flags set default_enabled = false where key = 'aiden_workspace';
--   (everything else is inert while that flag is off; to remove it entirely:)
--   drop function if exists public.mcp_workspace_apps(uuid, uuid);
--   drop function if exists public.aiden_workspace_stamp_unlock(uuid);
--   drop table if exists public.user_design_preferences;
--   alter table public.organizations drop column if exists aiden_workspace_unlocked_at;

SET lock_timeout = '5s';

-- (1) ---------------------------------------------------------- the unlock
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS aiden_workspace_unlocked_at timestamptz;

CREATE OR REPLACE FUNCTION public.aiden_workspace_stamp_unlock(p_org uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  stamped timestamptz;
BEGIN
  UPDATE public.organizations o
     SET aiden_workspace_unlocked_at = now()
   WHERE o.id = p_org
     AND o.aiden_workspace_unlocked_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.ai_agents a
        WHERE a.organization_id = p_org AND a.mode IN ('draft', 'replying')
     );
  SELECT aiden_workspace_unlocked_at INTO stamped FROM public.organizations WHERE id = p_org;
  RETURN stamped;
END;
$$;

REVOKE ALL ON FUNCTION public.aiden_workspace_stamp_unlock(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.aiden_workspace_stamp_unlock(uuid) TO service_role;

-- (2) ---------------------------------------------------------- backfill
UPDATE public.organizations o
   SET aiden_workspace_unlocked_at = now()
 WHERE o.aiden_workspace_unlocked_at IS NULL
   AND EXISTS (
     SELECT 1 FROM public.ai_agents a
      WHERE a.organization_id = o.id AND a.mode IN ('draft', 'replying')
   );

-- (3) ---------------------------------------------------------- the person's choice
CREATE TABLE IF NOT EXISTS public.user_design_preferences (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  design text CHECK (design IN ('classic', 'aiden_workspace')),
  intro_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_design_preferences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_design_preferences FROM anon;
GRANT SELECT, INSERT, UPDATE ON public.user_design_preferences TO authenticated;
GRANT ALL ON public.user_design_preferences TO service_role;

DROP POLICY IF EXISTS user_design_preferences_select_own ON public.user_design_preferences;
CREATE POLICY user_design_preferences_select_own ON public.user_design_preferences
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));

DROP POLICY IF EXISTS user_design_preferences_insert_own ON public.user_design_preferences;
CREATE POLICY user_design_preferences_insert_own ON public.user_design_preferences
  FOR INSERT TO authenticated
  WITH CHECK (user_id = (select auth.uid()));

DROP POLICY IF EXISTS user_design_preferences_update_own ON public.user_design_preferences;
CREATE POLICY user_design_preferences_update_own ON public.user_design_preferences
  FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));

-- (4) ---------------------------------------------------------- the release flag
INSERT INTO public.feature_flags (key, name, description, default_enabled)
VALUES (
  'aiden_workspace',
  'Aiden Workspace release',
  'Release Aiden Workspace (the new design): workspaces whose Aiden was ever switched on open in it, and everyone can switch between Classic and Aiden Workspace from their avatar menu. Global default only.',
  false
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description;

INSERT INTO public.feature_registry (
  key, name, description, icon, nav_path, nav_order, nav_permission, flag_key, settings_path,
  permissions, analytics, activity_actions, usage_meters, ai_tools, data_tables, depends_on, synced_at
) VALUES (
  'aiden_workspace', 'Aiden Workspace release',
  'Release Aiden Workspace (the new design): workspaces whose Aiden was ever switched on open in it, and everyone can switch between Classic and Aiden Workspace from their avatar menu. Global default only.',
  'sparkles', null, null, null, 'aiden_workspace', null,
  '[{"key":"aiden_workspace.switch","name":"Switch between Classic and Aiden Workspace","description":"Choose Classic or Aiden Workspace for yourself, on every device.","min_role":"agent"}]'::jsonb,
  '{"event_types":["design.switched"],"metrics":[],"dashboard_section":false}'::jsonb,
  array[]::text[], '[]'::jsonb, '[]'::jsonb, array['user_design_preferences']::text[], array[]::text[], now()
)
ON CONFLICT (key) DO UPDATE SET
  name = excluded.name, description = excluded.description, icon = excluded.icon,
  flag_key = excluded.flag_key, permissions = excluded.permissions, analytics = excluded.analytics,
  activity_actions = excluded.activity_actions, data_tables = excluded.data_tables,
  depends_on = excluded.depends_on, synced_at = now();

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
  IF def IS NOT NULL AND position('''aiden_workspace''' IN def) = 0 THEN
    SELECT string_agg(quote_literal(c), ', ' ORDER BY c) INTO allowed
    FROM (
      SELECT DISTINCT category AS c FROM public.permissions WHERE category IS NOT NULL
      UNION SELECT key FROM public.feature_registry
      UNION SELECT 'aiden_workspace'
    ) s;
    ALTER TABLE public.permissions DROP CONSTRAINT permissions_category_check;
    EXECUTE format('ALTER TABLE public.permissions ADD CONSTRAINT permissions_category_check CHECK (category IN (%s))', allowed);
  END IF;
END $$;

INSERT INTO public.permissions (key, name, description, category, min_role)
VALUES (
  'aiden_workspace.switch', 'Switch between Classic and Aiden Workspace',
  'Choose Classic or Aiden Workspace for yourself, on every device.',
  'aiden_workspace', 'agent'
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description,
  category = excluded.category, min_role = excluded.min_role;

INSERT INTO public.role_permissions (role, permission_key)
VALUES ('owner', 'aiden_workspace.switch'), ('admin', 'aiden_workspace.switch'),
       ('marketer', 'aiden_workspace.switch'), ('agent', 'aiden_workspace.switch')
ON CONFLICT DO NOTHING;

-- (5) ---------------------------------------------------------- the AI assistants page
UPDATE public.feature_registry
   SET name = 'AI assistants',
       nav_path = '/app/ai-assistants',
       nav_order = 57,
       nav_permission = 'mcp.use',
       settings_path = '/app/ai-assistants',
       activity_actions = (
         SELECT array_agg(DISTINCT a ORDER BY a)
         FROM unnest(activity_actions || array['mcp_access_changed']::text[]) AS a
       ),
       synced_at = now()
 WHERE key = 'mcp';

-- (6) ---------------------------------------------------------- connected AI apps
-- Supabase Auth's OAuth 2.1 server keeps each person's consent in
-- auth.oauth_consents (client, scopes, granted_at, revoked_at) and marks the
-- sessions it issues with auth.sessions.oauth_client_id. Read-only. A project
-- whose Auth has no such tables (or columns) gets no rows, never an error.
CREATE OR REPLACE FUNCTION public.mcp_workspace_apps(p_org uuid, p_user uuid DEFAULT NULL)
RETURNS TABLE (
  user_id uuid,
  client_id text,
  client_name text,
  client_uri text,
  granted_at timestamptz,
  last_used_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF to_regclass('auth.oauth_consents') IS NULL OR to_regclass('auth.oauth_clients') IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    RETURN QUERY EXECUTE $q$
      SELECT c.user_id,
             c.client_id::text,
             nullif(trim(cl.client_name), '')::text,
             cl.client_uri::text,
             c.granted_at::timestamptz,
             (SELECT max(coalesce(s.updated_at, s.created_at))::timestamptz
                FROM auth.sessions s
               WHERE s.user_id = c.user_id AND s.oauth_client_id = c.client_id)
        FROM auth.oauth_consents c
        JOIN auth.oauth_clients cl ON cl.id = c.client_id
        JOIN public.organization_members m ON m.user_id = c.user_id AND m.organization_id = $1
       WHERE c.revoked_at IS NULL
         AND ($2 IS NULL OR c.user_id = $2)
       ORDER BY c.granted_at DESC
    $q$ USING p_org, p_user;
  EXCEPTION WHEN undefined_table OR undefined_column OR datatype_mismatch OR undefined_function THEN
    -- Without last-used (no oauth_client_id on sessions in this Auth version).
    BEGIN
      RETURN QUERY EXECUTE $q$
        SELECT c.user_id, c.client_id::text, nullif(trim(cl.client_name), '')::text, cl.client_uri::text,
               c.granted_at::timestamptz, null::timestamptz
          FROM auth.oauth_consents c
          JOIN auth.oauth_clients cl ON cl.id = c.client_id
          JOIN public.organization_members m ON m.user_id = c.user_id AND m.organization_id = $1
         WHERE c.revoked_at IS NULL
           AND ($2 IS NULL OR c.user_id = $2)
         ORDER BY c.granted_at DESC
      $q$ USING p_org, p_user;
    EXCEPTION WHEN undefined_table OR undefined_column OR datatype_mismatch OR undefined_function THEN
      RETURN;
    END;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_workspace_apps(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_workspace_apps(uuid, uuid) TO service_role;

-- (7) ---------------------------------------------------------- Batch 52 rule
SELECT public.mcp_block_oauth_writes();
