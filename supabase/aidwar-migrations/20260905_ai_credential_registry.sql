-- Provider credentials must be answerable by query, not by reading code.
--
-- Cause of the outage this fixes: the run engine read the key with
-- `supabase.schema("vault").from("decrypted_secrets")`, but PostgREST only
-- exposes `public` and `graphql_public`. Every read returned nothing, so a
-- correctly stored key looked like "No AI connection is set up."
-- Vault is now read through a SECURITY DEFINER function in `public`.

CREATE OR REPLACE FUNCTION public.read_vault_secret(p_name text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = p_name LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.read_vault_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.read_vault_secret(text) TO service_role;

-- An explicit, queryable record of which providers actually hold a key.
ALTER TABLE public.platform_ai_providers
  ADD COLUMN IF NOT EXISTS key_set_at timestamptz;

UPDATE public.platform_ai_providers p
SET key_set_at = s.created_at
FROM vault.secrets s
WHERE s.name = p.vault_secret_name AND p.key_set_at IS NULL;

-- Storing a key now verifies the secret is readable before claiming success,
-- and stamps when it was set.
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

  IF public.read_vault_secret(v_name) IS NULL THEN
    RAISE EXCEPTION 'The key was not stored readably for provider %', p_provider;
  END IF;

  INSERT INTO public.platform_ai_providers (provider, vault_secret_name, is_active, last_error, key_set_at, updated_at)
  VALUES (p_provider, v_name, true, NULL, now(), now())
  ON CONFLICT (provider) DO UPDATE
    SET vault_secret_name = EXCLUDED.vault_secret_name,
        is_active = true,
        last_error = NULL,
        key_set_at = now(),
        updated_at = now();

  RETURN v_name;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_set_ai_key(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_ai_key(text, text) TO service_role;

-- "Is a key set up?" answered by one query, without exposing any secret.
CREATE OR REPLACE FUNCTION public.platform_ai_credential_status()
RETURNS TABLE (
  provider text,
  is_active boolean,
  vault_secret_name text,
  key_present boolean,
  key_set_at timestamptz,
  last_error text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, vault
AS $$
  SELECT
    p.provider,
    p.is_active,
    p.vault_secret_name,
    p.vault_secret_name IS NOT NULL
      AND EXISTS (SELECT 1 FROM vault.secrets s WHERE s.name = p.vault_secret_name),
    p.key_set_at,
    p.last_error
  FROM public.platform_ai_providers p
  ORDER BY p.provider;
$$;

REVOKE ALL ON FUNCTION public.platform_ai_credential_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_ai_credential_status() TO service_role;
