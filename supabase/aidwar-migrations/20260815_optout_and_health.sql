-- Opt-out handling + account health monitoring

-- ---------------------------------------------------------------- opt-out --
CREATE TABLE IF NOT EXISTS public.opt_out_keywords (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  keyword text NOT NULL,
  action text NOT NULL DEFAULT 'opt_out' CHECK (action IN ('opt_out', 'opt_in')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS opt_out_keywords_unique
  ON public.opt_out_keywords (organization_id, action, lower(keyword));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.opt_out_keywords TO authenticated;
GRANT ALL ON public.opt_out_keywords TO service_role;

ALTER TABLE public.opt_out_keywords ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "opt_out_keywords_select_members" ON public.opt_out_keywords;
CREATE POLICY "opt_out_keywords_select_members" ON public.opt_out_keywords
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "opt_out_keywords_insert_admins" ON public.opt_out_keywords;
CREATE POLICY "opt_out_keywords_insert_admins" ON public.opt_out_keywords
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin'));

DROP POLICY IF EXISTS "opt_out_keywords_delete_admins" ON public.opt_out_keywords;
CREATE POLICY "opt_out_keywords_delete_admins" ON public.opt_out_keywords
  FOR DELETE TO authenticated
  USING (public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin'));

-- --------------------------------------------------------- account health --
ALTER TABLE public.whatsapp_accounts
  ADD COLUMN IF NOT EXISTS quality_updated_at timestamptz;

-- Super Admin needs cross-org read for the quality column on /admin/organizations
DROP POLICY IF EXISTS "whatsapp_accounts_select_super_admin" ON public.whatsapp_accounts;
CREATE POLICY "whatsapp_accounts_select_super_admin" ON public.whatsapp_accounts
  FOR SELECT TO authenticated USING (public.is_super_admin());
