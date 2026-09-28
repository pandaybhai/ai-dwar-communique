-- Flows v2 live-test fixes (28 Sep).
-- (b) Record EVERY trigger fire (trigger, flow, contact, run). The old
--     one-row-per-contact constraint silently dropped repeat fires; the
--     no-reply "fire once" rule is now checked in code.
ALTER TABLE public.flow_trigger_fires DROP CONSTRAINT IF EXISTS flow_trigger_fires_trigger_id_contact_id_key;
ALTER TABLE public.flow_trigger_fires ADD COLUMN IF NOT EXISTS flow_id uuid REFERENCES public.flows(id) ON DELETE CASCADE;
ALTER TABLE public.flow_trigger_fires ADD COLUMN IF NOT EXISTS kind text;
CREATE INDEX IF NOT EXISTS flow_trigger_fires_trigger_contact ON public.flow_trigger_fires (trigger_id, contact_id);
CREATE INDEX IF NOT EXISTS flow_trigger_fires_org_flow ON public.flow_trigger_fires (organization_id, flow_id, fired_at DESC);

-- Backfill fires from runs that were started by a trigger.
INSERT INTO public.flow_trigger_fires (organization_id, trigger_id, flow_id, kind, contact_id, run_id, fired_at)
SELECT r.organization_id, (r.trigger->>'trigger_id')::uuid, r.flow_id, r.trigger->>'kind', r.contact_id, r.id, r.started_at
FROM public.flow_runs r
JOIN public.flow_triggers t ON t.id = (r.trigger->>'trigger_id')::uuid
WHERE r.trigger ? 'trigger_id'
  AND (r.trigger->>'trigger_id') ~ '^[0-9a-f-]{36}$'
  AND NOT EXISTS (SELECT 1 FROM public.flow_trigger_fires f WHERE f.run_id = r.id);

-- (e) "Create order draft" step. Kept apart from public.orders so a draft is
--     never counted as revenue or attributed to a campaign.
CREATE TABLE IF NOT EXISTS public.flow_order_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  flow_id uuid REFERENCES public.flows(id) ON DELETE SET NULL,
  run_id uuid REFERENCES public.flow_runs(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  items text,
  total numeric,
  notes text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'confirmed', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_order_drafts_org ON public.flow_order_drafts (organization_id, created_at DESC);
GRANT SELECT, UPDATE ON public.flow_order_drafts TO authenticated;
GRANT ALL ON public.flow_order_drafts TO service_role;
ALTER TABLE public.flow_order_drafts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read order drafts" ON public.flow_order_drafts
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "Editors update order drafts" ON public.flow_order_drafts
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'flows_v2.edit'))
  WITH CHECK (public.has_permission(organization_id, 'flows_v2.edit'));
CREATE TRIGGER update_flow_order_drafts_updated_at BEFORE UPDATE ON public.flow_order_drafts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
