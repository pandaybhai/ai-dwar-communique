-- AI is resold, not passed through.
--
--  * Provider API keys become platform property, held in Vault and managed by
--    Super Admin. ai_providers stays behind as an optional per-organisation
--    override for enterprise bring-your-own-account, seeded empty and hidden
--    from ordinary merchants.
--  * Every run now carries two prices: cost_amount (what the provider charges
--    the platform, never shown to a merchant) and billed_amount (what the
--    merchant pays = cost x markup). The monthly cap enforces on billed_amount.
--  * Merchants choose a tier ("Everyday", "Careful"), never a vendor or model.

-- ---------------------------------------------------------------- platform

CREATE TABLE IF NOT EXISTS public.platform_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  ai_markup_multiplier numeric NOT NULL DEFAULT 3.0 CHECK (ai_markup_multiplier >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.platform_settings TO authenticated;
GRANT ALL ON public.platform_settings TO service_role;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_settings_select ON public.platform_settings;
CREATE POLICY platform_settings_select ON public.platform_settings
  FOR SELECT TO authenticated USING (public.is_super_admin());

INSERT INTO public.platform_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Provider credentials at platform scope. Only the Vault secret *name* is
-- stored here; the key itself never leaves Vault or the server.
CREATE TABLE IF NOT EXISTS public.platform_ai_providers (
  provider text PRIMARY KEY CHECK (provider IN ('anthropic', 'openai', 'google', 'lovable')),
  vault_secret_name text,
  is_active boolean NOT NULL DEFAULT true,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.platform_ai_providers TO authenticated;
GRANT ALL ON public.platform_ai_providers TO service_role;
ALTER TABLE public.platform_ai_providers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_ai_providers_select ON public.platform_ai_providers;
CREATE POLICY platform_ai_providers_select ON public.platform_ai_providers
  FOR SELECT TO authenticated USING (public.is_super_admin());

INSERT INTO public.platform_ai_providers (provider) VALUES ('lovable')
  ON CONFLICT (provider) DO NOTHING;

-- Writing a platform key. Service role only: never reachable from a browser.
CREATE OR REPLACE FUNCTION public.platform_set_ai_key(p_provider text, p_key text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_name text := 'platform_ai_' || p_provider;
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = v_name;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(p_key, v_name, 'Platform AI provider key');
  ELSE
    PERFORM vault.update_secret(v_id, p_key);
  END IF;

  INSERT INTO public.platform_ai_providers (provider, vault_secret_name, is_active, last_error, updated_at)
  VALUES (p_provider, v_name, true, NULL, now())
  ON CONFLICT (provider) DO UPDATE
    SET vault_secret_name = EXCLUDED.vault_secret_name,
        is_active = true,
        last_error = NULL,
        updated_at = now();

  RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_set_ai_key(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_ai_key(text, text) TO service_role;

-- ------------------------------------------------------------------- tiers

CREATE TABLE IF NOT EXISTS public.ai_tiers (
  key text PRIMARY KEY,
  display_name text NOT NULL,
  plain_description text NOT NULL DEFAULT '',
  speed_text text NOT NULL DEFAULT '',
  quality_text text NOT NULL DEFAULT '',
  relative_cost_text text NOT NULL DEFAULT '',
  provider text NOT NULL,
  model_id text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (provider, model_id) REFERENCES public.ai_models (provider, model_id)
);

GRANT ALL ON public.ai_tiers TO service_role;
-- Merchants may read the words, never the vendor or the model behind them.
REVOKE SELECT ON public.ai_tiers FROM authenticated;
GRANT SELECT (key, display_name, plain_description, speed_text, quality_text,
              relative_cost_text, is_active, sort_order, updated_at)
  ON public.ai_tiers TO authenticated;
ALTER TABLE public.ai_tiers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_tiers_select ON public.ai_tiers;
CREATE POLICY ai_tiers_select ON public.ai_tiers
  FOR SELECT TO authenticated USING (is_active OR public.is_super_admin());

INSERT INTO public.ai_tiers
  (key, display_name, plain_description, speed_text, quality_text, relative_cost_text, provider, model_id, sort_order)
VALUES
  ('everyday', 'Everyday',
   'My default. Quick, dependable answers for the questions customers ask all day.',
   'Answers in a second or two', 'Good on ordinary questions', 'Costs the least', 'lovable', 'google/gemini-3.6-flash', 1),
  ('careful', 'Careful',
   'Slower and more thorough. Worth it when the question is complicated or the customer is upset.',
   'Takes a few seconds longer', 'Best on tricky questions', 'Costs more per answer', 'lovable', 'openai/gpt-5.4', 2)
ON CONFLICT (key) DO NOTHING;

-- ------------------------------------------------------ tier-based choices

ALTER TABLE public.ai_task_models ADD COLUMN IF NOT EXISTS tier text REFERENCES public.ai_tiers (key) ON DELETE CASCADE;
ALTER TABLE public.ai_task_models ALTER COLUMN provider DROP NOT NULL;
ALTER TABLE public.ai_task_models ALTER COLUMN model_id DROP NOT NULL;

UPDATE public.ai_task_models m
   SET tier = t.key
  FROM public.ai_tiers t
 WHERE m.tier IS NULL AND m.provider = t.provider AND m.model_id = t.model_id;

DELETE FROM public.ai_task_models WHERE tier IS NULL;
ALTER TABLE public.ai_task_models ALTER COLUMN tier SET NOT NULL;

-- The old validator checked provider/model directly; tiers are validated
-- through the tier row instead.
CREATE OR REPLACE FUNCTION public.ai_task_models_validate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  t public.ai_tiers%ROWTYPE;
  m public.ai_models%ROWTYPE;
BEGIN
  SELECT * INTO t FROM public.ai_tiers WHERE key = NEW.tier;
  IF NOT FOUND OR t.is_active = false THEN
    RAISE EXCEPTION 'That option is not available.';
  END IF;
  NEW.provider := t.provider;
  NEW.model_id := t.model_id;

  SELECT * INTO m FROM public.ai_models WHERE provider = t.provider AND model_id = t.model_id;
  IF NOT FOUND OR m.is_available = false OR m.is_deprecated THEN
    RAISE EXCEPTION 'That option is not available.';
  END IF;
  IF NEW.task = 'agent_reply' AND m.supports_tools = false THEN
    RAISE EXCEPTION 'That option cannot look things up, so it cannot talk to customers.';
  END IF;
  RETURN NEW;
END;
$$;

-- Vendor names stay out of merchant reach here too.
REVOKE SELECT ON public.ai_task_models FROM authenticated;
GRANT SELECT (id, organization_id, agent_id, task, tier, created_at, updated_at)
  ON public.ai_task_models TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.ai_task_models TO authenticated;

-- ------------------------------------------------------------- two prices

ALTER TABLE public.ai_runs
  ADD COLUMN IF NOT EXISTS billed_amount numeric,
  ADD COLUMN IF NOT EXISTS billed_currency text,
  ADD COLUMN IF NOT EXISTS markup_multiplier numeric,
  ADD COLUMN IF NOT EXISTS tier text;

UPDATE public.ai_runs r
   SET billed_amount = ROUND(r.cost_amount * s.ai_markup_multiplier, 6),
       billed_currency = COALESCE(r.cost_currency, 'INR'),
       markup_multiplier = s.ai_markup_multiplier
  FROM public.platform_settings s
 WHERE r.billed_amount IS NULL AND r.cost_amount IS NOT NULL;

ALTER TABLE public.ai_usage ADD COLUMN IF NOT EXISTS billed_amount numeric NOT NULL DEFAULT 0;

UPDATE public.ai_usage u
   SET billed_amount = ROUND(u.cost_amount * s.ai_markup_multiplier, 6)
  FROM public.platform_settings s
 WHERE u.billed_amount = 0 AND u.cost_amount > 0;

-- What the provider charged us is platform-internal. Merchant sessions can
-- read every other column; Super Admin surfaces read through the service role.
REVOKE SELECT ON public.ai_runs FROM authenticated;
GRANT SELECT (id, organization_id, agent_id, conversation_id, contact_id, user_id,
              acting_role, task, tier, input_summary, output, confidence,
              escalation_signal, sources, tool_call_count, cost_source,
              billed_amount, billed_currency, latency_ms, status, error,
              comparison_id, created_at)
  ON public.ai_runs TO authenticated;

REVOKE SELECT ON public.ai_usage FROM authenticated;
GRANT SELECT (id, organization_id, usage_date, task, runs, input_tokens,
              output_tokens, billed_amount, currency, updated_at)
  ON public.ai_usage TO authenticated;

-- The cap is what the merchant agreed to pay, so it counts billed money.
CREATE OR REPLACE FUNCTION public.ai_month_spend(p_org uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(billed_amount), 0)
  FROM public.ai_runs
  WHERE organization_id = p_org
    AND billed_amount IS NOT NULL
    AND created_at >= date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))
        AT TIME ZONE 'Asia/Kolkata';
$$;

-- --------------------------------------------- per-organisation markup deal

ALTER TABLE public.organization_ai_settings
  ADD COLUMN IF NOT EXISTS ai_markup_multiplier numeric
    CHECK (ai_markup_multiplier IS NULL OR ai_markup_multiplier >= 1);

-- A merchant may never negotiate their own rate from the client.
CREATE OR REPLACE FUNCTION public.guard_org_markup()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF auth.role() = 'authenticated' AND NOT public.is_super_admin() THEN
    IF TG_OP = 'INSERT' THEN
      NEW.ai_markup_multiplier := NULL;
    ELSIF NEW.ai_markup_multiplier IS DISTINCT FROM OLD.ai_markup_multiplier THEN
      NEW.ai_markup_multiplier := OLD.ai_markup_multiplier;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organization_ai_settings_markup_guard ON public.organization_ai_settings;
CREATE TRIGGER organization_ai_settings_markup_guard
  BEFORE INSERT OR UPDATE ON public.organization_ai_settings
  FOR EACH ROW EXECUTE FUNCTION public.guard_org_markup();

REVOKE SELECT ON public.organization_ai_settings FROM authenticated;
GRANT SELECT (organization_id, ai_enabled, ai_monthly_cap_amount, currency,
              brain_choice, created_at, updated_at)
  ON public.organization_ai_settings TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.organization_ai_settings TO authenticated;

-- ------------------------------------------- BYOA override, admins-only UI

DROP POLICY IF EXISTS ai_providers_all ON public.ai_providers;
CREATE POLICY ai_providers_all ON public.ai_providers
  TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());
