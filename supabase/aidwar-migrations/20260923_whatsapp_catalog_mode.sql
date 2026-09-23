-- Merchants may already own a Meta catalogue (often kept fresh by Shopify).
-- We record which of the two shapes a workspace is in:
--   'managed' — AiDwar created it and pushes products into it
--   'linked'  — the merchant's own catalogue; we only read from it, never write

ALTER TABLE public.whatsapp_catalogs
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'managed';

ALTER TABLE public.whatsapp_catalogs DROP CONSTRAINT IF EXISTS whatsapp_catalogs_mode_check;
ALTER TABLE public.whatsapp_catalogs
  ADD CONSTRAINT whatsapp_catalogs_mode_check CHECK (mode IN ('managed', 'linked'));

-- Products read back out of a merchant-owned Meta catalogue.
ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_source_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_source_check
  CHECK (source IN ('shopify', 'manual', 'import', 'crawl', 'meta_catalog'));
