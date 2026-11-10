-- Test-only: the slice of the live schema 20261370_batch67.sql touches —
-- organizations, roles, is_org_member() — and no-op mcp_block_oauth_*().
-- For batch67-sql.test.ts on the throwaway local Postgres. Never applied anywhere else.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null
);
create table public.organization_members (
  organization_id uuid not null,
  user_id uuid not null
);
create function public.is_org_member(org uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.organization_members m where m.organization_id = org and m.user_id = auth.uid())
$$;
grant usage on schema public to authenticated, anon, service_role;
grant usage on schema auth to authenticated, anon, service_role;
grant execute on function auth.uid() to authenticated, anon, service_role;
grant execute on function public.is_org_member(uuid) to authenticated;
create function public.mcp_block_oauth_writes() returns void language sql as $$ select $$;
create function public.mcp_block_oauth_reads() returns void language sql as $$ select $$;
