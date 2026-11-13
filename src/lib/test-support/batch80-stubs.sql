-- Test-only: the live billing pieces 20261430_batch80.sql touches, as small
-- stand-ins on the throwaway local Postgres (after batch76-schema.sql and the
-- demo_leads migrations). Never applied anywhere else.
alter table public.organizations add column if not exists funding_model text;
alter table public.organizations add column if not exists plan_version_id uuid;
alter table public.organizations add column if not exists billing_enabled_at timestamptz;

create table public.plans (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  tagline text,
  sort_order int not null default 0,
  is_active boolean not null default true,
  is_public boolean not null default true
);
create table public.plan_versions (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.plans(id),
  version int not null default 1,
  price_monthly numeric,
  price_annual numeric,
  currency text not null default 'INR',
  limits jsonb not null default '{}'::jsonb,
  highlights text[] not null default '{}',
  features text[] not null default '{}',
  is_current boolean not null default true
);
create table public.feature_flags (
  key text primary key, name text, description text, default_enabled boolean not null default false
);
create table public.feature_registry (
  key text primary key, name text, description text, icon text, nav_path text, nav_order int,
  nav_permission text, flag_key text, settings_path text, permissions jsonb, analytics jsonb,
  activity_actions text[], usage_meters jsonb, ai_tools jsonb, data_tables text[], depends_on text[],
  synced_at timestamptz
);
create table public.organization_feature_overrides (
  organization_id uuid, flag_key text, enabled boolean, primary key (organization_id, flag_key)
);
-- org_flag_enabled as live: override, then the plan's features, then the default.
create or replace function public.org_flag_enabled(p_org uuid, p_flag text) returns boolean
language sql stable as $$
  select coalesce(
    (select enabled from public.organization_feature_overrides where organization_id = p_org and flag_key = p_flag),
    (select p_flag = any(pv.features) from public.organizations o join public.plan_versions pv on pv.id = o.plan_version_id where o.id = p_org),
    (select default_enabled from public.feature_flags where key = p_flag),
    false)
$$;

create table public.contacts (id uuid primary key default gen_random_uuid(), phone text);
create table public.conversations (id uuid primary key default gen_random_uuid(), contact_id uuid);
create table public.messages (
  id uuid primary key default gen_random_uuid(), organization_id uuid, conversation_id uuid,
  pricing_category text, cost_amount numeric, status text, campaign_id uuid, flow_id uuid,
  direction text default 'outbound', created_at timestamptz not null default now()
);
create table public.message_rates (country_code text, dial_code text, category text, rate numeric);
insert into public.message_rates values ('IN', '91', 'marketing', 0.8631);
create table public.wallet_ledger (
  id uuid primary key default gen_random_uuid(), organization_id uuid, entry_type text,
  amount numeric, reference_type text, reference_id uuid, description text, metadata jsonb
);
create or replace function public.client_rate_for(p_org uuid, p_country text, p_category text)
returns table(rate numeric, currency text) language sql stable as $$
  select round(rate * 1.2, 2), 'INR'::text from public.message_rates where category = p_category limit 1
$$;
create or replace function public.wallet_apply(p_org uuid, p_type text, p_amount numeric, p_ref_type text,
  p_ref_id uuid, p_description text, p_metadata jsonb) returns void language sql as $$
  insert into public.wallet_ledger (organization_id, entry_type, amount, reference_type, reference_id, description, metadata)
  values (p_org, p_type, -p_amount, p_ref_type, p_ref_id, p_description, p_metadata)
$$;

create table public.usage_records (organization_id uuid, meter_key text, quantity int, metadata jsonb);
create table public.ai_runs (
  id uuid primary key default gen_random_uuid(), organization_id uuid, status text, task text,
  conversation_id uuid, metadata jsonb default '{}'::jsonb, billed_amount numeric, cost_amount numeric,
  created_at timestamptz not null default now()
);
create table public.ai_usage_months (
  organization_id uuid, month date, allowance int, answers int default 0, over_answers int default 0,
  provider_cost numeric default 0, billed_amount numeric default 0, updated_at timestamptz,
  primary key (organization_id, month)
);
create or replace function public.ist_month(t timestamptz) returns date language sql immutable as $$
  select date_trunc('month', t at time zone 'Asia/Kolkata')::date
$$;
create or replace function public.ai_answers_allowance(p_org uuid) returns int language sql stable as $$
  select 2
$$;
create or replace function public.ai_run_is_customer_answer(p_task text, p_conv uuid, p_meta jsonb)
returns boolean language sql immutable as $$ select p_task = 'agent_reply' and p_conv is not null $$;
-- The live trigger; its function is replaced by the migration.
create or replace function public.trg_ai_runs_billing() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger trg_ai_runs_billing after insert on public.ai_runs
  for each row execute function public.trg_ai_runs_billing();

do $$ begin
  if not exists (select 1 from pg_proc where proname = 'mcp_block_oauth_writes') then
    create function public.mcp_block_oauth_writes() returns void language sql as $f$ select $f$;
  end if;
  if not exists (select 1 from pg_proc where proname = 'mcp_block_oauth_reads') then
    create function public.mcp_block_oauth_reads() returns void language sql as $f$ select $f$;
  end if;
end $$;
