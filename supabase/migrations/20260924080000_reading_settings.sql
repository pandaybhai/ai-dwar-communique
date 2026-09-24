-- Applied to aidwar-mumbai via psql on 2026-09-24 (Phase 5b reading settings).
alter table public.platform_settings
  add column if not exists crawl_engine text not null default 'firecrawl' check (crawl_engine in ('firecrawl','auto','own')),
  add column if not exists full_crawl_trigger text not null default 'on_number_connected' check (full_crawl_trigger in ('on_number_connected','on_plan_active','manual')),
  add column if not exists backfill_pages_per_day integer not null default 200 check (backfill_pages_per_day >= 0),
  add column if not exists on_demand_read boolean not null default true,
  add column if not exists refresh_days integer not null default 7 check (refresh_days >= 0),
  add column if not exists manual_refresh_cooldown_hours integer not null default 24 check (manual_refresh_cooldown_hours >= 0),
  add column if not exists plan_page_overrides jsonb not null default '{}'::jsonb,
  add column if not exists reading_version integer not null default 1,
  add column if not exists reading_updated_at timestamptz,
  add column if not exists reading_updated_by uuid;
alter table public.knowledge_sources
  add column if not exists total_pages integer,
  add column if not exists last_manual_refresh_at timestamptz,
  add column if not exists last_full_read_at timestamptz;
alter table public.ai_instructions add column if not exists origin text check (origin in ('owner','admin','suggested'));
create table if not exists public.knowledge_urls (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.knowledge_sources(id) on delete cascade,
  url text not null, title text, priority integer not null default 0,
  status text not null default 'unread' check (status in ('unread','read')),
  read_at timestamptz, read_via text, conversation_id uuid,
  created_at timestamptz not null default now(), unique (source_id, url)
);
grant select on public.knowledge_urls to authenticated;
grant all on public.knowledge_urls to service_role;
alter table public.knowledge_urls enable row level security;
create policy knowledge_urls_select on public.knowledge_urls for select to authenticated
  using (public.is_org_member(organization_id) or public.is_super_admin());
