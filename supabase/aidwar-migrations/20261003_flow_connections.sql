-- Per-workspace accounts used by Flows v2 steps: the merchant's own Google
-- account (Sheets) and the merchant's own Razorpay keys (payment links).
-- Secrets live only in Vault; the table holds labels and status.
-- No grants to anon/authenticated: only the service role can touch it.

CREATE TABLE IF NOT EXISTS public.workspace_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'razorpay')),
  account_label text,
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_vault_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected', 'error')),
  last_error text,
  connected_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, provider)
);

REVOKE ALL ON public.workspace_connections FROM anon, authenticated;
GRANT ALL ON public.workspace_connections TO service_role;
ALTER TABLE public.workspace_connections ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: nothing on the client path may read this table.

CREATE OR REPLACE FUNCTION public.workspace_connection_set_secret(p_id uuid, p_secret text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
DECLARE
  v_name text := 'workspace_conn_' || p_id::text;
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = v_name;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(p_secret, v_name, 'Workspace connection secret');
  ELSE
    PERFORM vault.update_secret(v_id, p_secret);
  END IF;
  UPDATE public.workspace_connections SET secret_vault_name = v_name, updated_at = now() WHERE id = p_id;
END; $$;

CREATE OR REPLACE FUNCTION public.workspace_connection_secret(p_org uuid, p_provider text)
RETURNS TABLE (id uuid, status text, public_config jsonb, secret text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT c.id, c.status, c.public_config, s.decrypted_secret
  FROM public.workspace_connections c
  LEFT JOIN vault.decrypted_secrets s ON s.name = c.secret_vault_name
  WHERE c.organization_id = p_org AND c.provider = p_provider
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.workspace_connection_delete(p_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, vault AS $$
BEGIN
  DELETE FROM vault.secrets WHERE name = 'workspace_conn_' || p_id::text;
  DELETE FROM public.workspace_connections WHERE id = p_id;
END; $$;

REVOKE ALL ON FUNCTION public.workspace_connection_set_secret(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workspace_connection_secret(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.workspace_connection_delete(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_connection_set_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.workspace_connection_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.workspace_connection_delete(uuid) TO service_role;

-- Runs can now also wait for a payment.
ALTER TABLE public.flow_runs DROP CONSTRAINT IF EXISTS flow_runs_waiting_for_check;
ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_waiting_for_check
  CHECK (waiting_for IN ('reply', 'timer', 'payment'));
