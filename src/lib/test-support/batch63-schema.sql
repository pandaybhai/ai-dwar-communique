-- Test-only: the slice of the live schema 20261350_batch63.sql and
-- scripts/batch63-override-backfill.sql touch — organizations,
-- organization_feature_overrides, organization_billing_settings, contacts,
-- messages, activity_log — and no-op mcp_block_oauth_*(). For
-- batch63-sql.test.ts on the throwaway local Postgres. Never applied anywhere else.
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null
);
create table public.organization_feature_overrides (
  organization_id uuid not null,
  flag_key text not null,
  enabled boolean not null,
  updated_at timestamptz not null default now(),
  primary key (organization_id, flag_key)
);
create table public.organization_billing_settings (
  organization_id uuid primary key,
  limits_override jsonb not null default '{}'::jsonb
);
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  phone text not null,
  attributes jsonb not null default '{}'::jsonb
);
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  direction text not null,
  type text,
  template_name text,
  status text,
  created_at timestamptz not null default now()
);
create table public.activity_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  action text not null,
  details jsonb,
  created_at timestamptz not null default now()
);
create function public.mcp_block_oauth_writes() returns void language sql as $$ select $$;
create function public.mcp_block_oauth_reads() returns void language sql as $$ select $$;
