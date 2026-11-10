-- Test-only: the slice of the live schema 20261360_batch66.sql touches —
-- organizations and contacts — and no-op mcp_block_oauth_*(). For
-- batch66-sql.test.ts on the throwaway local Postgres. Never applied anywhere else.
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null
);
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  phone text not null
);
create function public.mcp_block_oauth_writes() returns void language sql as $$ select $$;
create function public.mcp_block_oauth_reads() returns void language sql as $$ select $$;
