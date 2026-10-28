-- Test-only: the Flows v2 tables as the migrations create them (20260825,
-- 20261001, 20261003, 20261004, 20261007), for the throwaway local Postgres
-- the Batch 35 SQL test uses. Never applied anywhere else.
create table if not exists public.flows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  key text not null,
  name text not null,
  is_enabled boolean not null default false,
  whatsapp_account_id uuid references public.whatsapp_accounts(id) on delete set null,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, key)
);
create table if not exists public.flow_versions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.flows(id) on delete cascade,
  version integer not null,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  graph jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  created_at timestamptz not null default now(),
  unique (flow_id, version)
);
create table if not exists public.flow_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.flows(id) on delete cascade,
  version_id uuid not null references public.flow_versions(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  current_node_id text,
  status text not null default 'running'
    check (status in ('running','waiting','paused','done','failed','expired','cancelled')),
  waiting_for text check (waiting_for in ('reply','timer','payment')),
  wake_at timestamptz,
  claimed_at timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists flow_runs_one_active
  on public.flow_runs (flow_id, contact_id) where status in ('running','waiting','paused');
create table if not exists public.flow_run_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null references public.flow_runs(id) on delete cascade,
  node_id text,
  event text not null,
  detail jsonb not null default '{}'::jsonb,
  idempotency_key text unique,
  at timestamptz not null default now()
);
create table if not exists public.flow_triggers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.flows(id) on delete cascade,
  kind text not null,
  config jsonb not null default '{}'::jsonb,
  is_enabled boolean not null default true
);
create table if not exists public.flow_trigger_fires (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  trigger_id uuid not null references public.flow_triggers(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  run_id uuid references public.flow_runs(id) on delete set null,
  fired_at timestamptz not null default now()
);
create table if not exists public.flow_http_secrets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid references public.flows(id) on delete cascade,
  scope text not null default '',
  secret_vault_name text
);
-- The registry rows Batch 35 adds activity actions to.
insert into public.feature_registry (key, name, description, icon, flag_key, activity_actions) values
  ('campaigns', 'Campaigns', 'd', 'i', 'campaigns', array['campaign_created']),
  ('settings', 'Settings', 'd', 'i', 'settings', array['organization.created']),
  ('flows_v2', 'Chat flows', 'd', 'i', 'flows_v2', array['flow_v2_created', 'flow_v2_restored'])
on conflict (key) do nothing;
