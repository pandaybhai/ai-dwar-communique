-- Test-only: the slice of the live schema 20261330_batch61.sql touches —
-- organizations, the tables analytics_overview / analytics_timeseries read,
-- analytics_guard / analytics_window as 20260816 defines them (has_permission
-- stubbed to true), is_super_admin() (false) and no-op mcp_block_oauth_*().
-- For batch61-sql.test.ts on the throwaway local Postgres. Never applied anywhere else.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end $$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text
);
grant select, insert, update on public.organizations to authenticated;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  whatsapp_account_id uuid,
  status text not null default 'open',
  created_at timestamptz not null default now()
);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  conversation_id uuid,
  direction text not null,
  status text,
  metadata jsonb,
  created_at timestamptz not null default now()
);
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  created_at timestamptz not null default now()
);
create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  action text not null,
  created_at timestamptz not null default now()
);

create function public.has_permission(p_org uuid, p_key text) returns boolean language sql as $$ select true $$;
create function public.is_super_admin() returns boolean language sql as $$ select false $$;
create function public.mcp_block_oauth_writes() returns void language sql as $$ select $$;
create function public.mcp_block_oauth_reads() returns void language sql as $$ select $$;

CREATE OR REPLACE FUNCTION public.analytics_guard(p_organization_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  tz text;
BEGIN
  IF NOT public.has_permission(p_organization_id, 'analytics.view') THEN
    RAISE EXCEPTION 'You need the "View analytics" permission for this workspace.'
      USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(o.timezone, 'UTC') INTO tz
  FROM public.organizations o WHERE o.id = p_organization_id;
  RETURN COALESCE(tz, 'UTC');
END;
$$;

CREATE OR REPLACE FUNCTION public.analytics_window(p_tz text, p_from date, p_to date)
RETURNS TABLE (starts_at timestamptz, ends_at timestamptz)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (p_from::timestamp AT TIME ZONE p_tz),
         ((p_to + 1)::timestamp AT TIME ZONE p_tz);
$$;
