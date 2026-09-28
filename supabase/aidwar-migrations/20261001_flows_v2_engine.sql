-- Flows v2, drop 1: versioned graphs, durable runs, run events.
-- Existing event flows keep running on flows/flow_steps/scheduled_sends; their
-- v1 graph is a faithful copy marked legacy so the new engine never runs them.

CREATE TABLE IF NOT EXISTS public.flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  graph jsonb NOT NULL DEFAULT '{"nodes":[],"edges":[]}'::jsonb,
  published_at timestamptz,
  published_by uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_versions_one_published
  ON public.flow_versions (flow_id) WHERE status = 'published';
CREATE INDEX IF NOT EXISTS flow_versions_org ON public.flow_versions (organization_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.flow_versions TO authenticated;
GRANT ALL ON public.flow_versions TO service_role;
ALTER TABLE public.flow_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read flow versions" ON public.flow_versions
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "Configurers insert flow versions" ON public.flow_versions
  FOR INSERT TO authenticated WITH CHECK (public.has_permission(organization_id, 'ai.configure'));
CREATE POLICY "Configurers update flow versions" ON public.flow_versions
  FOR UPDATE TO authenticated USING (public.has_permission(organization_id, 'ai.configure'))
  WITH CHECK (public.has_permission(organization_id, 'ai.configure'));
CREATE POLICY "Configurers delete draft versions" ON public.flow_versions
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'ai.configure') AND status = 'draft');

CREATE TRIGGER update_flow_versions_updated_at BEFORE UPDATE ON public.flow_versions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.flow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  flow_id uuid NOT NULL REFERENCES public.flows(id) ON DELETE CASCADE,
  version_id uuid NOT NULL REFERENCES public.flow_versions(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  current_node_id text,
  variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','waiting','paused','done','failed','expired','cancelled')),
  waiting_for text CHECK (waiting_for IN ('reply','timer')),
  wake_at timestamptz,
  steps integer NOT NULL DEFAULT 0,
  trigger jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  claimed_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS flow_runs_one_active
  ON public.flow_runs (flow_id, contact_id) WHERE status IN ('running','waiting','paused');
CREATE INDEX IF NOT EXISTS flow_runs_wake ON public.flow_runs (wake_at) WHERE status = 'waiting';
CREATE INDEX IF NOT EXISTS flow_runs_contact ON public.flow_runs (organization_id, contact_id, status);

GRANT SELECT ON public.flow_runs TO authenticated;
GRANT ALL ON public.flow_runs TO service_role;
ALTER TABLE public.flow_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read flow runs" ON public.flow_runs
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

CREATE TRIGGER update_flow_runs_updated_at BEFORE UPDATE ON public.flow_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.flow_run_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.flow_runs(id) ON DELETE CASCADE,
  node_id text,
  event text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text UNIQUE,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_run_events_run ON public.flow_run_events (run_id, at);

GRANT SELECT ON public.flow_run_events TO authenticated;
GRANT ALL ON public.flow_run_events TO service_role;
ALTER TABLE public.flow_run_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members read flow run events" ON public.flow_run_events
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

-- Claim due runs without two ticks taking the same one.
CREATE OR REPLACE FUNCTION public.claim_flow_runs(p_limit integer)
RETURNS SETOF public.flow_runs
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.flow_runs r
     SET claimed_at = now()
   WHERE r.id IN (
     SELECT id FROM public.flow_runs
      WHERE status = 'waiting' AND wake_at IS NOT NULL AND wake_at <= now()
        AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
      ORDER BY wake_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING r.*;
$$;
REVOKE ALL ON FUNCTION public.claim_flow_runs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_flow_runs(integer) TO service_role;

-- Flag: off for everyone, on for Ai Dwar.
INSERT INTO public.feature_flags (key, name, description, default_enabled)
VALUES ('flows_v2', 'Flows v2', 'Visual chat flows with questions, branches and actions.', false)
ON CONFLICT (key) DO UPDATE SET default_enabled = false;

INSERT INTO public.organization_feature_overrides (organization_id, flag_key, enabled)
SELECT id, 'flows_v2', true FROM public.organizations WHERE name = 'Ai Dwar'
ON CONFLICT (organization_id, flag_key) DO UPDATE SET enabled = true;

-- Every existing flow becomes a published v1 graph, step for step.
INSERT INTO public.flow_versions (organization_id, flow_id, version, status, graph, published_at)
SELECT f.organization_id, f.id, 1, 'published',
  jsonb_build_object(
    'meta', jsonb_build_object('legacy', true, 'flow_key', f.key),
    'nodes',
      jsonb_build_array(jsonb_build_object(
        'id', 'start', 'type', 'start', 'position', jsonb_build_object('x', 0, 'y', 0),
        'data', jsonb_build_object('trigger', jsonb_build_object('kind', 'event', 'event', f.key))))
      || coalesce((
        SELECT jsonb_agg(n ORDER BY ord)
          FROM (
            SELECT s.step_order * 2 AS ord, jsonb_build_object(
              'id', 'wait-' || s.id, 'type', 'wait',
              'position', jsonb_build_object('x', 0, 'y', s.step_order * 240 - 120),
              'data', jsonb_build_object('minutes', s.delay_minutes, 'legacy_step_id', s.id)) AS n
              FROM public.flow_steps s WHERE s.flow_id = f.id
            UNION ALL
            SELECT s.step_order * 2 + 1, jsonb_build_object(
              'id', 'send-' || s.id,
              'type', CASE WHEN s.condition->>'step_type' = 'send_form' THEN 'form' ELSE 'template' END,
              'position', jsonb_build_object('x', 0, 'y', s.step_order * 240),
              'data', jsonb_build_object(
                'template_id', s.template_id, 'form_id', s.condition->>'form_id',
                'condition', s.condition, 'enabled', s.is_enabled, 'legacy_step_id', s.id))
              FROM public.flow_steps s WHERE s.flow_id = f.id
          ) q), '[]'::jsonb)
      || jsonb_build_array(jsonb_build_object(
        'id', 'end', 'type', 'end', 'position', jsonb_build_object('x', 0, 'y', 99999), 'data', '{}'::jsonb)),
    'edges', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', 'e-' || src || '-' || tgt, 'source', src, 'target', tgt) ORDER BY i)
        FROM (
          SELECT i, id AS src, lead(id) OVER (ORDER BY i) AS tgt
            FROM (
              SELECT 0 AS i, 'start' AS id
              UNION ALL SELECT s.step_order * 2, 'wait-' || s.id FROM public.flow_steps s WHERE s.flow_id = f.id
              UNION ALL SELECT s.step_order * 2 + 1, 'send-' || s.id FROM public.flow_steps s WHERE s.flow_id = f.id
              UNION ALL SELECT 2147483647, 'end'
            ) chain
        ) pairs WHERE tgt IS NOT NULL), '[]'::jsonb)
  ),
  f.created_at
FROM public.flows f
WHERE NOT EXISTS (SELECT 1 FROM public.flow_versions v WHERE v.flow_id = f.id);
