-- Permission system: roles become presets, per-member overrides sit on top.
-- Applied to the external aidwar-mumbai project via AIDWAR_MUMBAI_DB_URL.

-- ============================================================ catalogue ====
CREATE TABLE IF NOT EXISTS public.permissions (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  category text NOT NULL CHECK (category IN ('inbox','contacts','marketing','team','settings','billing')),
  min_role text NOT NULL CHECK (min_role IN ('owner','admin','marketer','agent')),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.permissions TO authenticated;
GRANT ALL ON public.permissions TO service_role;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "permissions_select_all" ON public.permissions;
DROP POLICY IF EXISTS "permissions_select_all" ON public.permissions;
CREATE POLICY "permissions_select_all" ON public.permissions
  FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role text NOT NULL CHECK (role IN ('owner','admin','marketer','agent')),
  permission_key text NOT NULL REFERENCES public.permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role, permission_key)
);
GRANT SELECT ON public.role_permissions TO authenticated;
GRANT ALL ON public.role_permissions TO service_role;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "role_permissions_select_all" ON public.role_permissions;
DROP POLICY IF EXISTS "role_permissions_select_all" ON public.role_permissions;
CREATE POLICY "role_permissions_select_all" ON public.role_permissions
  FOR SELECT TO authenticated USING (true);

CREATE TABLE IF NOT EXISTS public.member_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES public.permissions(key) ON DELETE CASCADE,
  granted boolean NOT NULL,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id, permission_key)
);
CREATE INDEX IF NOT EXISTS member_permissions_lookup_idx
  ON public.member_permissions (organization_id, user_id, permission_key);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_permissions TO authenticated;
GRANT ALL ON public.member_permissions TO service_role;
ALTER TABLE public.member_permissions ENABLE ROW LEVEL SECURITY;

-- ================================================================ seeds ====
INSERT INTO public.permissions (key, name, description, category, min_role) VALUES
  ('inbox.view',         'View inbox',             'See conversations in the shared team inbox',       'inbox',     'agent'),
  ('inbox.reply',        'Reply in inbox',         'Send replies in conversations',                    'inbox',     'agent'),
  ('inbox.assign',       'Assign conversations',   'Assign conversations to team members',             'inbox',     'agent'),
  ('inbox.close',        'Close conversations',    'Close or reopen conversations',                    'inbox',     'admin'),
  ('contacts.view',      'View contacts',          'Browse the contact list and contact details',      'contacts',  'agent'),
  ('contacts.edit',      'Edit contacts',          'Create and update contacts, tags and attributes',  'contacts',  'marketer'),
  ('contacts.import',    'Import contacts',        'Bulk import contacts from CSV',                    'contacts',  'marketer'),
  ('contacts.export',    'Export contacts',        'Export contact data out of the workspace',         'contacts',  'admin'),
  ('contacts.delete',    'Delete contacts',        'Permanently delete contacts',                      'contacts',  'admin'),
  ('segments.manage',    'Manage segments',        'Create and edit audience segments',                'marketing', 'marketer'),
  ('campaigns.view',     'View campaigns',         'See campaigns and their results',                  'marketing', 'marketer'),
  ('campaigns.create',   'Create campaigns',       'Create and edit campaign drafts',                  'marketing', 'marketer'),
  ('campaigns.send',     'Send campaigns',         'Launch, pause and cancel campaigns',               'marketing', 'marketer'),
  ('templates.manage',   'Manage templates',       'Create and sync message templates',                'marketing', 'marketer'),
  ('automations.manage', 'Manage automations',     'Create and edit automations',                      'marketing', 'marketer'),
  ('analytics.view',     'View analytics',         'See workspace analytics and reporting',            'marketing', 'marketer'),
  ('team.manage',        'Manage team',            'Invite members, set roles and permissions',        'team',      'admin'),
  ('settings.manage',    'Manage settings',        'Change workspace settings',                        'settings',  'admin'),
  ('settings.whatsapp',  'Manage connection',      'Connect or disconnect the business number',        'settings',  'owner'),
  ('billing.manage',     'Manage billing',         'Manage the plan, payment method and invoices',     'billing',   'owner')
ON CONFLICT (key) DO UPDATE
  SET name = EXCLUDED.name,
      description = EXCLUDED.description,
      category = EXCLUDED.category,
      min_role = EXCLUDED.min_role;

-- Owner: everything.
INSERT INTO public.role_permissions (role, permission_key)
SELECT 'owner', key FROM public.permissions
ON CONFLICT DO NOTHING;

-- Admin: everything except billing.manage and settings.whatsapp.
INSERT INTO public.role_permissions (role, permission_key)
SELECT 'admin', key FROM public.permissions
WHERE key NOT IN ('billing.manage','settings.whatsapp')
ON CONFLICT DO NOTHING;

-- Marketer preset.
INSERT INTO public.role_permissions (role, permission_key)
SELECT 'marketer', k FROM unnest(ARRAY[
  'campaigns.view','campaigns.create','campaigns.send','templates.manage','automations.manage',
  'analytics.view','segments.manage','contacts.view','contacts.edit','contacts.import',
  'inbox.view','inbox.reply'
]) AS k
ON CONFLICT DO NOTHING;

-- Agent preset.
INSERT INTO public.role_permissions (role, permission_key)
SELECT 'agent', k FROM unnest(ARRAY[
  'inbox.view','inbox.reply','inbox.assign','contacts.view'
]) AS k
ON CONFLICT DO NOTHING;

-- Remove any preset rows that are no longer part of the definition above.
DELETE FROM public.role_permissions rp
WHERE rp.role = 'marketer' AND rp.permission_key NOT IN (
  'campaigns.view','campaigns.create','campaigns.send','templates.manage','automations.manage',
  'analytics.view','segments.manage','contacts.view','contacts.edit','contacts.import',
  'inbox.view','inbox.reply');
DELETE FROM public.role_permissions rp
WHERE rp.role = 'agent' AND rp.permission_key NOT IN (
  'inbox.view','inbox.reply','inbox.assign','contacts.view');
DELETE FROM public.role_permissions rp
WHERE rp.role = 'admin' AND rp.permission_key IN ('billing.manage','settings.whatsapp');

-- ============================================ marketer role, role ranks ====
ALTER TABLE public.organization_members DROP CONSTRAINT IF EXISTS organization_members_role_check;
ALTER TABLE public.organization_members
  ADD CONSTRAINT organization_members_role_check
  CHECK (role IN ('owner','admin','marketer','agent'));

CREATE OR REPLACE FUNCTION public.role_rank(p_role text)
RETURNS int LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE p_role
    WHEN 'owner' THEN 4
    WHEN 'admin' THEN 3
    WHEN 'marketer' THEN 2
    WHEN 'agent' THEN 1
    ELSE 0 END;
$$;

-- =============================================================== helper ====
CREATE OR REPLACE FUNCTION public.has_permission(org_id uuid, perm text)
RETURNS boolean
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text;
  v_granted boolean;
BEGIN
  IF org_id IS NULL OR perm IS NULL THEN
    RETURN false;
  END IF;

  IF public.is_super_admin() THEN
    RETURN true;
  END IF;

  SELECT m.role INTO v_role
  FROM public.organization_members m
  WHERE m.organization_id = org_id AND m.user_id = auth.uid();

  IF v_role IS NULL THEN
    RETURN false;
  END IF;

  -- Owners always hold every permission; overrides can never lock them out.
  IF v_role = 'owner' THEN
    RETURN true;
  END IF;

  SELECT mp.granted INTO v_granted
  FROM public.member_permissions mp
  WHERE mp.organization_id = org_id
    AND mp.user_id = auth.uid()
    AND mp.permission_key = perm;

  IF v_granted IS NOT NULL THEN
    RETURN v_granted;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.role_permissions rp
    WHERE rp.role = v_role AND rp.permission_key = perm
  );
END;
$$;

REVOKE ALL ON FUNCTION public.has_permission(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_permission(uuid, text) TO authenticated, service_role;

-- ============================== member_permissions RLS + escalation guard ==
DROP POLICY IF EXISTS "member_permissions_select" ON public.member_permissions;
DROP POLICY IF EXISTS "member_permissions_select" ON public.member_permissions;
CREATE POLICY "member_permissions_select" ON public.member_permissions
  FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id) OR public.is_super_admin());

DROP POLICY IF EXISTS "member_permissions_insert" ON public.member_permissions;
DROP POLICY IF EXISTS "member_permissions_insert" ON public.member_permissions;
CREATE POLICY "member_permissions_insert" ON public.member_permissions
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(organization_id, 'team.manage') OR public.is_super_admin());

DROP POLICY IF EXISTS "member_permissions_update" ON public.member_permissions;
DROP POLICY IF EXISTS "member_permissions_update" ON public.member_permissions;
CREATE POLICY "member_permissions_update" ON public.member_permissions
  FOR UPDATE TO authenticated
  USING (public.has_permission(organization_id, 'team.manage') OR public.is_super_admin())
  WITH CHECK (public.has_permission(organization_id, 'team.manage') OR public.is_super_admin());

DROP POLICY IF EXISTS "member_permissions_delete" ON public.member_permissions;
DROP POLICY IF EXISTS "member_permissions_delete" ON public.member_permissions;
CREATE POLICY "member_permissions_delete" ON public.member_permissions
  FOR DELETE TO authenticated
  USING (public.has_permission(organization_id, 'team.manage') OR public.is_super_admin());

-- A member may only grant or revoke a permission they themselves hold.
CREATE OR REPLACE FUNCTION public.guard_member_permission_grant()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_org uuid;
  v_key text;
  v_target uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_org := OLD.organization_id; v_key := OLD.permission_key; v_target := OLD.user_id;
  ELSE
    v_org := NEW.organization_id; v_key := NEW.permission_key; v_target := NEW.user_id;
  END IF;

  -- service role / background jobs
  IF auth.uid() IS NULL OR public.is_super_admin() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF NOT public.has_permission(v_org, 'team.manage') THEN
    RAISE EXCEPTION 'You do not have permission to manage team permissions in this workspace.';
  END IF;

  IF NOT public.has_permission(v_org, v_key) THEN
    RAISE EXCEPTION 'You can only grant or revoke permissions you hold yourself (%).', v_key;
  END IF;

  IF v_target = auth.uid() THEN
    RAISE EXCEPTION 'You cannot change your own permissions.';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DROP TRIGGER IF EXISTS guard_member_permission_grant_trg ON public.member_permissions;
CREATE TRIGGER guard_member_permission_grant_trg
  BEFORE INSERT OR UPDATE OR DELETE ON public.member_permissions
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_permission_grant();

-- ====================================== organization_members role guards ==
-- A member may only assign a role strictly below their own.
CREATE OR REPLACE FUNCTION public.guard_member_role_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor uuid := auth.uid();
  actor_role text;
  member_count int;
BEGIN
  IF actor IS NULL OR public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.role = OLD.role THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO member_count
  FROM public.organization_members m
  WHERE m.organization_id = NEW.organization_id;

  -- First member of a brand new workspace is its owner.
  IF TG_OP = 'INSERT' AND member_count = 0 THEN
    RETURN NEW;
  END IF;

  SELECT m.role INTO actor_role
  FROM public.organization_members m
  WHERE m.organization_id = NEW.organization_id AND m.user_id = actor;

  IF actor_role IS NULL THEN
    RAISE EXCEPTION 'Only members of this workspace can manage its team.';
  END IF;

  IF public.role_rank(actor_role) <= public.role_rank(NEW.role) THEN
    RAISE EXCEPTION 'You can only assign roles below your own (your role: %, attempted: %).',
      actor_role, NEW.role;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_member_role_assignment_trg ON public.organization_members;
CREATE TRIGGER guard_member_role_assignment_trg
  BEFORE INSERT OR UPDATE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_role_assignment();

-- An organization must always keep at least one owner.
CREATE OR REPLACE FUNCTION public.guard_last_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  owner_count int;
BEGIN
  IF OLD.role <> 'owner' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.role = 'owner' THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO owner_count
  FROM public.organization_members m
  WHERE m.organization_id = OLD.organization_id AND m.role = 'owner';

  IF owner_count <= 1 THEN
    RAISE EXCEPTION 'This workspace must always have at least one owner. Make another member an owner first.';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DROP TRIGGER IF EXISTS guard_last_owner_trg ON public.organization_members;
CREATE TRIGGER guard_last_owner_trg
  BEFORE UPDATE OR DELETE ON public.organization_members
  FOR EACH ROW EXECUTE FUNCTION public.guard_last_owner();

-- Membership write policies now run on permissions, not on the coarse role check.
DROP POLICY IF EXISTS "Owners and admins can add members" ON public.organization_members;
DROP POLICY IF EXISTS "Members with team.manage can add members" ON public.organization_members;
CREATE POLICY "Members with team.manage can add members" ON public.organization_members
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(organization_id, 'team.manage') OR public.is_super_admin());

DROP POLICY IF EXISTS "Owners and admins can update members" ON public.organization_members;
DROP POLICY IF EXISTS "Members with team.manage can update members" ON public.organization_members;
CREATE POLICY "Members with team.manage can update members" ON public.organization_members
  FOR UPDATE TO authenticated
  USING ((public.has_permission(organization_id, 'team.manage') AND user_id <> auth.uid()) OR public.is_super_admin())
  WITH CHECK ((public.has_permission(organization_id, 'team.manage') AND user_id <> auth.uid()) OR public.is_super_admin());

DROP POLICY IF EXISTS "Owners and admins can remove members" ON public.organization_members;
DROP POLICY IF EXISTS "Members with team.manage can remove members" ON public.organization_members;
CREATE POLICY "Members with team.manage can remove members" ON public.organization_members
  FOR DELETE TO authenticated
  USING ((public.has_permission(organization_id, 'team.manage') AND user_id <> auth.uid()) OR public.is_super_admin());

-- ================================================= policy migration =======
-- contacts
DROP POLICY IF EXISTS "contacts_select_members" ON public.contacts;
DROP POLICY IF EXISTS "contacts_select_members" ON public.contacts;
CREATE POLICY "contacts_select_members" ON public.contacts
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'contacts.view'));
DROP POLICY IF EXISTS "contacts_insert_members" ON public.contacts;
DROP POLICY IF EXISTS "contacts_insert_members" ON public.contacts;
CREATE POLICY "contacts_insert_members" ON public.contacts
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'contacts.edit'));
DROP POLICY IF EXISTS "contacts_update_members" ON public.contacts;
DROP POLICY IF EXISTS "contacts_update_members" ON public.contacts;
CREATE POLICY "contacts_update_members" ON public.contacts
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'contacts.edit'))
  WITH CHECK (public.has_permission(organization_id, 'contacts.edit'));
DROP POLICY IF EXISTS "contacts_delete_admins" ON public.contacts;
DROP POLICY IF EXISTS "contacts_delete_permitted" ON public.contacts;
CREATE POLICY "contacts_delete_permitted" ON public.contacts
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'contacts.delete'));

-- contact_tags
DROP POLICY IF EXISTS "contact_tags_select_members" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_select_members" ON public.contact_tags;
CREATE POLICY "contact_tags_select_members" ON public.contact_tags
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'contacts.view'));
DROP POLICY IF EXISTS "contact_tags_insert_members" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_insert_members" ON public.contact_tags;
CREATE POLICY "contact_tags_insert_members" ON public.contact_tags
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'contacts.edit'));
DROP POLICY IF EXISTS "contact_tags_delete_members" ON public.contact_tags;
DROP POLICY IF EXISTS "contact_tags_delete_members" ON public.contact_tags;
CREATE POLICY "contact_tags_delete_members" ON public.contact_tags
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'contacts.edit'));

-- tags
DROP POLICY IF EXISTS "tags_select_members" ON public.tags;
DROP POLICY IF EXISTS "tags_select_members" ON public.tags;
CREATE POLICY "tags_select_members" ON public.tags
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'contacts.view'));
DROP POLICY IF EXISTS "tags_insert_members" ON public.tags;
DROP POLICY IF EXISTS "tags_insert_members" ON public.tags;
CREATE POLICY "tags_insert_members" ON public.tags
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'contacts.edit'));
DROP POLICY IF EXISTS "tags_update_members" ON public.tags;
DROP POLICY IF EXISTS "tags_update_members" ON public.tags;
CREATE POLICY "tags_update_members" ON public.tags
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'contacts.edit'))
  WITH CHECK (public.has_permission(organization_id, 'contacts.edit'));
DROP POLICY IF EXISTS "tags_delete_admins" ON public.tags;
DROP POLICY IF EXISTS "tags_delete_permitted" ON public.tags;
CREATE POLICY "tags_delete_permitted" ON public.tags
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'contacts.edit'));

-- contact_imports
DROP POLICY IF EXISTS "contact_imports_select_members" ON public.contact_imports;
DROP POLICY IF EXISTS "contact_imports_select_members" ON public.contact_imports;
CREATE POLICY "contact_imports_select_members" ON public.contact_imports
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'contacts.view'));
DROP POLICY IF EXISTS "contact_imports_insert_admins" ON public.contact_imports;
DROP POLICY IF EXISTS "contact_imports_insert_permitted" ON public.contact_imports;
CREATE POLICY "contact_imports_insert_permitted" ON public.contact_imports
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'contacts.import'));
DROP POLICY IF EXISTS "contact_imports_update_admins" ON public.contact_imports;
DROP POLICY IF EXISTS "contact_imports_update_permitted" ON public.contact_imports;
CREATE POLICY "contact_imports_update_permitted" ON public.contact_imports
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'contacts.import'))
  WITH CHECK (public.has_permission(organization_id, 'contacts.import'));

-- segments
DROP POLICY IF EXISTS "segments_select_members" ON public.segments;
DROP POLICY IF EXISTS "segments_select_members" ON public.segments;
CREATE POLICY "segments_select_members" ON public.segments
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'contacts.view'));
DROP POLICY IF EXISTS "segments_insert_members" ON public.segments;
DROP POLICY IF EXISTS "segments_insert_members" ON public.segments;
CREATE POLICY "segments_insert_members" ON public.segments
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'segments.manage'));
DROP POLICY IF EXISTS "segments_update_members" ON public.segments;
DROP POLICY IF EXISTS "segments_update_members" ON public.segments;
CREATE POLICY "segments_update_members" ON public.segments
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'segments.manage'))
  WITH CHECK (public.has_permission(organization_id, 'segments.manage'));
DROP POLICY IF EXISTS "segments_delete_admins" ON public.segments;
DROP POLICY IF EXISTS "segments_delete_permitted" ON public.segments;
CREATE POLICY "segments_delete_permitted" ON public.segments
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'segments.manage'));

-- campaigns
DROP POLICY IF EXISTS "campaigns_select_members" ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_select_members" ON public.campaigns;
CREATE POLICY "campaigns_select_members" ON public.campaigns
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'campaigns.view'));
DROP POLICY IF EXISTS "campaigns_insert_admins" ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_insert_permitted" ON public.campaigns;
CREATE POLICY "campaigns_insert_permitted" ON public.campaigns
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'campaigns.create'));
DROP POLICY IF EXISTS "campaigns_update_admins" ON public.campaigns;
DROP POLICY IF EXISTS "campaigns_update_permitted" ON public.campaigns;
CREATE POLICY "campaigns_update_permitted" ON public.campaigns
  FOR UPDATE TO authenticated
  USING (public.has_permission(organization_id, 'campaigns.create') OR public.has_permission(organization_id, 'campaigns.send'))
  WITH CHECK (public.has_permission(organization_id, 'campaigns.create') OR public.has_permission(organization_id, 'campaigns.send'));

-- campaign_recipients
DROP POLICY IF EXISTS "campaign_recipients_select_members" ON public.campaign_recipients;
DROP POLICY IF EXISTS "campaign_recipients_select_members" ON public.campaign_recipients;
CREATE POLICY "campaign_recipients_select_members" ON public.campaign_recipients
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'campaigns.view'));

-- message_templates
DROP POLICY IF EXISTS "org members read templates" ON public.message_templates;
DROP POLICY IF EXISTS "org members read templates" ON public.message_templates;
CREATE POLICY "org members read templates" ON public.message_templates
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'inbox.view') OR public.has_permission(organization_id, 'campaigns.view'));
DROP POLICY IF EXISTS "org admins insert templates" ON public.message_templates;
DROP POLICY IF EXISTS "templates_insert_permitted" ON public.message_templates;
CREATE POLICY "templates_insert_permitted" ON public.message_templates
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'templates.manage'));
DROP POLICY IF EXISTS "org admins update templates" ON public.message_templates;
DROP POLICY IF EXISTS "templates_update_permitted" ON public.message_templates;
CREATE POLICY "templates_update_permitted" ON public.message_templates
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'templates.manage'))
  WITH CHECK (public.has_permission(organization_id, 'templates.manage'));

-- automations
DROP POLICY IF EXISTS "automations_select_members" ON public.automations;
DROP POLICY IF EXISTS "automations_select_members" ON public.automations;
CREATE POLICY "automations_select_members" ON public.automations
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'automations.manage') OR public.has_permission(organization_id, 'inbox.view'));
DROP POLICY IF EXISTS "automations_insert_admins" ON public.automations;
DROP POLICY IF EXISTS "automations_insert_permitted" ON public.automations;
CREATE POLICY "automations_insert_permitted" ON public.automations
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'automations.manage'));
DROP POLICY IF EXISTS "automations_update_admins" ON public.automations;
DROP POLICY IF EXISTS "automations_update_permitted" ON public.automations;
CREATE POLICY "automations_update_permitted" ON public.automations
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'automations.manage'))
  WITH CHECK (public.has_permission(organization_id, 'automations.manage'));
DROP POLICY IF EXISTS "automations_delete_admins" ON public.automations;
DROP POLICY IF EXISTS "automations_delete_permitted" ON public.automations;
CREATE POLICY "automations_delete_permitted" ON public.automations
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'automations.manage'));

-- automation_runs
DROP POLICY IF EXISTS "automation_runs_select_members" ON public.automation_runs;
DROP POLICY IF EXISTS "automation_runs_select_members" ON public.automation_runs;
CREATE POLICY "automation_runs_select_members" ON public.automation_runs
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'automations.manage') OR public.has_permission(organization_id, 'inbox.view'));

-- conversations
DROP POLICY IF EXISTS "conversations_select_members" ON public.conversations;
DROP POLICY IF EXISTS "conversations_select_members" ON public.conversations;
CREATE POLICY "conversations_select_members" ON public.conversations
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'inbox.view'));
DROP POLICY IF EXISTS "conversations_insert_members" ON public.conversations;
DROP POLICY IF EXISTS "conversations_insert_members" ON public.conversations;
CREATE POLICY "conversations_insert_members" ON public.conversations
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'inbox.reply'));
DROP POLICY IF EXISTS "conversations_update_members" ON public.conversations;
DROP POLICY IF EXISTS "conversations_update_members" ON public.conversations;
CREATE POLICY "conversations_update_members" ON public.conversations
  FOR UPDATE TO authenticated
  USING (public.has_permission(organization_id, 'inbox.reply') OR public.has_permission(organization_id, 'inbox.assign'))
  WITH CHECK (public.has_permission(organization_id, 'inbox.reply') OR public.has_permission(organization_id, 'inbox.assign'));
DROP POLICY IF EXISTS "conversations_delete_admins" ON public.conversations;
DROP POLICY IF EXISTS "conversations_delete_permitted" ON public.conversations;
CREATE POLICY "conversations_delete_permitted" ON public.conversations
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'inbox.close'));

-- messages
DROP POLICY IF EXISTS "messages_select_members" ON public.messages;
DROP POLICY IF EXISTS "messages_select_members" ON public.messages;
CREATE POLICY "messages_select_members" ON public.messages
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'inbox.view'));
DROP POLICY IF EXISTS "messages_insert_members" ON public.messages;
DROP POLICY IF EXISTS "messages_insert_members" ON public.messages;
CREATE POLICY "messages_insert_members" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(organization_id, 'inbox.reply') AND direction = 'outbound');

-- opt_out_keywords
DROP POLICY IF EXISTS "opt_out_keywords_select_members" ON public.opt_out_keywords;
DROP POLICY IF EXISTS "opt_out_keywords_select_members" ON public.opt_out_keywords;
CREATE POLICY "opt_out_keywords_select_members" ON public.opt_out_keywords
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'contacts.view') OR public.has_permission(organization_id, 'settings.manage'));
DROP POLICY IF EXISTS "opt_out_keywords_insert_admins" ON public.opt_out_keywords;
DROP POLICY IF EXISTS "opt_out_keywords_insert_permitted" ON public.opt_out_keywords;
CREATE POLICY "opt_out_keywords_insert_permitted" ON public.opt_out_keywords
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'settings.manage'));
DROP POLICY IF EXISTS "opt_out_keywords_delete_admins" ON public.opt_out_keywords;
DROP POLICY IF EXISTS "opt_out_keywords_delete_permitted" ON public.opt_out_keywords;
CREATE POLICY "opt_out_keywords_delete_permitted" ON public.opt_out_keywords
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'settings.manage'));

-- lead_source_markers
DROP POLICY IF EXISTS "lead_source_markers_select_members" ON public.lead_source_markers;
DROP POLICY IF EXISTS "lead_source_markers_select_members" ON public.lead_source_markers;
CREATE POLICY "lead_source_markers_select_members" ON public.lead_source_markers
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'contacts.view') OR public.has_permission(organization_id, 'settings.manage'));
DROP POLICY IF EXISTS "lead_source_markers_insert_admins" ON public.lead_source_markers;
DROP POLICY IF EXISTS "lead_source_markers_insert_permitted" ON public.lead_source_markers;
CREATE POLICY "lead_source_markers_insert_permitted" ON public.lead_source_markers
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'settings.manage'));
DROP POLICY IF EXISTS "lead_source_markers_update_admins" ON public.lead_source_markers;
DROP POLICY IF EXISTS "lead_source_markers_update_permitted" ON public.lead_source_markers;
CREATE POLICY "lead_source_markers_update_permitted" ON public.lead_source_markers
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'settings.manage'))
  WITH CHECK (public.has_permission(organization_id, 'settings.manage'));
DROP POLICY IF EXISTS "lead_source_markers_delete_admins" ON public.lead_source_markers;
DROP POLICY IF EXISTS "lead_source_markers_delete_permitted" ON public.lead_source_markers;
CREATE POLICY "lead_source_markers_delete_permitted" ON public.lead_source_markers
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'settings.manage'));

-- ============================================ super admin write audit =====
-- has_permission() already returns true for super admins, so every write policy
-- above admits them. Each such write leaves a trace in activity_log.
CREATE OR REPLACE FUNCTION public.log_super_admin_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  rec jsonb;
  v_org uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN rec := to_jsonb(OLD); ELSE rec := to_jsonb(NEW); END IF;
  v_org := nullif(rec->>'organization_id','')::uuid;

  -- A super admin acting inside their own workspace is a normal member action.
  IF v_org IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.organization_members m
    WHERE m.organization_id = v_org AND m.user_id = auth.uid()
  ) THEN
    INSERT INTO public.activity_log (organization_id, user_id, action, details)
    VALUES (v_org, auth.uid(), 'super_admin_write', jsonb_build_object(
      'by_super_admin', true,
      'table', TG_TABLE_NAME,
      'operation', TG_OP,
      'record_id', rec->>'id'
    ));
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contacts','contact_tags','contact_imports','segments','tags','campaigns',
    'message_templates','automations','conversations','messages',
    'opt_out_keywords','lead_source_markers','organization_members','member_permissions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS log_super_admin_write_trg ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER log_super_admin_write_trg AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION public.log_super_admin_write()', t);
  END LOOP;
END $$;

-- Invitation acceptance: the invitee joins themselves, so allow that path
-- when a valid pending invite for exactly that role exists.
CREATE OR REPLACE FUNCTION public.guard_member_role_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  actor uuid := auth.uid();
  actor_role text;
  member_count int;
BEGIN
  IF actor IS NULL OR public.is_super_admin() THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.role = OLD.role THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO member_count
  FROM public.organization_members m
  WHERE m.organization_id = NEW.organization_id;

  IF TG_OP = 'INSERT' AND member_count = 0 THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.user_id = actor AND EXISTS (
    SELECT 1 FROM public.invitations i
    WHERE i.organization_id = NEW.organization_id
      AND i.role = NEW.role
      AND i.accepted_at IS NULL
      AND i.expires_at > now()
  ) THEN
    RETURN NEW;
  END IF;

  SELECT m.role INTO actor_role
  FROM public.organization_members m
  WHERE m.organization_id = NEW.organization_id AND m.user_id = actor;

  IF actor_role IS NULL THEN
    RAISE EXCEPTION 'Only members of this workspace can manage its team.';
  END IF;

  IF public.role_rank(actor_role) <= public.role_rank(NEW.role) THEN
    RAISE EXCEPTION 'You can only assign roles below your own (your role: %, attempted: %).',
      actor_role, NEW.role;
  END IF;

  RETURN NEW;
END;
$$;
