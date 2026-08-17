-- Shopify integration: install state, credentials, synced commerce data.
-- Sync only — no customer-facing messaging is wired from these tables yet.

-- ================================================================ integrations
CREATE TABLE IF NOT EXISTS public.integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('shopify', 'woocommerce')),
  shop_domain text NOT NULL,
  display_name text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'connected', 'disconnected', 'error')),
  scopes text[] NOT NULL DEFAULT '{}',
  installed_at timestamptz,
  last_sync_at timestamptz,
  sync_error text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- An org may connect several stores per provider; one row per store.
CREATE UNIQUE INDEX IF NOT EXISTS integrations_org_provider_shop_unique_idx
  ON public.integrations (organization_id, provider, shop_domain);
CREATE INDEX IF NOT EXISTS integrations_org_idx
  ON public.integrations (organization_id, provider, status);
-- A shop domain can only be installed on one workspace at a time.
CREATE UNIQUE INDEX IF NOT EXISTS integrations_shop_live_unique_idx
  ON public.integrations (provider, shop_domain)
  WHERE status = 'connected';

GRANT SELECT ON public.integrations TO authenticated;
GRANT ALL ON public.integrations TO service_role;
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

-- All writes go through service-role server routes (OAuth, webhooks, sync).
DROP POLICY IF EXISTS "integrations_select_members" ON public.integrations;
CREATE POLICY "integrations_select_members" ON public.integrations
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'integrations.view') OR public.is_super_admin());

DROP TRIGGER IF EXISTS update_integrations_updated_at ON public.integrations;
CREATE TRIGGER update_integrations_updated_at
  BEFORE UPDATE ON public.integrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ==================================================== integration_credentials
-- Same pattern as whatsapp_credentials: service role only, never readable by
-- an authenticated client, never returned to the browser.
CREATE TABLE IF NOT EXISTS public.integration_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id uuid NOT NULL REFERENCES public.integrations(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  access_token text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  install_state text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS integration_credentials_integration_unique_idx
  ON public.integration_credentials (integration_id);
CREATE INDEX IF NOT EXISTS integration_credentials_state_idx
  ON public.integration_credentials (install_state);

REVOKE ALL ON public.integration_credentials FROM anon, authenticated;
GRANT ALL ON public.integration_credentials TO service_role;
ALTER TABLE public.integration_credentials ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "integration_credentials_service_only" ON public.integration_credentials;
CREATE POLICY "integration_credentials_service_only" ON public.integration_credentials
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS update_integration_credentials_updated_at ON public.integration_credentials;
CREATE TRIGGER update_integration_credentials_updated_at
  BEFORE UPDATE ON public.integration_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ==================================================================== products
CREATE TABLE IF NOT EXISTS public.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES public.integrations(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  title text NOT NULL DEFAULT '',
  handle text,
  price numeric,
  currency text,
  image_url text,
  product_url text,
  status text,
  synced_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS products_integration_external_unique_idx
  ON public.products (integration_id, external_id);
CREATE INDEX IF NOT EXISTS products_org_title_idx ON public.products (organization_id, title);

GRANT SELECT ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "products_select_members" ON public.products;
CREATE POLICY "products_select_members" ON public.products
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'integrations.view') OR public.is_super_admin());

-- ====================================================================== orders
CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES public.integrations(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  order_number text,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  external_customer_id text,
  financial_status text,
  fulfillment_status text,
  is_cod boolean NOT NULL DEFAULT false,
  currency text,
  total numeric,
  placed_at timestamptz,
  cancelled_at timestamptz,
  fulfilled_at timestamptz,
  delivered_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_integration_external_unique_idx
  ON public.orders (integration_id, external_id);
CREATE INDEX IF NOT EXISTS orders_org_placed_idx ON public.orders (organization_id, placed_at DESC);
CREATE INDEX IF NOT EXISTS orders_org_contact_idx ON public.orders (organization_id, contact_id);
CREATE INDEX IF NOT EXISTS orders_org_number_idx ON public.orders (organization_id, order_number);

GRANT SELECT ON public.orders TO authenticated;
GRANT ALL ON public.orders TO service_role;
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "orders_select_members" ON public.orders;
CREATE POLICY "orders_select_members" ON public.orders
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'integrations.view') OR public.is_super_admin());

DROP TRIGGER IF EXISTS update_orders_updated_at ON public.orders;
CREATE TRIGGER update_orders_updated_at
  BEFORE UPDATE ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ================================================================= order_items
CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  external_product_id text,
  title text NOT NULL DEFAULT '',
  quantity integer NOT NULL DEFAULT 1,
  price numeric,
  image_url text
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON public.order_items (order_id);

GRANT SELECT ON public.order_items TO authenticated;
GRANT ALL ON public.order_items TO service_role;
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "order_items_select_members" ON public.order_items;
CREATE POLICY "order_items_select_members" ON public.order_items
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'integrations.view') OR public.is_super_admin());

-- ========================================================= abandoned_checkouts
CREATE TABLE IF NOT EXISTS public.abandoned_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES public.integrations(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  checkout_url text,
  total numeric,
  currency text,
  abandoned_at timestamptz,
  recovered_at timestamptz,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS abandoned_checkouts_integration_external_unique_idx
  ON public.abandoned_checkouts (integration_id, external_id);
CREATE INDEX IF NOT EXISTS abandoned_checkouts_org_time_idx
  ON public.abandoned_checkouts (organization_id, abandoned_at DESC);
CREATE INDEX IF NOT EXISTS abandoned_checkouts_org_contact_idx
  ON public.abandoned_checkouts (organization_id, contact_id);

GRANT SELECT ON public.abandoned_checkouts TO authenticated;
GRANT ALL ON public.abandoned_checkouts TO service_role;
ALTER TABLE public.abandoned_checkouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "abandoned_checkouts_select_members" ON public.abandoned_checkouts;
CREATE POLICY "abandoned_checkouts_select_members" ON public.abandoned_checkouts
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'integrations.view') OR public.is_super_admin());

DROP TRIGGER IF EXISTS update_abandoned_checkouts_updated_at ON public.abandoned_checkouts;
CREATE TRIGGER update_abandoned_checkouts_updated_at
  BEFORE UPDATE ON public.abandoned_checkouts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ====================================================== backfill progress jobs
CREATE TABLE IF NOT EXISTS public.integration_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL REFERENCES public.integrations(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'backfill',
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  phase text NOT NULL DEFAULT 'starting',
  products_synced integer NOT NULL DEFAULT 0,
  orders_synced integer NOT NULL DEFAULT 0,
  contacts_matched integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS integration_sync_jobs_lookup_idx
  ON public.integration_sync_jobs (integration_id, started_at DESC);

GRANT SELECT ON public.integration_sync_jobs TO authenticated;
GRANT ALL ON public.integration_sync_jobs TO service_role;
ALTER TABLE public.integration_sync_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "integration_sync_jobs_select_members" ON public.integration_sync_jobs;
CREATE POLICY "integration_sync_jobs_select_members" ON public.integration_sync_jobs
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'integrations.view') OR public.is_super_admin());

DROP TRIGGER IF EXISTS update_integration_sync_jobs_updated_at ON public.integration_sync_jobs;
CREATE TRIGGER update_integration_sync_jobs_updated_at
  BEFORE UPDATE ON public.integration_sync_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================== webhook idempotency (Shopify)
-- Shopify retries aggressively; X-Shopify-Webhook-Id is the dedupe key.
ALTER TABLE public.webhook_events
  ADD COLUMN IF NOT EXISTS external_event_id text;
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_provider_external_unique_idx
  ON public.webhook_events (provider, external_event_id)
  WHERE external_event_id IS NOT NULL;
