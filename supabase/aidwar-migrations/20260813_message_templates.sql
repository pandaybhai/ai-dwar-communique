-- WhatsApp message templates (per organization)
CREATE TABLE IF NOT EXISTS public.message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  meta_template_id text,
  name text NOT NULL,
  language text NOT NULL DEFAULT 'en_US',
  category text CHECK (category IN ('MARKETING','UTILITY','AUTHENTICATION')),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','PAUSED')),
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, name, language)
);

CREATE INDEX IF NOT EXISTS message_templates_org_idx ON public.message_templates (organization_id, status);
CREATE INDEX IF NOT EXISTS message_templates_meta_idx ON public.message_templates (meta_template_id);

GRANT SELECT, INSERT, UPDATE ON public.message_templates TO authenticated;
GRANT ALL ON public.message_templates TO service_role;

ALTER TABLE public.message_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org members read templates" ON public.message_templates;
CREATE POLICY "org members read templates"
  ON public.message_templates FOR SELECT TO authenticated
  USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "org admins insert templates" ON public.message_templates;
CREATE POLICY "org admins insert templates"
  ON public.message_templates FOR INSERT TO authenticated
  WITH CHECK ((public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin')));

DROP POLICY IF EXISTS "org admins update templates" ON public.message_templates;
CREATE POLICY "org admins update templates"
  ON public.message_templates FOR UPDATE TO authenticated
  USING ((public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin')))
  WITH CHECK ((public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin')));
