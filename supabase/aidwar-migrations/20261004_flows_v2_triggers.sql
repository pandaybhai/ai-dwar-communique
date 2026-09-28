-- Flows v2, drop 3: triggers + run visibility.
-- One row per trigger; a published v2 flow can have several. Legacy event
-- flows (graph.meta.legacy) never get triggers — they keep their own path.

CREATE TABLE IF NOT EXISTS public.flow_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN (
    'keyword', 'first_message', 'ctwa_ad', 'store_event', 'form_submitted',
    'tag_added', 'campaign_button', 'no_reply', 'manual')),
  -- keyword: {keywords: string[], match: exact|contains|starts_with}
  -- store_event: {event: string}         form_submitted: {form_id: uuid|null}
  -- tag_added: {tag: string}             campaign_button: {campaign_id: uuid|null, button: string|null}
  -- no_reply: {days: int}                first_message / ctwa_ad / manual: {}
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_triggers_org ON public.flow_triggers (organization_id, kind) WHERE is_enabled;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.flow_triggers TO authenticated;
GRANT ALL ON public.flow_triggers TO service_role;
ALTER TABLE public.flow_triggers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read flow triggers" ON public.flow_triggers
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "Configurers insert flow triggers" ON public.flow_triggers
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'ai.configure'));
CREATE POLICY "Configurers update flow triggers" ON public.flow_triggers
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'ai.configure'))
  WITH CHECK (public.has_permission(organization_id, 'ai.configure'));
CREATE POLICY "Configurers delete flow triggers" ON public.flow_triggers
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'ai.configure'));

CREATE TRIGGER update_flow_triggers_updated_at BEFORE UPDATE ON public.flow_triggers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- No-reply trigger bookkeeping: the contact+trigger pairs already started, so
-- the minute tick doesn't re-fire every pass.
CREATE TABLE IF NOT EXISTS public.flow_trigger_fires (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  trigger_id uuid NOT NULL REFERENCES public.flow_triggers(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  run_id uuid REFERENCES public.flow_runs(id) ON DELETE SET NULL,
  fired_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trigger_id, contact_id)
);
GRANT SELECT ON public.flow_trigger_fires TO authenticated;
GRANT ALL ON public.flow_trigger_fires TO service_role;
ALTER TABLE public.flow_trigger_fires ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read trigger fires" ON public.flow_trigger_fires
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
