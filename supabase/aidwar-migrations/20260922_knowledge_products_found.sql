-- How many products the latest read of a website found.
alter table public.knowledge_sources
  add column if not exists products_found integer not null default 0;
