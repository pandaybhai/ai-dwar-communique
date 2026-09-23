-- WhatsApp catalogue: one Meta product catalogue per business account (WABA),
-- created and filled by AiDwar. Tokens stay service-role only; this table holds
-- no credentials, so members may read their own workspace's row.

CREATE TABLE IF NOT EXISTS public.whatsapp_catalogs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  waba_id text NOT NULL,
  catalog_id text NOT NULL,
  catalog_name text,
  status text NOT NULL DEFAULT 'linked',
  last_sync_at timestamptz,
  pushed_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, waba_id)
);

GRANT SELECT ON public.whatsapp_catalogs TO authenticated;
GRANT ALL ON public.whatsapp_catalogs TO service_role;

ALTER TABLE public.whatsapp_catalogs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "whatsapp_catalogs_select_members" ON public.whatsapp_catalogs;
CREATE POLICY "whatsapp_catalogs_select_members"
  ON public.whatsapp_catalogs
  FOR SELECT
  TO authenticated
  USING (is_org_member(organization_id));

DROP POLICY IF EXISTS "whatsapp_catalogs_select_super_admin" ON public.whatsapp_catalogs;
CREATE POLICY "whatsapp_catalogs_select_super_admin"
  ON public.whatsapp_catalogs
  FOR SELECT
  TO authenticated
  USING (is_super_admin());

DROP TRIGGER IF EXISTS whatsapp_catalogs_updated_at ON public.whatsapp_catalogs;
CREATE TRIGGER whatsapp_catalogs_updated_at
  BEFORE UPDATE ON public.whatsapp_catalogs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

INSERT INTO public.feature_flags (key, name, description, default_enabled)
VALUES (
  'whatsapp_catalog',
  'WhatsApp catalogue',
  'Create a Meta product catalogue for a connected number and push products that have a price and a picture.',
  false
)
ON CONFLICT (key) DO NOTHING;
