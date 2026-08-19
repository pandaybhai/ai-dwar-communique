-- AiDwar — the AI employee's job description, what it has been taught,
-- the languages it works in, and one place the platform rules live.

-- ============================================================ Part 1: skills
CREATE TABLE IF NOT EXISTS public.ai_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  use_when text NOT NULL DEFAULT '',
  do_not_use_when text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  is_custom boolean NOT NULL DEFAULT false,
  requires jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order int NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_skills TO authenticated;
GRANT ALL ON public.ai_skills TO service_role;
ALTER TABLE public.ai_skills ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_skills_select ON public.ai_skills;
CREATE POLICY ai_skills_select ON public.ai_skills FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());

DROP POLICY IF EXISTS ai_skills_write ON public.ai_skills;
CREATE POLICY ai_skills_write ON public.ai_skills FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'ai.configure'))
  WITH CHECK (public.has_permission(organization_id, 'ai.configure'));

DROP TRIGGER IF EXISTS ai_skills_touch ON public.ai_skills;
CREATE TRIGGER ai_skills_touch BEFORE UPDATE ON public.ai_skills
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Stopping messages is a legal obligation, not a feature to switch off.
CREATE OR REPLACE FUNCTION public.ai_skills_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.key = 'opt_out' THEN
      RAISE EXCEPTION 'Stop-messaging requests must always be handled.';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.key = 'opt_out' THEN
    NEW.enabled := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_skills_guard_trg ON public.ai_skills;
CREATE TRIGGER ai_skills_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON public.ai_skills
  FOR EACH ROW EXECUTE FUNCTION public.ai_skills_guard();

CREATE OR REPLACE FUNCTION public.seed_org_ai_skills(p_org uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  INSERT INTO public.ai_skills (organization_id, key, name, use_when, do_not_use_when, requires, sort_order)
  VALUES
    (p_org, 'faq_support', 'Questions about the business',
     'The customer asks about opening hours, delivery, payment, sizing or anything else written down about the business.',
     'Do not guess. If nothing written covers it, hand it to a person.',
     '{"knowledge": ["any"]}'::jsonb, 10),
    (p_org, 'product_discovery', 'Finding and recommending products',
     'The customer is looking for something to buy, asks what is available, or asks about a price.',
     'Do not invent a product, a price or stock that a lookup did not return.',
     '{"tools": ["catalog_search"], "data": ["products"]}'::jsonb, 20),
    (p_org, 'order_status', 'Where is my order',
     'The customer asks about an order they have already placed, delivery timing or tracking.',
     'Do not state a delivery date the lookup did not give you.',
     '{"tools": ["lookup_order"]}'::jsonb, 30),
    (p_org, 'returns_refunds', 'Returns and refunds',
     'The customer wants to return something, asks about refunds, or asks about the returns window.',
     'Do not approve a refund or promise money back — say what the policy is and pass it on.',
     '{"knowledge": ["returns_policy"]}'::jsonb, 40),
    (p_org, 'lead_qualification', 'Capturing interest from new buyers',
     'Someone new asks what the business sells or shows interest — find out what they need and note it.',
     'Do not push a sale or ask more than two questions in a row.',
     '{}'::jsonb, 50),
    (p_org, 'human_handoff', 'Handing over to a person',
     'The customer asks for a human, is upset, or the question is outside everything else here.',
     'Do not promise a specific person or a callback time.',
     '{}'::jsonb, 60),
    (p_org, 'opt_out', 'Stop-messaging requests',
     'The customer asks to stop receiving messages, in any wording or language.',
     'Never argue, never ask them to reconsider. Confirm it and stop.',
     '{}'::jsonb, 70)
  ON CONFLICT (organization_id, key) DO NOTHING;
$$;

REVOKE ALL ON FUNCTION public.seed_org_ai_skills(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.seed_org_ai_skills(uuid) TO service_role, authenticated;

-- Backfill every workspace that already exists.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM public.organizations LOOP
    PERFORM public.seed_org_ai_skills(r.id);
  END LOOP;
END $$;

-- New workspaces get the same job description.
CREATE OR REPLACE FUNCTION public.seed_org_ai_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
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

  PERFORM public.seed_org_ai_skills(NEW.id);

  RETURN NEW;
END;
$$;

-- ========================================================== Part 2: teaching
ALTER TABLE public.knowledge_documents
  ADD COLUMN IF NOT EXISTS use_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

-- Counting an answer's use runs from server code without a session.
CREATE OR REPLACE FUNCTION public.record_knowledge_use(p_org uuid, p_document_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE public.knowledge_documents
     SET use_count = use_count + 1, last_used_at = now()
   WHERE organization_id = p_org
     AND id = ANY(p_document_ids);
$$;

REVOKE ALL ON FUNCTION public.record_knowledge_use(uuid, uuid[]) FROM public;
GRANT EXECUTE ON FUNCTION public.record_knowledge_use(uuid, uuid[]) TO service_role, authenticated;

-- ========================================================= Part 3: languages
ALTER TABLE public.ai_instructions
  ALTER COLUMN languages SET DEFAULT ARRAY['en','hi']::text[];

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS detected_language text;

-- ==================================================== Part 4: platform rules
CREATE TABLE IF NOT EXISTS public.ai_prompt_blocks (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  default_content text NOT NULL DEFAULT '',
  version int NOT NULL DEFAULT 1,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.ai_prompt_blocks TO authenticated;
GRANT ALL ON public.ai_prompt_blocks TO service_role;
ALTER TABLE public.ai_prompt_blocks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_prompt_blocks_select ON public.ai_prompt_blocks;
CREATE POLICY ai_prompt_blocks_select ON public.ai_prompt_blocks FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS ai_prompt_blocks_write ON public.ai_prompt_blocks;
CREATE POLICY ai_prompt_blocks_write ON public.ai_prompt_blocks FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP TRIGGER IF EXISTS ai_prompt_blocks_touch ON public.ai_prompt_blocks;
CREATE TRIGGER ai_prompt_blocks_touch BEFORE UPDATE ON public.ai_prompt_blocks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS ai_prompt_blocks_audit ON public.ai_prompt_blocks;
CREATE TRIGGER ai_prompt_blocks_audit AFTER INSERT OR UPDATE OR DELETE ON public.ai_prompt_blocks
  FOR EACH ROW EXECUTE FUNCTION public.log_super_admin_write();

INSERT INTO public.ai_prompt_blocks (key, name, description, content, default_content, version)
VALUES (
  'agent_rules',
  'Platform rules',
  'The rules every AI answer on AiDwar follows, before anything a merchant writes.',
  E'Keep replies short — under 60 words for a normal answer. When listing products, one short line per product is fine.\nOnly state something you found in the material provided or by looking it up.\nNever invent an order number, a price, a date or a policy.\nWhen a product lookup returns results, show them: name and price, up to five items. Never answer a product question by asking the customer to narrow down first.\nIf more products matched than you listed, say so, for example "and 9 more — tell me what you''re after and I''ll narrow it down".\nOnly ask a clarifying question when a lookup genuinely returned nothing.\nProduct pictures are attached for you automatically — name each product plainly and never paste an image link.\nIf you cannot answer from a source or a lookup, say a colleague will follow up.',
  E'Keep replies short — under 60 words for a normal answer. When listing products, one short line per product is fine.\nOnly state something you found in the material provided or by looking it up.\nNever invent an order number, a price, a date or a policy.\nWhen a product lookup returns results, show them: name and price, up to five items. Never answer a product question by asking the customer to narrow down first.\nIf more products matched than you listed, say so, for example "and 9 more — tell me what you''re after and I''ll narrow it down".\nOnly ask a clarifying question when a lookup genuinely returned nothing.\nProduct pictures are attached for you automatically — name each product plainly and never paste an image link.\nIf you cannot answer from a source or a lookup, say a colleague will follow up.',
  1
)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE public.ai_runs
  ADD COLUMN IF NOT EXISTS prompt_rules_version int;
