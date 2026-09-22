-- Products read straight off a shop's own pages.
alter table public.products drop constraint if exists products_source_check;
alter table public.products
  add constraint products_source_check
  check (source = any (array['shopify'::text, 'manual'::text, 'import'::text, 'crawl'::text]));
