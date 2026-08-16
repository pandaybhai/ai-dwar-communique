-- Automations engine v1: welcome / keyword / away auto-replies
CREATE TABLE IF NOT EXISTS public.automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('welcome', 'keyword', 'away')),
  is_active boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 100,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  message_body text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automations TO authenticated;
GRANT ALL ON public.automations TO service_role;
ALTER TABLE public.automations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "automations_select_members" ON public.automations;
CREATE POLICY "automations_select_members" ON public.automations
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
-- has_org_role is an exact role match, so owners must be named explicitly.
DROP POLICY IF EXISTS "automations_insert_admins" ON public.automations;
CREATE POLICY "automations_insert_admins" ON public.automations
  FOR INSERT TO authenticated WITH CHECK (public.has_org_role(organization_id, 'admin') OR public.has_org_role(organization_id, 'owner'));
DROP POLICY IF EXISTS "automations_update_admins" ON public.automations;
CREATE POLICY "automations_update_admins" ON public.automations
  FOR UPDATE TO authenticated USING (public.has_org_role(organization_id, 'admin') OR public.has_org_role(organization_id, 'owner'))
  WITH CHECK (public.has_org_role(organization_id, 'admin') OR public.has_org_role(organization_id, 'owner'));
DROP POLICY IF EXISTS "automations_delete_admins" ON public.automations;
CREATE POLICY "automations_delete_admins" ON public.automations
  FOR DELETE TO authenticated USING (public.has_org_role(organization_id, 'admin') OR public.has_org_role(organization_id, 'owner'));

CREATE INDEX IF NOT EXISTS automations_org_active_idx
  ON public.automations(organization_id, is_active, priority);

DROP TRIGGER IF EXISTS update_automations_updated_at ON public.automations;
CREATE TRIGGER update_automations_updated_at
  BEFORE UPDATE ON public.automations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Every evaluation writes a row here, including skips.
CREATE TABLE IF NOT EXISTS public.automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  automation_id uuid NOT NULL REFERENCES public.automations(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  inbound_message_id text,
  outbound_message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('sent', 'skipped', 'failed')),
  skip_reason text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.automation_runs TO authenticated;
GRANT ALL ON public.automation_runs TO service_role;
ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "automation_runs_select_members" ON public.automation_runs;
CREATE POLICY "automation_runs_select_members" ON public.automation_runs
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

CREATE INDEX IF NOT EXISTS automation_runs_lookup_idx
  ON public.automation_runs(organization_id, automation_id, contact_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_message_unique_idx
  ON public.automation_runs(automation_id, inbound_message_id);
