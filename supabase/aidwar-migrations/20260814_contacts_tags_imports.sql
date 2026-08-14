-- Phase: contact management (tags, contact_tags, contact_imports)
-- All RLS via the existing security definer helpers is_org_member / has_org_role.

-- ============ tags ============
CREATE TABLE IF NOT EXISTS public.tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#10B981',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tags TO authenticated;
GRANT ALL ON public.tags TO service_role;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tags_select_members" ON public.tags
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "tags_insert_members" ON public.tags
  FOR INSERT TO authenticated WITH CHECK (public.is_org_member(organization_id));
CREATE POLICY "tags_update_members" ON public.tags
  FOR UPDATE TO authenticated USING (public.is_org_member(organization_id))
  WITH CHECK (public.is_org_member(organization_id));
CREATE POLICY "tags_delete_admins" ON public.tags
  FOR DELETE TO authenticated USING (public.has_org_role(organization_id, 'admin'));
CREATE INDEX IF NOT EXISTS tags_org_idx ON public.tags(organization_id);

-- ============ contact_tags ============
CREATE TABLE IF NOT EXISTS public.contact_tags (
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contact_tags TO authenticated;
GRANT ALL ON public.contact_tags TO service_role;
ALTER TABLE public.contact_tags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "contact_tags_select_members" ON public.contact_tags
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "contact_tags_insert_members" ON public.contact_tags
  FOR INSERT TO authenticated WITH CHECK (public.is_org_member(organization_id));
CREATE POLICY "contact_tags_delete_members" ON public.contact_tags
  FOR DELETE TO authenticated USING (public.is_org_member(organization_id));
CREATE INDEX IF NOT EXISTS contact_tags_tag_idx ON public.contact_tags(tag_id);
CREATE INDEX IF NOT EXISTS contact_tags_org_idx ON public.contact_tags(organization_id);

-- ============ contact_imports ============
CREATE TABLE IF NOT EXISTS public.contact_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  filename text,
  total_rows int NOT NULL DEFAULT 0,
  created_count int NOT NULL DEFAULT 0,
  updated_count int NOT NULL DEFAULT 0,
  skipped_count int NOT NULL DEFAULT 0,
  error_report jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'processing' CHECK (status IN ('processing','completed','failed')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.contact_imports TO authenticated;
GRANT ALL ON public.contact_imports TO service_role;
ALTER TABLE public.contact_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY "contact_imports_select_members" ON public.contact_imports
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "contact_imports_insert_admins" ON public.contact_imports
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(organization_id, 'admin'));
CREATE POLICY "contact_imports_update_admins" ON public.contact_imports
  FOR UPDATE TO authenticated USING (public.has_org_role(organization_id, 'admin'))
  WITH CHECK (public.has_org_role(organization_id, 'admin'));
CREATE INDEX IF NOT EXISTS contact_imports_org_created_idx
  ON public.contact_imports(organization_id, created_at DESC);
