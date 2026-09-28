-- Flows batch 1 safety. Idempotent: safe to run more than once.
--
-- (4) HTTP step header values live only in Vault, never in the graph JSON
--     (flow_versions is readable by members). Each secret is bound to the
--     address it was saved for (scheme + host + path of the step URL).
--     Service role only: no grants and no policies for anon/authenticated.
-- (7) replace_knowledge_chunks: swap a page's chunks in one transaction, so
--     a failed rebuild leaves the old chunks in place.

-- ------------------------------------------------------------ (4) secrets
CREATE TABLE IF NOT EXISTS public.flow_http_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  flow_id uuid REFERENCES public.flows(id) ON DELETE CASCADE,
  scope text NOT NULL DEFAULT '',
  secret_vault_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flow_http_secrets_org ON public.flow_http_secrets (organization_id, flow_id);

REVOKE ALL ON public.flow_http_secrets FROM anon, authenticated;
GRANT ALL ON public.flow_http_secrets TO service_role;
ALTER TABLE public.flow_http_secrets ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: nothing on the client path may read this table.

-- Store (or replace) one header value. p_id is reused only when it belongs to
-- this workspace; otherwise a new secret is created. Returns the secret id.
CREATE OR REPLACE FUNCTION public.flow_http_secret_set(p_org uuid, p_flow uuid, p_id uuid, p_scope text, p_secret text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  v_id uuid;
  v_name text;
  v_vault uuid;
BEGIN
  IF p_id IS NOT NULL THEN
    SELECT id INTO v_id FROM public.flow_http_secrets WHERE id = p_id AND organization_id = p_org;
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO public.flow_http_secrets (organization_id, flow_id, scope)
    VALUES (p_org, p_flow, coalesce(p_scope, ''))
    RETURNING id INTO v_id;
  END IF;
  v_name := 'flow_http_' || v_id::text;
  SELECT id INTO v_vault FROM vault.secrets WHERE name = v_name;
  IF v_vault IS NULL THEN
    PERFORM vault.create_secret(p_secret, v_name, 'Flow HTTP header value');
  ELSE
    PERFORM vault.update_secret(v_vault, p_secret);
  END IF;
  UPDATE public.flow_http_secrets
    SET secret_vault_name = v_name, scope = coalesce(p_scope, ''), updated_at = now()
    WHERE id = v_id;
  RETURN v_id;
END; $$;

-- Read header values for one request: this workspace only, and only the
-- secrets saved for this exact address (scope).
CREATE OR REPLACE FUNCTION public.flow_http_secrets_get(p_org uuid, p_ids uuid[], p_scope text)
RETURNS TABLE (id uuid, secret text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT f.id, s.decrypted_secret
  FROM public.flow_http_secrets f
  JOIN vault.decrypted_secrets s ON s.name = f.secret_vault_name
  WHERE f.organization_id = p_org
    AND f.id = ANY (p_ids)
    AND f.scope = coalesce(p_scope, '');
$$;

-- A deleted row (flow deleted → cascade) takes its Vault secret with it.
CREATE OR REPLACE FUNCTION public.flow_http_secret_purge()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
BEGIN
  DELETE FROM vault.secrets WHERE name = 'flow_http_' || OLD.id::text;
  RETURN OLD;
END; $$;
DROP TRIGGER IF EXISTS flow_http_secrets_purge ON public.flow_http_secrets;
CREATE TRIGGER flow_http_secrets_purge AFTER DELETE ON public.flow_http_secrets
  FOR EACH ROW EXECUTE FUNCTION public.flow_http_secret_purge();

REVOKE ALL ON FUNCTION public.flow_http_secret_set(uuid, uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.flow_http_secrets_get(uuid, uuid[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.flow_http_secret_purge() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_http_secret_set(uuid, uuid, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_http_secrets_get(uuid, uuid[], text) TO service_role;

-- ------------------------------------------------------ (7) chunk replace
-- Deletes the page's chunks and inserts the new ones in one transaction.
-- Organization and source come from the page itself, never from the caller.
CREATE OR REPLACE FUNCTION public.replace_knowledge_chunks(p_document_id uuid, p_rows jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_org uuid;
  v_source uuid;
  v_count integer;
BEGIN
  SELECT organization_id, source_id INTO v_org, v_source
  FROM public.knowledge_documents WHERE id = p_document_id;
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'knowledge document % not found', p_document_id;
  END IF;
  DELETE FROM public.knowledge_chunks WHERE document_id = p_document_id;
  INSERT INTO public.knowledge_chunks
    (organization_id, source_id, document_id, source_ref, chunk_index, text, embedding, embedding_model, dimensions)
  SELECT v_org, v_source, p_document_id,
         r->>'source_ref', (r->>'chunk_index')::integer, r->>'text',
         (r->>'embedding')::vector, r->>'embedding_model',
         coalesce((r->>'dimensions')::integer, 1536)
  FROM jsonb_array_elements(p_rows) AS r;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END; $$;

REVOKE ALL ON FUNCTION public.replace_knowledge_chunks(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_knowledge_chunks(uuid, jsonb) TO service_role;
