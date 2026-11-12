-- Test-only: what 20260915_demo_leads.sql and 20261380_batch72.sql need —
-- roles, auth.users, organizations, update_updated_at_column() and no-op
-- mcp_block_oauth_*(). For batch72-sql.test.ts on the throwaway local
-- Postgres. Never applied anywhere else.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end $$;
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid());
create table public.organizations (id uuid primary key default gen_random_uuid(), name text);
create or replace function public.update_updated_at_column() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create function public.mcp_block_oauth_writes() returns void language sql as $$ select $$;
create function public.mcp_block_oauth_reads() returns void language sql as $$ select $$;
