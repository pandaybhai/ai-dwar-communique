-- One custom-distribution Shopify app per merchant store.
-- The client secret lives only in Vault; this table holds its Vault name.
-- No grants to anon/authenticated: only the service role can touch it.

CREATE TABLE IF NOT EXISTS public.shopify_app_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  shop_domain text NOT NULL UNIQUE,
  client_id text NOT NULL,
  client_secret_vault_name text,
  label text,
  install_link text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disconnected')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shopify_app_credentials_org_idx
  ON public.shopify_app_credentials (organization_id);

REVOKE ALL ON public.shopify_app_credentials FROM anon, authenticated;
GRANT ALL ON public.shopify_app_credentials TO service_role;
ALTER TABLE public.shopify_app_credentials ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: nothing on the client path may read this table.

CREATE OR REPLACE FUNCTION public.shopify_app_set_secret(p_id uuid, p_secret text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  v_name text := 'shopify_app_' || p_id::text;
  v_id uuid;
BEGIN
  SELECT id INTO v_id FROM vault.secrets WHERE name = v_name;
  IF v_id IS NULL THEN
    PERFORM vault.create_secret(p_secret, v_name, 'Shopify custom app client secret');
  ELSE
    PERFORM vault.update_secret(v_id, p_secret);
  END IF;
  UPDATE public.shopify_app_credentials
    SET client_secret_vault_name = v_name, updated_at = now()
    WHERE id = p_id;
  RETURN v_name;
END;
$$;

CREATE OR REPLACE FUNCTION public.shopify_app_for_shop(p_shop text)
RETURNS TABLE (id uuid, organization_id uuid, client_id text, client_secret text, status text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT c.id, c.organization_id, c.client_id, s.decrypted_secret, c.status
  FROM public.shopify_app_credentials c
  LEFT JOIN vault.decrypted_secrets s ON s.name = c.client_secret_vault_name
  WHERE c.shop_domain = lower(p_shop)
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.shopify_app_delete(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
BEGIN
  DELETE FROM vault.secrets WHERE name = 'shopify_app_' || p_id::text;
  DELETE FROM public.shopify_app_credentials WHERE id = p_id;
END;
$$;

REVOKE ALL ON FUNCTION public.shopify_app_set_secret(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shopify_app_for_shop(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.shopify_app_delete(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shopify_app_set_secret(uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shopify_app_for_shop(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.shopify_app_delete(uuid) TO service_role;
