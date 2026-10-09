-- Test-only (Batch 26a): the tables and functions the live billing triggers
-- in 20261066_live_only_billing.sql touch that the load-test schema
-- (loadtest/schema.sql) doesn't have, so that file can be applied to a
-- throwaway database and its triggers exercised. NOT production
-- definitions: ist_month, meta_consume and ai_usage_months are live-only and
-- stand-ins here. Never applied anywhere but a scratch database.

alter table public.organizations
  add column if not exists plan_version_id uuid,
  add column if not exists trial_ends_at timestamptz;

create table if not exists public.plans (id uuid primary key default gen_random_uuid());
create table if not exists public.plan_versions (
  id uuid primary key default gen_random_uuid(),
  limits jsonb not null default '{}'::jsonb
);
create table if not exists public.organization_ai_settings (
  organization_id uuid primary key,
  ai_monthly_cap_amount numeric
);
create table if not exists public.organization_feature_overrides (
  organization_id uuid not null,
  flag_key text not null,
  enabled boolean not null,
  updated_at timestamptz default now(),
  primary key (organization_id, flag_key)
);
alter table public.organization_billing_settings
  add column if not exists starter_credits numeric,
  add column if not exists ai_answers_included_override int;

create table if not exists public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  mode text
);
create table if not exists public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  status text not null,
  billed_amount numeric,
  cost_amount numeric,
  sources jsonb,
  created_at timestamptz not null default now()
);
-- Batch 28: the columns that say whether a run is a customer answer.
alter table public.ai_runs
  add column if not exists task text,
  add column if not exists conversation_id uuid,
  add column if not exists metadata jsonb default '{}'::jsonb,
  add column if not exists tier text;
-- Stand-in: one row per workspace and IST month.
create table if not exists public.ai_usage_months (
  organization_id uuid not null,
  month date not null,
  allowance int,
  answers int default 0,
  over_answers int default 0,
  provider_cost numeric default 0,
  billed_amount numeric default 0,
  updated_at timestamptz default now(),
  primary key (organization_id, month)
);
-- Stand-in: the month a moment falls in, India time.
create or replace function public.ist_month(ts timestamptz) returns date
language sql immutable as $$ select date_trunc('month', ts at time zone 'Asia/Kolkata')::date $$;
-- Stand-in: the repo's ai_answers_allowance reads plan_versions; the test sets the override.
create or replace function public.ai_answers_allowance(p_org uuid) returns integer
language sql stable as $$
  select coalesce((select ai_answers_included_override from public.organization_billing_settings where organization_id = p_org), 0)
$$;
-- Stand-ins for functions the live triggers call and the test doesn't exercise.
create or replace function public.meta_consume(p_org uuid, p_wa uuid, p_amount numeric, p_ref_type text, p_ref_id uuid)
returns void language sql as $$ select null::void $$;
create or replace function public.log_super_admin_write() returns trigger
language plpgsql as $$ begin return null; end $$;
