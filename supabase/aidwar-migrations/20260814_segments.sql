-- Audience segments (always dynamic: filters only, never stored member lists)
CREATE TABLE IF NOT EXISTS public.segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.segments TO authenticated;
GRANT ALL ON public.segments TO service_role;
ALTER TABLE public.segments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "segments_select_members" ON public.segments;
CREATE POLICY "segments_select_members" ON public.segments
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
DROP POLICY IF EXISTS "segments_insert_members" ON public.segments;
CREATE POLICY "segments_insert_members" ON public.segments
  FOR INSERT TO authenticated WITH CHECK (public.is_org_member(organization_id));
DROP POLICY IF EXISTS "segments_update_members" ON public.segments;
CREATE POLICY "segments_update_members" ON public.segments
  FOR UPDATE TO authenticated USING (public.is_org_member(organization_id))
  WITH CHECK (public.is_org_member(organization_id));
DROP POLICY IF EXISTS "segments_delete_admins" ON public.segments;
CREATE POLICY "segments_delete_admins" ON public.segments
  FOR DELETE TO authenticated USING (public.has_org_role(organization_id, 'admin'));

CREATE INDEX IF NOT EXISTS segments_org_idx ON public.segments(organization_id);

DROP TRIGGER IF EXISTS update_segments_updated_at ON public.segments;
CREATE TRIGGER update_segments_updated_at
  BEFORE UPDATE ON public.segments
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
