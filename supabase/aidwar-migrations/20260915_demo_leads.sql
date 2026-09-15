-- Landing page lead capture: sales enquiries from the public site.
-- Platform-owned data (not tenant data): no organization scopes these rows, so
-- RLS is enabled with NO policies at all — every read/write goes through
-- service-role server endpoints that verify profiles.is_super_admin first.
-- Applied to aidwar-mumbai through AIDWAR_MUMBAI_DB_URL.
begin;

create table if not exists public.demo_leads (
  id uuid primary key default gen_random_uuid(),

  -- step 1: qualification
  business_type text not null,
  enquiry_band text not null check (enquiry_band in ('0-20','21-100','101-500','500+')),
  primary_need text not null check (primary_need in ('replies','handoff','campaigns')),

  -- step 2: contact
  name text not null,
  business_name text not null,
  phone text not null,
  website text,

  -- consent
  consent boolean not null default false check (consent),
  consent_version text not null,
  consent_at timestamptz not null default now(),

  -- attribution (no ad click IDs are stored unless consented; see server code)
  landing_path text,
  referrer_host text,
  first_attribution jsonb not null default '{}'::jsonb,
  latest_attribution jsonb not null default '{}'::jsonb,
  source text not null default 'landing',

  -- pipeline
  status text not null default 'new'
    check (status in ('new','contacted','qualified','demo_booked','won','lost')),
  assigned_to uuid references auth.users(id) on delete set null,
  demo_at timestamptz,
  qualification jsonb not null default '{}'::jsonb,

  -- verified link to a real workspace (server-side identity only)
  organization_id uuid references public.organizations(id) on delete set null,
  linked_user_id uuid references auth.users(id) on delete set null,

  -- abuse controls
  ip_hash text,
  is_test boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists demo_leads_created_idx on public.demo_leads(created_at desc);
create index if not exists demo_leads_status_idx on public.demo_leads(status, created_at desc);
create index if not exists demo_leads_iphash_idx on public.demo_leads(ip_hash, created_at desc);
create index if not exists demo_leads_phone_idx on public.demo_leads(phone, created_at desc);

create table if not exists public.demo_lead_notes (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.demo_leads(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index if not exists demo_lead_notes_lead_idx on public.demo_lead_notes(lead_id, created_at desc);

-- service_role only: no grants to anon/authenticated anywhere.
grant all on public.demo_leads to service_role;
grant all on public.demo_lead_notes to service_role;

alter table public.demo_leads enable row level security;
alter table public.demo_lead_notes enable row level security;

drop trigger if exists update_demo_leads_updated_at on public.demo_leads;
create trigger update_demo_leads_updated_at
  before update on public.demo_leads
  for each row execute function public.update_updated_at_column();

commit;
