-- Creating a workspace failed with "That option is not available."
--
-- The new-org seed still wrote the old provider/model columns directly. Since
-- the resale change, ai_task_models is tier-driven: the validate trigger looks
-- the tier up in ai_tiers and fills provider/model_id itself. An empty tier
-- never matched, so every insert raised — and the whole create_organization
-- transaction rolled back.
--
-- Seed tiers instead, and skip 'embedding' (not a tier-driven task).

CREATE OR REPLACE FUNCTION public.seed_org_ai_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.ai_agents (organization_id, name, mode, is_default)
  VALUES (NEW.id, 'Aiden', 'off', true)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.organization_ai_settings (organization_id)
  VALUES (NEW.id)
  ON CONFLICT (organization_id) DO NOTHING;

  INSERT INTO public.ai_task_models (organization_id, task, tier)
  SELECT NEW.id, t.task, t.tier
  FROM (VALUES
    ('auto_tag', 'everyday'),
    ('summarise', 'everyday'),
    ('suggest_reply', 'everyday'),
    ('agent_reply', 'careful')
  ) AS t(task, tier)
  WHERE EXISTS (
    SELECT 1 FROM public.ai_tiers x WHERE x.key = t.tier AND x.is_active
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$function$;

-- The table could be written but not read by merchants (missing SELECT grant),
-- and anon held grants no policy ever allows.
GRANT SELECT ON public.ai_task_models TO authenticated;
REVOKE ALL ON public.ai_task_models FROM anon;
