-- Who a shelf is meant for, when the shop says so.
alter table public.products add column if not exists gender text;
