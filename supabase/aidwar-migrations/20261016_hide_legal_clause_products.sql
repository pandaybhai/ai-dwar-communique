-- Batch 11 (item 7, NOT applied): hide products the website reader saved off
-- a legal page. Its numbered clause headings next to an amount looked like a
-- product with a price ("7. Limitation of liability", 5000, read from
-- https://aidwar.in/terms). From Batch 11 the reader never takes products
-- from terms / privacy / refund / shipping-policy pages or numbered clause
-- headings (product-extract.server.ts), so these are not saved again.
--
-- Hidden (is_visible = false), never deleted. Only rows the website reader
-- saved (source = 'crawl'); a shop platform's products are never touched.
-- Idempotent: a row already hidden is not matched again, so a second run
-- changes nothing. No schema change.
--
-- Checked read-only on live, 6 Oct 2026 — exactly these 3 rows match:
--   c3665eb7-5e58-4e65-90a5-98a7c0c887c3  Ai Dwar  "7. Limitation of liability"  5000  https://aidwar.in/terms
--   98f76a4b-81a5-454d-9bf2-f3f834384341  Meezoy   "7. Limitation of liability"  5000  https://aidwar.in/terms
--   56207d9d-90bf-45fa-9288-1214ec2dc86a  Shiva    "7. Limitation of liability"  5000  https://aidwar.in/terms
-- To preview before applying, run the SELECT below.
--
--   SELECT id, organization_id, title, price, product_url
--   FROM public.products
--   WHERE source = 'crawl' AND is_visible = true
--     AND title ~* '^\s*(\(?[0-9]{1,2}(\.[0-9]{1,2})*[.)]|(section|clause|article)\s+[0-9]{1,2}(\.[0-9]{1,2})*[.:)]?)\s+\S';

UPDATE public.products
SET is_visible = false,
    updated_at = now()
WHERE source = 'crawl'
  AND is_visible = true
  AND title ~* '^\s*(\(?[0-9]{1,2}(\.[0-9]{1,2})*[.)]|(section|clause|article)\s+[0-9]{1,2}(\.[0-9]{1,2})*[.:)]?)\s+\S';
