-- Batch 16 item 7 (NOT applied): the free daily price check.
--
-- Nightly (knowledge-backfill), our own fetch of each crawled product page
-- (no AI, no paid reader) updates price / stock / photo from the page's
-- structured data. A price that moves by more than 50% is NOT applied: it
-- waits on products.price_review for the merchant (Knowledge → "Prices to
-- check") and is logged for admin (activity "price_jump_flagged").
-- Live: The Architect ZLRG-0005 ₹26,446 → the site now says ₹1,75,932.
--
-- platform_settings.price_check_daily turns it on/off (on once applied —
-- Vinay approved it in Batch 16; set false to pause). Idempotent.

ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS price_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS price_review jsonb;

CREATE INDEX IF NOT EXISTS products_price_check_idx
  ON public.products (price_checked_at NULLS FIRST)
  WHERE source = 'crawl' AND is_visible = true AND product_url IS NOT NULL;

CREATE INDEX IF NOT EXISTS products_price_review_idx
  ON public.products (organization_id)
  WHERE price_review IS NOT NULL;

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS price_check_daily boolean NOT NULL DEFAULT true;
