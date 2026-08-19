-- Catalogue: extend the Shopify-synced products table into a full product
-- catalogue that also holds manually added and uploaded products.
--
-- products already exists and is written by the Shopify sync. It is extended
-- here, never recreated. integration_id / external_id become nullable so a
-- product can exist without a store behind it; the sync path is untouched.

-- ---------------------------------------------------------------- products

ALTER TABLE public.products ALTER COLUMN integration_id DROP NOT NULL;
ALTER TABLE public.products ALTER COLUMN external_id DROP NOT NULL;

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS sku text,
  ADD COLUMN IF NOT EXISTS brand text,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS availability text NOT NULL DEFAULT 'in_stock',
  ADD COLUMN IF NOT EXISTS inventory_quantity integer,
  ADD COLUMN IF NOT EXISTS compare_at_price numeric,
  ADD COLUMN IF NOT EXISTS additional_image_urls text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'shopify',
  ADD COLUMN IF NOT EXISTS is_visible boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_availability_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_availability_check
  CHECK (availability IN ('in_stock', 'out_of_stock', 'preorder'));

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_source_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_source_check
  CHECK (source IN ('shopify', 'manual', 'import'));

-- Existing rows all came from a store.
UPDATE public.products
   SET source = CASE WHEN integration_id IS NOT NULL THEN 'shopify' ELSE 'manual' END
 WHERE source IS DISTINCT FROM CASE WHEN integration_id IS NOT NULL THEN 'shopify' ELSE 'manual' END;

-- Full-text search across the fields a merchant would actually type.
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector(
      'simple',
      coalesce(title, '') || ' ' ||
      coalesce(description, '') || ' ' ||
      coalesce(sku, '') || ' ' ||
      coalesce(brand, '') || ' ' ||
      coalesce(category, '')
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS products_search_vector_idx
  ON public.products USING gin (search_vector);

-- NOTE: both indexes below are PARTIAL. Any ON CONFLICT targeting them must
-- repeat the same WHERE predicate, otherwise Postgres raises
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
CREATE UNIQUE INDEX IF NOT EXISTS products_org_external_unique_idx
  ON public.products (organization_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS products_org_sku_unique_idx
  ON public.products (organization_id, lower(sku))
  WHERE sku IS NOT NULL AND sku <> '';

CREATE INDEX IF NOT EXISTS products_org_source_idx ON public.products (organization_id, source);

DROP TRIGGER IF EXISTS products_set_updated_at ON public.products;
CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Catalogue write access. The existing select policy (integrations.view) stays
-- so the Shopify surfaces keep working; catalogue readers get their own.
DROP POLICY IF EXISTS products_select_catalog ON public.products;
CREATE POLICY products_select_catalog ON public.products
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'catalog.view') OR public.is_super_admin());

DROP POLICY IF EXISTS products_insert_catalog ON public.products;
CREATE POLICY products_insert_catalog ON public.products
  FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(organization_id, 'catalog.manage'));

DROP POLICY IF EXISTS products_update_catalog ON public.products;
CREATE POLICY products_update_catalog ON public.products
  FOR UPDATE TO authenticated
  USING (public.has_permission(organization_id, 'catalog.manage'))
  WITH CHECK (public.has_permission(organization_id, 'catalog.manage'));

DROP POLICY IF EXISTS products_delete_catalog ON public.products;
CREATE POLICY products_delete_catalog ON public.products
  FOR DELETE TO authenticated
  USING (public.has_permission(organization_id, 'catalog.manage'));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.products TO authenticated;
GRANT ALL ON public.products TO service_role;

-- ------------------------------------------------------------- collections

CREATE TABLE IF NOT EXISTS public.product_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  image_url text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS product_collections_org_slug_unique_idx
  ON public.product_collections (organization_id, slug);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_collections TO authenticated;
GRANT ALL ON public.product_collections TO service_role;
ALTER TABLE public.product_collections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_collections_select ON public.product_collections;
CREATE POLICY product_collections_select ON public.product_collections
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'catalog.view') OR public.is_super_admin());

DROP POLICY IF EXISTS product_collections_write ON public.product_collections;
CREATE POLICY product_collections_write ON public.product_collections
  FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'catalog.manage'))
  WITH CHECK (public.has_permission(organization_id, 'catalog.manage'));

DROP TRIGGER IF EXISTS product_collections_set_updated_at ON public.product_collections;
CREATE TRIGGER product_collections_set_updated_at
  BEFORE UPDATE ON public.product_collections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE IF NOT EXISTS public.product_collection_items (
  collection_id uuid NOT NULL REFERENCES public.product_collections(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, product_id)
);

CREATE INDEX IF NOT EXISTS product_collection_items_product_idx
  ON public.product_collection_items (product_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_collection_items TO authenticated;
GRANT ALL ON public.product_collection_items TO service_role;
ALTER TABLE public.product_collection_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_collection_items_select ON public.product_collection_items;
CREATE POLICY product_collection_items_select ON public.product_collection_items
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'catalog.view') OR public.is_super_admin());

DROP POLICY IF EXISTS product_collection_items_write ON public.product_collection_items;
CREATE POLICY product_collection_items_write ON public.product_collection_items
  FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'catalog.manage'))
  WITH CHECK (public.has_permission(organization_id, 'catalog.manage'));

-- ---------------------------------------------------------- catalog imports

CREATE TABLE IF NOT EXISTS public.catalog_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  filename text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  total_rows integer NOT NULL DEFAULT 0,
  rows_created integer NOT NULL DEFAULT 0,
  rows_updated integer NOT NULL DEFAULT 0,
  rows_failed integer NOT NULL DEFAULT 0,
  error_report jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS catalog_imports_org_created_idx
  ON public.catalog_imports (organization_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.catalog_imports TO authenticated;
GRANT ALL ON public.catalog_imports TO service_role;
ALTER TABLE public.catalog_imports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS catalog_imports_select ON public.catalog_imports;
CREATE POLICY catalog_imports_select ON public.catalog_imports
  FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'catalog.view') OR public.is_super_admin());

DROP POLICY IF EXISTS catalog_imports_write ON public.catalog_imports;
CREATE POLICY catalog_imports_write ON public.catalog_imports
  FOR ALL TO authenticated
  USING (public.has_permission(organization_id, 'catalog.import'))
  WITH CHECK (public.has_permission(organization_id, 'catalog.import'));

-- ---------------------------------------------------------------- storage

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'product-images',
  'product-images',
  true,
  5242880, -- 5 MB
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Reads are public: these are product pictures that end up inside WhatsApp
-- messages, which Meta fetches with no credentials. Paths are org-scoped.
DROP POLICY IF EXISTS "product images public read" ON storage.objects;
CREATE POLICY "product images public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'product-images');

-- Writes only happen through the upload route on the service role, which has
-- already checked catalog.manage for the acting organization.
DROP POLICY IF EXISTS "product images service write" ON storage.objects;
CREATE POLICY "product images service write"
  ON storage.objects FOR ALL
  TO service_role
  USING (bucket_id = 'product-images')
  WITH CHECK (bucket_id = 'product-images');
