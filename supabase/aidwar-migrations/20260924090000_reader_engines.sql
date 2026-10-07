-- Applied to aidwar-mumbai via psql 2026-09-24: multiple readers (Tavily + Firecrawl + own).
alter table public.platform_settings
  add column if not exists reader_primary text not null default 'tavily' check (reader_primary in ('own','tavily','firecrawl')),
  add column if not exists reader_fallback_order text[] not null default array['tavily','firecrawl','own'],
  add column if not exists tavily_extract_depth text not null default 'basic' check (tavily_extract_depth in ('basic','advanced')),
  add column if not exists map_engine text not null default 'own' check (map_engine in ('own','tavily','firecrawl')),
  add column if not exists tavily_monthly_credit_cap integer default 900,
  add column if not exists tavily_workspace_monthly_cap integer default 200;
update public.platform_settings set firecrawl_monthly_credit_cap = 450, firecrawl_workspace_monthly_cap = 100;

create table if not exists public.reader_usage (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  engine text not null check (engine in ('tavily')),
  month date not null,
  credits integer not null default 0,
  calls integer not null default 0,
  refused integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (organization_id, engine, month)
);
grant all on public.reader_usage to service_role;
alter table public.reader_usage enable row level security;
create policy reader_usage_super_admin on public.reader_usage for select to authenticated using (public.is_super_admin());
grant select on public.reader_usage to authenticated;

create or replace function public.reader_try_spend(_org uuid, _engine text, _credits integer)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare
  _month date := date_trunc('month', now())::date;
  _pcap integer; _ocap integer; _pused integer; _oused integer;
begin
  if _engine <> 'tavily' then return false; end if;
  select tavily_monthly_credit_cap, tavily_workspace_monthly_cap into _pcap, _ocap from platform_settings limit 1;
  perform pg_advisory_xact_lock(hashtext('reader_spend_' || _engine));
  select coalesce(sum(credits),0) into _pused from reader_usage where engine = _engine and month = _month;
  select coalesce(credits,0) into _oused from reader_usage where organization_id = _org and engine = _engine and month = _month;
  _oused := coalesce(_oused, 0);
  if (_pcap is not null and _pused + _credits > _pcap) or (_ocap is not null and _oused + _credits > _ocap) then
    insert into reader_usage (organization_id, engine, month, refused) values (_org, _engine, _month, 1)
      on conflict (organization_id, engine, month) do update set refused = reader_usage.refused + 1, updated_at = now();
    return false;
  end if;
  insert into reader_usage (organization_id, engine, month, credits, calls) values (_org, _engine, _month, _credits, 1)
    on conflict (organization_id, engine, month) do update set credits = reader_usage.credits + _credits, calls = reader_usage.calls + 1, updated_at = now();
  return true;
end $$;
revoke all on function public.reader_try_spend(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.reader_try_spend(uuid, text, integer) to service_role;
