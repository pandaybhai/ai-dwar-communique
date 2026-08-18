-- The AI employee, part 2: what they know.
--
-- Live facts — orders, stock, price, availability — are never stored here.
-- They are looked up at question time through the tool broker, because an
-- embedded order tells a customer their delivered parcel is still in transit.
-- This is business content only: pages, documents, rows, answers.

CREATE EXTENSION IF NOT EXISTS vector;

-- ------------------------------------------------------------- 1. sources
CREATE TABLE IF NOT EXISTS public.knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Null means every agent may use it.
  agent_id uuid REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN
    ('website','pdf','spreadsheet','manual_qa','meta_catalog','woocommerce','shopify')),
  name text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','syncing','ready','error','disabled')),
  last_synced_at timestamptz,
  item_count integer NOT NULL DEFAULT 0,
  last_error text,
  -- Days between automatic refreshes. 0 = never refresh automatically.
  refresh_days integer NOT NULL DEFAULT 7 CHECK (refresh_days >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS knowledge_sources_org_idx
  ON public.knowledge_sources (organization_id, created_at DESC);

-- ----------------------------------------------------------- 2. documents
-- One normalised item whatever its origin: a web page, a PDF section, a
-- spreadsheet row, a product, a written answer.
CREATE TABLE IF NOT EXISTS public.knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.knowledge_sources(id) ON DELETE CASCADE,
  -- Stable identifier within the source: a URL, a row number, a page number.
  source_ref text NOT NULL,
  title text NOT NULL DEFAULT '',
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_ref)
);
CREATE INDEX IF NOT EXISTS knowledge_documents_org_idx
  ON public.knowledge_documents (organization_id, source_id);

-- -------------------------------------------------------------- 3. chunks
CREATE TABLE IF NOT EXISTS public.knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES public.knowledge_sources(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.knowledge_documents(id) ON DELETE CASCADE,
  source_ref text NOT NULL,
  chunk_index integer NOT NULL DEFAULT 0,
  text text NOT NULL,
  embedding vector(1536),
  -- Retrieval filters on these two, so a change of reading model can run
  -- alongside the old one instead of forcing one big re-read.
  embedding_model text NOT NULL,
  dimensions integer NOT NULL DEFAULT 1536,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index, embedding_model)
);
CREATE INDEX IF NOT EXISTS knowledge_chunks_org_model_idx
  ON public.knowledge_chunks (organization_id, embedding_model);
CREATE INDEX IF NOT EXISTS knowledge_chunks_vector_idx
  ON public.knowledge_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ------------------------------------------------------- 4. how to behave
CREATE TABLE IF NOT EXISTS public.ai_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  persona_name text NOT NULL DEFAULT '',
  tone text NOT NULL DEFAULT 'friendly',
  instructions text NOT NULL DEFAULT '',
  escalation_rules text NOT NULL DEFAULT '',
  languages text[] NOT NULL DEFAULT ARRAY['en'],
  working_hours_behaviour text NOT NULL DEFAULT 'always'
    CHECK (working_hours_behaviour IN ('always','working_hours_only','after_hours_only')),
  version integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Every change is a new version, so a merchant can go back to what worked.
CREATE UNIQUE INDEX IF NOT EXISTS ai_instructions_current_idx
  ON public.ai_instructions (agent_id) WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS ai_instructions_version_idx
  ON public.ai_instructions (agent_id, version);

-- --------------------------------------------------------- 5. comparisons
CREATE TABLE IF NOT EXISTS public.ai_comparisons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  config_a jsonb NOT NULL,
  config_b jsonb NOT NULL,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  winner text CHECK (winner IS NULL OR winner IN ('a','b')),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','done','error')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS ai_comparisons_org_idx
  ON public.ai_comparisons (organization_id, created_at DESC);

-- ------------------------------------------------------ grants and policies
GRANT SELECT, INSERT, UPDATE, DELETE ON public.knowledge_sources TO authenticated;
GRANT SELECT, DELETE ON public.knowledge_documents TO authenticated;
GRANT SELECT ON public.knowledge_chunks TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_instructions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ai_comparisons TO authenticated;
GRANT ALL ON public.knowledge_sources, public.knowledge_documents, public.knowledge_chunks,
  public.ai_instructions, public.ai_comparisons TO service_role;

ALTER TABLE public.knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_comparisons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "knowledge_sources_select" ON public.knowledge_sources;
CREATE POLICY "knowledge_sources_select" ON public.knowledge_sources FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());
DROP POLICY IF EXISTS "knowledge_sources_write" ON public.knowledge_sources;
CREATE POLICY "knowledge_sources_write" ON public.knowledge_sources FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'ai.configure'))
  WITH CHECK (public.has_permission(organization_id, 'ai.configure'));

DROP POLICY IF EXISTS "knowledge_documents_select" ON public.knowledge_documents;
CREATE POLICY "knowledge_documents_select" ON public.knowledge_documents FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());
DROP POLICY IF EXISTS "knowledge_documents_delete" ON public.knowledge_documents;
CREATE POLICY "knowledge_documents_delete" ON public.knowledge_documents FOR DELETE TO authenticated
  USING (public.has_permission(organization_id, 'ai.configure'));

DROP POLICY IF EXISTS "knowledge_chunks_select" ON public.knowledge_chunks;
CREATE POLICY "knowledge_chunks_select" ON public.knowledge_chunks FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());

DROP POLICY IF EXISTS "ai_instructions_select" ON public.ai_instructions;
CREATE POLICY "ai_instructions_select" ON public.ai_instructions FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());
DROP POLICY IF EXISTS "ai_instructions_write" ON public.ai_instructions;
CREATE POLICY "ai_instructions_write" ON public.ai_instructions FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'ai.configure'))
  WITH CHECK (public.has_permission(organization_id, 'ai.configure'));

DROP POLICY IF EXISTS "ai_comparisons_select" ON public.ai_comparisons;
CREATE POLICY "ai_comparisons_select" ON public.ai_comparisons FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'ai.use') OR public.is_super_admin());
DROP POLICY IF EXISTS "ai_comparisons_write" ON public.ai_comparisons;
CREATE POLICY "ai_comparisons_write" ON public.ai_comparisons FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'ai.use'))
  WITH CHECK (public.has_permission(organization_id, 'ai.use'));

DROP TRIGGER IF EXISTS knowledge_sources_updated_at ON public.knowledge_sources;
CREATE TRIGGER knowledge_sources_updated_at BEFORE UPDATE ON public.knowledge_sources
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS knowledge_documents_updated_at ON public.knowledge_documents;
CREATE TRIGGER knowledge_documents_updated_at BEFORE UPDATE ON public.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ------------------------------------------------------------- retrieval
-- Filtered to the active reading model, so two models can coexist.
CREATE OR REPLACE FUNCTION public.match_knowledge_chunks(
  p_org uuid,
  p_embedding vector(1536),
  p_embedding_model text,
  p_agent uuid DEFAULT NULL,
  p_limit integer DEFAULT 6,
  p_min_similarity numeric DEFAULT 0.35
)
RETURNS TABLE (
  chunk_id uuid,
  document_id uuid,
  source_id uuid,
  source_type text,
  source_name text,
  source_ref text,
  title text,
  text text,
  similarity numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.id, c.document_id, c.source_id, s.type, s.name, c.source_ref,
         d.title, c.text,
         (1 - (c.embedding <=> p_embedding))::numeric AS similarity
  FROM public.knowledge_chunks c
  JOIN public.knowledge_sources s ON s.id = c.source_id
  JOIN public.knowledge_documents d ON d.id = c.document_id
  WHERE c.organization_id = p_org
    AND c.embedding IS NOT NULL
    AND c.embedding_model = p_embedding_model
    AND s.status <> 'disabled'
    AND (s.agent_id IS NULL OR p_agent IS NULL OR s.agent_id = p_agent)
    AND (1 - (c.embedding <=> p_embedding)) >= p_min_similarity
  ORDER BY c.embedding <=> p_embedding
  LIMIT GREATEST(p_limit, 1);
$$;

GRANT EXECUTE ON FUNCTION public.match_knowledge_chunks(uuid, vector, text, uuid, integer, numeric)
  TO service_role;

-- Seed the current instruction row for every existing agent.
INSERT INTO public.ai_instructions (organization_id, agent_id, persona_name, tone, instructions)
SELECT a.organization_id, a.id, a.name, 'friendly',
       'Be brief, warm and accurate. Only say what you can support with a source or a lookup.'
FROM public.ai_agents a
WHERE NOT EXISTS (SELECT 1 FROM public.ai_instructions i WHERE i.agent_id = a.id);
