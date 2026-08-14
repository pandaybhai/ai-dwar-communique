-- Lead source attribution (first-touch, never overwritten)
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'direct',
  ADD COLUMN IF NOT EXISTS source_detail jsonb;

CREATE INDEX IF NOT EXISTS contacts_source_idx ON public.contacts (organization_id, source);

-- First-touch guard: source and source_detail are set at creation only.
CREATE OR REPLACE FUNCTION public.freeze_contact_source()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.source := OLD.source;
  NEW.source_detail := OLD.source_detail;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS freeze_contact_source ON public.contacts;
CREATE TRIGGER freeze_contact_source
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.freeze_contact_source();

-- Org-level first-message markers → lead source
CREATE TABLE IF NOT EXISTS public.lead_source_markers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  marker text NOT NULL,
  source text NOT NULL,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS lead_source_markers_unique
  ON public.lead_source_markers (organization_id, lower(marker));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.lead_source_markers TO authenticated;
GRANT ALL ON public.lead_source_markers TO service_role;

ALTER TABLE public.lead_source_markers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lead_source_markers_select_members" ON public.lead_source_markers;
CREATE POLICY "lead_source_markers_select_members" ON public.lead_source_markers
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "lead_source_markers_insert_admins" ON public.lead_source_markers;
CREATE POLICY "lead_source_markers_insert_admins" ON public.lead_source_markers
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin'));

DROP POLICY IF EXISTS "lead_source_markers_update_admins" ON public.lead_source_markers;
CREATE POLICY "lead_source_markers_update_admins" ON public.lead_source_markers
  FOR UPDATE TO authenticated
  USING (public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin'))
  WITH CHECK (public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin'));

DROP POLICY IF EXISTS "lead_source_markers_delete_admins" ON public.lead_source_markers;
CREATE POLICY "lead_source_markers_delete_admins" ON public.lead_source_markers
  FOR DELETE TO authenticated
  USING (public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin'));

DROP TRIGGER IF EXISTS update_lead_source_markers_updated_at ON public.lead_source_markers;
CREATE TRIGGER update_lead_source_markers_updated_at
  BEFORE UPDATE ON public.lead_source_markers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Contacts-by-source breakdown for the Contacts page
CREATE OR REPLACE FUNCTION public.contacts_source_breakdown(p_organization_id uuid)
RETURNS TABLE (source text, contacts bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.source, count(*)::bigint
  FROM public.contacts c
  WHERE c.organization_id = p_organization_id
    AND public.is_org_member(p_organization_id)
  GROUP BY c.source
  ORDER BY count(*) DESC;
$$;

REVOKE ALL ON FUNCTION public.contacts_source_breakdown(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.contacts_source_breakdown(uuid) TO authenticated, service_role;
