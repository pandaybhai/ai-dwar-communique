-- The AI employee, part 1: the model layer.
--
-- Everything here is off until a Super Admin turns the feature on and an
-- admin turns the workspace's own switch on. Nothing calls a model except
-- /api/internal/ai-run, which reads these tables.

-- ------------------------------------------------------- 1. the employee(s)
CREATE TABLE IF NOT EXISTS public.ai_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Aiden',
  avatar text,
  -- off: does nothing. draft: writes a suggestion a human sends.
  -- replying: answers the customer itself.
  mode text NOT NULL DEFAULT 'off' CHECK (mode IN ('off','draft','replying')),
  is_default boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One default per workspace. The table permits more agents later without a
-- migration across instructions, runs and knowledge.
CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_one_default_idx
  ON public.ai_agents (organization_id) WHERE is_default;

-- --------------------------------------------------- 2. workspace AI switch
CREATE TABLE IF NOT EXISTS public.organization_ai_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  ai_enabled boolean NOT NULL DEFAULT false,
  ai_monthly_cap_amount numeric NOT NULL DEFAULT 500 CHECK (ai_monthly_cap_amount >= 0),
  currency text NOT NULL DEFAULT 'INR',
  -- 'recommended' lets the platform pick per task; 'manual' honours ai_task_models.
  brain_choice text NOT NULL DEFAULT 'recommended' CHECK (brain_choice IN ('recommended','manual')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------ 3. providers
-- Only the Vault secret *name* lives here. Keys never leave the server.
CREATE TABLE IF NOT EXISTS public.ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('anthropic','openai','google','lovable')),
  model text,
  is_default boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','error')),
  vault_secret_name text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_providers_one_default_idx
  ON public.ai_providers (organization_id) WHERE is_default;

-- -------------------------------------------------------- 4. brain catalogue
-- Merchants pick from this list, never a free-text model id: a retired model
-- typed by hand fails silently at the worst moment.
CREATE TABLE IF NOT EXISTS public.ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('anthropic','openai','google','lovable')),
  model_id text NOT NULL,
  display_name text NOT NULL,
  -- Written for a merchant, in outcomes: "Faster and cheaper — good for sorting".
  plain_description text NOT NULL DEFAULT '',
  is_available boolean NOT NULL DEFAULT true,
  supports_tools boolean NOT NULL DEFAULT false,
  context_window integer,
  recommended_for text[] NOT NULL DEFAULT '{}',
  is_deprecated boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, model_id)
);

-- ------------------------------------------------------- 5. brain per task
CREATE TABLE IF NOT EXISTS public.ai_task_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  task text NOT NULL CHECK (task IN ('suggest_reply','summarise','auto_tag','agent_reply','embedding')),
  provider text NOT NULL CHECK (provider IN ('anthropic','openai','google','lovable')),
  model_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_task_models_org_task_idx
  ON public.ai_task_models (organization_id, task) WHERE agent_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_task_models_agent_task_idx
  ON public.ai_task_models (agent_id, task) WHERE agent_id IS NOT NULL;

-- A brain that cannot call tools cannot hold a customer conversation, because
-- every real answer needs an order or stock lookup. Enforced here, not just in
-- the picker.
CREATE OR REPLACE FUNCTION public.ai_task_models_validate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m public.ai_models%ROWTYPE;
BEGIN
  SELECT * INTO m FROM public.ai_models
   WHERE provider = NEW.provider AND model_id = NEW.model_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown brain %/%', NEW.provider, NEW.model_id;
  END IF;
  IF m.is_available = false OR m.is_deprecated THEN
    RAISE EXCEPTION 'That brain is no longer available.';
  END IF;
  IF NEW.task = 'agent_reply' AND m.supports_tools = false THEN
    RAISE EXCEPTION 'That brain cannot look things up, so it cannot talk to customers.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_task_models_validate_trg ON public.ai_task_models;
CREATE TRIGGER ai_task_models_validate_trg
  BEFORE INSERT OR UPDATE ON public.ai_task_models
  FOR EACH ROW EXECUTE FUNCTION public.ai_task_models_validate();

-- ------------------------------------------------------------- 6. rate card
CREATE TABLE IF NOT EXISTS public.ai_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  model text NOT NULL,
  -- Currency units per 1,000,000 tokens.
  input_rate numeric NOT NULL CHECK (input_rate >= 0),
  output_rate numeric NOT NULL CHECK (output_rate >= 0),
  currency text NOT NULL DEFAULT 'INR',
  effective_from date NOT NULL,
  effective_to date,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_rates_unique_period_idx
  ON public.ai_rates (provider, model, effective_from);

-- ----------------------------------------------------------- 7. every run
CREATE TABLE IF NOT EXISTS public.ai_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  user_id uuid,
  acting_role text,
  provider text NOT NULL,
  model text NOT NULL,
  task text NOT NULL,
  input_summary text,
  output text,
  -- Kept for later analysis only. Escalation never depends on it.
  confidence numeric,
  escalation_signal text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  tool_call_count integer NOT NULL DEFAULT 0,
  input_tokens integer,
  output_tokens integer,
  cost_amount numeric,
  cost_currency text,
  cost_source text CHECK (cost_source IS NULL OR cost_source IN ('rate_card','provider','unknown')),
  latency_ms integer,
  status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','refused','escalated','capped','error')),
  error text,
  comparison_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_runs_org_created_idx
  ON public.ai_runs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_org_task_idx
  ON public.ai_runs (organization_id, task, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_runs_comparison_idx
  ON public.ai_runs (comparison_id) WHERE comparison_id IS NOT NULL;

-- ------------------------------------------------------- 8. every tool call
-- Points at the activity_log row the broker already wrote instead of copying
-- it, so there is exactly one record of what the AI did.
CREATE TABLE IF NOT EXISTS public.ai_tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.ai_runs(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  ok boolean NOT NULL,
  error text,
  latency_ms integer,
  activity_log_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_tool_calls_run_idx ON public.ai_tool_calls (run_id);

-- ------------------------------------------------------------- 9. rollups
CREATE TABLE IF NOT EXISTS public.ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  task text NOT NULL,
  runs integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'INR',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, usage_date, task)
);

-- ------------------------------------------------------- grants and policies
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_agents TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.organization_ai_settings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_providers TO authenticated;
GRANT SELECT ON public.ai_models TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_task_models TO authenticated;
GRANT SELECT ON public.ai_rates TO authenticated;
GRANT SELECT ON public.ai_runs TO authenticated;
GRANT SELECT ON public.ai_tool_calls TO authenticated;
GRANT SELECT ON public.ai_usage TO authenticated;
GRANT ALL ON public.ai_agents, public.organization_ai_settings, public.ai_providers,
  public.ai_models, public.ai_task_models, public.ai_rates, public.ai_runs,
  public.ai_tool_calls, public.ai_usage TO service_role;

ALTER TABLE public.ai_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_task_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_tool_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_agents_select" ON public.ai_agents;
CREATE POLICY "ai_agents_select" ON public.ai_agents FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());
DROP POLICY IF EXISTS "ai_agents_write" ON public.ai_agents;
CREATE POLICY "ai_agents_write" ON public.ai_agents FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'ai.configure'))
  WITH CHECK (public.has_permission(organization_id, 'ai.configure'));

DROP POLICY IF EXISTS "organization_ai_settings_select" ON public.organization_ai_settings;
CREATE POLICY "organization_ai_settings_select" ON public.organization_ai_settings
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());
DROP POLICY IF EXISTS "organization_ai_settings_write" ON public.organization_ai_settings;
CREATE POLICY "organization_ai_settings_write" ON public.organization_ai_settings
  FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'ai.configure'))
  WITH CHECK (public.has_permission(organization_id, 'ai.configure'));

-- Providers hold a Vault secret *name*; even so, only configurers see the row.
DROP POLICY IF EXISTS "ai_providers_all" ON public.ai_providers;
CREATE POLICY "ai_providers_all" ON public.ai_providers FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'ai.configure'))
  WITH CHECK (public.has_permission(organization_id, 'ai.configure'));

-- The brain catalogue and rate card are platform reference data.
DROP POLICY IF EXISTS "ai_models_select" ON public.ai_models;
CREATE POLICY "ai_models_select" ON public.ai_models FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "ai_rates_select" ON public.ai_rates;
CREATE POLICY "ai_rates_select" ON public.ai_rates FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "ai_task_models_select" ON public.ai_task_models;
CREATE POLICY "ai_task_models_select" ON public.ai_task_models FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());
DROP POLICY IF EXISTS "ai_task_models_write" ON public.ai_task_models;
CREATE POLICY "ai_task_models_write" ON public.ai_task_models FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'ai.configure'))
  WITH CHECK (public.has_permission(organization_id, 'ai.configure'));

-- Runs, tool calls and rollups are written only by the platform.
DROP POLICY IF EXISTS "ai_runs_select" ON public.ai_runs;
CREATE POLICY "ai_runs_select" ON public.ai_runs FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());
DROP POLICY IF EXISTS "ai_tool_calls_select" ON public.ai_tool_calls;
CREATE POLICY "ai_tool_calls_select" ON public.ai_tool_calls FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());
DROP POLICY IF EXISTS "ai_usage_select" ON public.ai_usage;
CREATE POLICY "ai_usage_select" ON public.ai_usage FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());

-- ------------------------------------------------------------- timestamps
DROP TRIGGER IF EXISTS ai_agents_updated_at ON public.ai_agents;
CREATE TRIGGER ai_agents_updated_at BEFORE UPDATE ON public.ai_agents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS organization_ai_settings_updated_at ON public.organization_ai_settings;
CREATE TRIGGER organization_ai_settings_updated_at BEFORE UPDATE ON public.organization_ai_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS ai_providers_updated_at ON public.ai_providers;
CREATE TRIGGER ai_providers_updated_at BEFORE UPDATE ON public.ai_providers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS ai_task_models_updated_at ON public.ai_task_models;
CREATE TRIGGER ai_task_models_updated_at BEFORE UPDATE ON public.ai_task_models
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- --------------------------------------------------------- brain catalogue
-- Descriptions are the merchant-facing words used on screen.
INSERT INTO public.ai_models
  (provider, model_id, display_name, plain_description, supports_tools, context_window, recommended_for)
VALUES
  ('lovable', 'google/gemini-3.6-flash', 'Everyday',
   'Quick and inexpensive — good for sorting, tagging and summarising.',
   true, 1000000, ARRAY['auto_tag','summarise','suggest_reply']),
  ('lovable', 'google/gemini-3.1-flash-lite', 'Quick',
   'The cheapest and fastest — best for simple sorting jobs.',
   true, 1000000, ARRAY['auto_tag']),
  ('lovable', 'openai/gpt-5.4', 'Careful',
   'Smarter and more careful — use this when talking to customers.',
   true, 400000, ARRAY['agent_reply','suggest_reply']),
  ('lovable', 'openai/gpt-5.6-terra', 'Sharpest',
   'The most capable — slowest and dearest, for the trickiest questions.',
   true, 400000, ARRAY['agent_reply']),
  ('lovable', 'openai/text-embedding-3-small', 'Reading and remembering',
   'Used behind the scenes so your AI employee can find the right page or row.',
   false, 8191, ARRAY['embedding'])
ON CONFLICT (provider, model_id) DO UPDATE SET
  display_name = excluded.display_name,
  plain_description = excluded.plain_description,
  supports_tools = excluded.supports_tools,
  context_window = excluded.context_window,
  recommended_for = excluded.recommended_for,
  is_available = true,
  is_deprecated = false,
  updated_at = now();

-- Rates are data. Indicative INR per million tokens; revise by inserting a new
-- effective_from row, never by editing code.
INSERT INTO public.ai_rates (provider, model, input_rate, output_rate, currency, effective_from)
VALUES
  ('lovable', 'google/gemini-3.6-flash',        25,   200, 'INR', DATE '2026-01-01'),
  ('lovable', 'google/gemini-3.1-flash-lite',   9,     36, 'INR', DATE '2026-01-01'),
  ('lovable', 'openai/gpt-5.4',                110,   880, 'INR', DATE '2026-01-01'),
  ('lovable', 'openai/gpt-5.6-terra',          220,  1760, 'INR', DATE '2026-01-01'),
  ('lovable', 'openai/text-embedding-3-small',   2,     0, 'INR', DATE '2026-01-01')
ON CONFLICT (provider, model, effective_from) DO NOTHING;

-- ------------------------------------------------------------- seed per org
INSERT INTO public.ai_agents (organization_id, name, mode, is_default)
SELECT o.id, 'Aiden', 'off', true FROM public.organizations o
WHERE NOT EXISTS (SELECT 1 FROM public.ai_agents a WHERE a.organization_id = o.id)
ON CONFLICT DO NOTHING;

INSERT INTO public.organization_ai_settings (organization_id)
SELECT o.id FROM public.organizations o
ON CONFLICT (organization_id) DO NOTHING;

INSERT INTO public.ai_task_models (organization_id, task, provider, model_id)
SELECT o.id, t.task, 'lovable', t.model_id
FROM public.organizations o
CROSS JOIN (VALUES
  ('auto_tag',     'google/gemini-3.1-flash-lite'),
  ('summarise',    'google/gemini-3.6-flash'),
  ('suggest_reply','google/gemini-3.6-flash'),
  ('agent_reply',  'openai/gpt-5.4'),
  ('embedding',    'openai/text-embedding-3-small')
) AS t(task, model_id)
ON CONFLICT DO NOTHING;

-- New workspaces get the same off-by-default setup.
CREATE OR REPLACE FUNCTION public.seed_org_ai_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.ai_agents (organization_id, name, mode, is_default)
  VALUES (NEW.id, 'Aiden', 'off', true)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.organization_ai_settings (organization_id)
  VALUES (NEW.id)
  ON CONFLICT (organization_id) DO NOTHING;

  INSERT INTO public.ai_task_models (organization_id, task, provider, model_id)
  VALUES
    (NEW.id, 'auto_tag',      'lovable', 'google/gemini-3.1-flash-lite'),
    (NEW.id, 'summarise',     'lovable', 'google/gemini-3.6-flash'),
    (NEW.id, 'suggest_reply', 'lovable', 'google/gemini-3.6-flash'),
    (NEW.id, 'agent_reply',   'lovable', 'openai/gpt-5.4'),
    (NEW.id, 'embedding',     'lovable', 'openai/text-embedding-3-small')
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_seed_ai_defaults ON public.organizations;
CREATE TRIGGER organizations_seed_ai_defaults
  AFTER INSERT ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.seed_org_ai_defaults();

-- ------------------------------------------------------------- kill switch
-- Nothing appears until a Super Admin enables it, whatever the flag said before.
UPDATE public.feature_flags SET default_enabled = false WHERE key = 'ai_features';

-- ------------------------------------------------------- spend against cap
-- Real recorded spend this calendar month, in the workspace's currency.
CREATE OR REPLACE FUNCTION public.ai_month_spend(p_org uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(cost_amount), 0)
  FROM public.ai_runs
  WHERE organization_id = p_org
    AND cost_amount IS NOT NULL
    AND created_at >= date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))
        AT TIME ZONE 'Asia/Kolkata';
$$;

GRANT EXECUTE ON FUNCTION public.ai_month_spend(uuid) TO authenticated, service_role;
