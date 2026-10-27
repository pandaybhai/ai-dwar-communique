-- Test-only: the tables the Batch 34 migration touches that the load-test
-- schema doesn't have (registry, permissions, plans, workspace_connections),
-- shaped as on live, for the throwaway local Postgres. Never applied anywhere
-- else. has_permission here answers from the test.allow setting.
create table if not exists public.feature_flags (key text primary key, name text, description text, default_enabled boolean default false);
create table if not exists public.feature_registry (
  key text primary key, name text not null, description text not null, icon text not null,
  nav_path text, nav_order int, nav_permission text, flag_key text not null, settings_path text,
  permissions jsonb not null default '[]'::jsonb, analytics jsonb not null default '{}'::jsonb,
  activity_actions text[] not null default '{}', usage_meters jsonb not null default '[]'::jsonb,
  ai_tools jsonb not null default '[]'::jsonb, data_tables text[] not null default '{}',
  depends_on text[] not null default '{}', synced_at timestamptz not null default now()
);
create table if not exists public.permissions (
  key text primary key, name text, description text, category text, min_role text,
  constraint permissions_category_check check (category in ('inbox', 'templates', 'billing'))
);
create table if not exists public.role_permissions (role text, permission_key text, primary key (role, permission_key));
create table if not exists public.plans (id uuid primary key default gen_random_uuid(), key text, name text);
create table if not exists public.plan_versions (id uuid primary key default gen_random_uuid(), plan_id uuid references public.plans(id), features text[]);
create or replace function public.has_permission(org_id uuid, perm text) returns boolean
language sql stable as $$ select coalesce(current_setting('test.allow', true), '') = 'yes' $$;
grant execute on function public.has_permission(uuid, text) to authenticated;
create table if not exists public.workspace_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('google', 'razorpay')),
  account_label text,
  public_config jsonb not null default '{}'::jsonb,
  secret_vault_name text,
  status text not null default 'active' check (status in ('active', 'disconnected', 'error')),
  last_error text,
  connected_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);
