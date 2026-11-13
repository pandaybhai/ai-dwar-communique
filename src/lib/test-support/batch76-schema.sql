-- Test-only: what 20260915_demo_leads.sql, 20261380_batch72.sql and
-- 20261400_batch76.sql need — roles, auth.uid() from the JWT claim,
-- organizations, a minimal profiles + platform_settings, is_super_admin()
-- and no-op mcp_block_oauth_*(). For batch76-sql.test.ts on the throwaway
-- local Postgres. Never applied anywhere else.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end $$;
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid());
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to authenticated, anon, service_role;
grant execute on function auth.uid() to authenticated, anon, service_role;
create table public.organizations (id uuid primary key default gen_random_uuid(), name text);
create table public.profiles (
  id uuid primary key,
  email text,
  full_name text,
  is_super_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create table public.platform_settings (id integer primary key, onboarding_whatsapp_account_id uuid);
insert into public.platform_settings (id) values (1);
create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_super_admin from public.profiles where id = auth.uid()), false)
$$;
grant execute on function public.is_super_admin() to authenticated, anon;
grant select, insert, update on public.profiles to authenticated;
create or replace function public.update_updated_at_column() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create function public.mcp_block_oauth_writes() returns void language sql as $$ select $$;
create function public.mcp_block_oauth_reads() returns void language sql as $$ select $$;
-- Batch 78: the Scripts table (20260914) the no-website interview seeds.
create table public.ai_prompt_blocks (
  key text primary key,
  name text not null,
  description text not null default '',
  content text not null default '',
  default_content text not null default '',
  version int not null default 1,
  updated_by uuid,
  updated_at timestamptz not null default now()
);
