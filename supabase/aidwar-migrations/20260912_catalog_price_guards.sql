-- Catalogue data integrity: prices can never be negative, and imports report
-- how many rows landed with a warning as well as how many failed.

-- 1. Repair the rows that predate the constraint.
update public.products set price = null where sku = 'NEG-008' and price < 0;
update public.products set price = 0 where sku = 'FRE-017';
update public.products set price = null where price < 0;
update public.products set compare_at_price = null where compare_at_price < 0;

-- 2. Constraints (null stays allowed — "no price set" is a real state).
alter table public.products drop constraint if exists products_price_non_negative;
alter table public.products
  add constraint products_price_non_negative check (price is null or price >= 0);

alter table public.products drop constraint if exists products_compare_at_price_non_negative;
alter table public.products
  add constraint products_compare_at_price_non_negative
  check (compare_at_price is null or compare_at_price >= 0);

-- 3. Import runs count warned rows separately from failed rows.
alter table public.catalog_imports
  add column if not exists rows_warned integer not null default 0;
