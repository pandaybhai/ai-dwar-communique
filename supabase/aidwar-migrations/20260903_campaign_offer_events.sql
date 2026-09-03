-- Offer performance: who tapped a coupon, and who actually used it.
-- One row per contact per outcome, so replays and re-syncs can never
-- inflate the numbers.

create table if not exists public.campaign_offer_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  event text not null check (event in ('tapped', 'redeemed')),
  coupon_code text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists campaign_offer_events_unique_idx
  on public.campaign_offer_events (campaign_id, contact_id, event)
  where contact_id is not null;
create index if not exists campaign_offer_events_campaign_idx
  on public.campaign_offer_events (campaign_id, event);
create index if not exists campaign_offer_events_org_idx
  on public.campaign_offer_events (organization_id, created_at desc);

grant select on public.campaign_offer_events to authenticated;
grant all on public.campaign_offer_events to service_role;

alter table public.campaign_offer_events enable row level security;

drop policy if exists "campaign_offer_events_select_members" on public.campaign_offer_events;
create policy "campaign_offer_events_select_members"
  on public.campaign_offer_events
  for select
  to authenticated
  using (has_permission(organization_id, 'campaigns.view') or is_super_admin());
