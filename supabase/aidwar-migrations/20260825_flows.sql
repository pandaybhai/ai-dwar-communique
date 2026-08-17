-- Scheduled messaging engine: flows, flow steps, scheduled sends and the
-- per-organization send policy (quiet hours + frequency caps).

-- ---------------------------------------------------------------- flows
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

create table if not exists public.flow_steps (
  id uuid primary key default gen_random_uuid(),
  flow_id uuid not null references public.flows(id) on delete cascade,
  step_order int not null,
  delay_minutes int not null default 0,
  template_id uuid references public.message_templates(id) on delete set null,
  condition jsonb not null default '{}'::jsonb,
  is_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (flow_id, step_order)
);

create table if not exists public.scheduled_sends (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  flow_id uuid not null references public.flows(id) on delete cascade,
  flow_step_id uuid not null references public.flow_steps(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete cascade,
  trigger_type text not null,
  trigger_id uuid,
  send_after timestamptz not null default now(),
  status text not null default 'scheduled'
    check (status in ('scheduled', 'sent', 'cancelled', 'failed', 'skipped')),
  cancel_reason text,
  message_id uuid references public.messages(id) on delete set null,
  error text,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One pending send per step per trigger row: the engine can never double-book.
create unique index if not exists scheduled_sends_pending_unique_idx
  on public.scheduled_sends (flow_step_id, trigger_id)
  where status = 'scheduled';
-- The worker's claim query.
create index if not exists scheduled_sends_due_idx
  on public.scheduled_sends (status, send_after);
create index if not exists scheduled_sends_org_idx
  on public.scheduled_sends (organization_id, created_at desc);
create index if not exists scheduled_sends_trigger_idx
  on public.scheduled_sends (trigger_id);
create index if not exists scheduled_sends_contact_sent_idx
  on public.scheduled_sends (contact_id, status, updated_at desc);

-- Quiet hours and frequency caps, per organization, with sane defaults.
create table if not exists public.organization_send_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  quiet_hours_enabled boolean not null default true,
  quiet_hours_start int not null default 21 check (quiet_hours_start between 0 and 23),
  quiet_hours_end int not null default 9 check (quiet_hours_end between 0 and 23),
  quiet_hours_exempt_transactional boolean not null default false,
  marketing_cap_per_day int not null default 1 check (marketing_cap_per_day >= 0),
  marketing_cap_per_week int not null default 3 check (marketing_cap_per_week >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- grants
grant select on public.flows to authenticated;
grant insert, update, delete on public.flows to authenticated;
grant select, insert, update, delete on public.flow_steps to authenticated;
grant select on public.scheduled_sends to authenticated;
grant select, insert, update on public.organization_send_settings to authenticated;
grant all on public.flows to service_role;
grant all on public.flow_steps to service_role;
grant all on public.scheduled_sends to service_role;
grant all on public.organization_send_settings to service_role;

alter table public.flows enable row level security;
alter table public.flow_steps enable row level security;
alter table public.scheduled_sends enable row level security;
alter table public.organization_send_settings enable row level security;

drop policy if exists "flows_select" on public.flows;
create policy "flows_select" on public.flows for select to authenticated
  using (public.has_permission(organization_id, 'flows.view') or public.is_super_admin());
drop policy if exists "flows_write" on public.flows;
create policy "flows_write" on public.flows for all to authenticated
  using (public.has_permission(organization_id, 'flows.manage'))
  with check (public.has_permission(organization_id, 'flows.manage'));

drop policy if exists "flow_steps_select" on public.flow_steps;
create policy "flow_steps_select" on public.flow_steps for select to authenticated
  using (exists (
    select 1 from public.flows f
    where f.id = flow_id
      and (public.has_permission(f.organization_id, 'flows.view') or public.is_super_admin())
  ));
drop policy if exists "flow_steps_write" on public.flow_steps;
create policy "flow_steps_write" on public.flow_steps for all to authenticated
  using (exists (
    select 1 from public.flows f
    where f.id = flow_id and public.has_permission(f.organization_id, 'flows.manage')
  ))
  with check (exists (
    select 1 from public.flows f
    where f.id = flow_id and public.has_permission(f.organization_id, 'flows.manage')
  ));

-- Scheduled sends are written by the worker only; the app reads them.
drop policy if exists "scheduled_sends_select" on public.scheduled_sends;
create policy "scheduled_sends_select" on public.scheduled_sends for select to authenticated
  using (public.has_permission(organization_id, 'flows.view') or public.is_super_admin());

drop policy if exists "send_settings_select" on public.organization_send_settings;
create policy "send_settings_select" on public.organization_send_settings for select to authenticated
  using (public.is_org_member(organization_id) or public.is_super_admin());
drop policy if exists "send_settings_write" on public.organization_send_settings;
create policy "send_settings_write" on public.organization_send_settings for all to authenticated
  using (public.has_permission(organization_id, 'flows.manage'))
  with check (public.has_permission(organization_id, 'flows.manage'));

drop trigger if exists update_flows_updated_at on public.flows;
create trigger update_flows_updated_at before update on public.flows
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_flow_steps_updated_at on public.flow_steps;
create trigger update_flow_steps_updated_at before update on public.flow_steps
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_scheduled_sends_updated_at on public.scheduled_sends;
create trigger update_scheduled_sends_updated_at before update on public.scheduled_sends
  for each row execute function public.update_updated_at_column();
drop trigger if exists update_send_settings_updated_at on public.organization_send_settings;
create trigger update_send_settings_updated_at before update on public.organization_send_settings
  for each row execute function public.update_updated_at_column();

-- ------------------------------------------------------- worker claim RPC
-- Small batches, SKIP LOCKED, and a claim stamp so two overlapping ticks can
-- never pick the same row. A claim older than 10 minutes is considered stale
-- (worker died mid-flight) and becomes claimable again.
create or replace function public.claim_scheduled_sends(p_limit int default 25)
returns setof public.scheduled_sends
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select s.id
    from public.scheduled_sends s
    where s.status = 'scheduled'
      and s.send_after <= now()
      and (s.claimed_at is null or s.claimed_at < now() - interval '10 minutes')
    order by s.send_after
    limit greatest(1, least(p_limit, 100))
    for update skip locked
  )
  update public.scheduled_sends s
  set claimed_at = now()
  from due
  where s.id = due.id
  returning s.*;
end;
$$;

revoke all on function public.claim_scheduled_sends(int) from public, anon, authenticated;
grant execute on function public.claim_scheduled_sends(int) to service_role;

-- --------------------------------------------------- seed the two flows
create or replace function public.seed_default_flows(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flow uuid;
begin
  -- Abandoned checkout (marketing): 60 minutes, then 24 hours.
  insert into public.flows (organization_id, key, name, is_enabled, config)
  values (p_org, 'abandoned_checkout', 'Abandoned checkout recovery', false,
          '{"message_class": "marketing"}'::jsonb)
  on conflict (organization_id, key) do nothing;

  select id into v_flow from public.flows
   where organization_id = p_org and key = 'abandoned_checkout';

  insert into public.flow_steps (flow_id, step_order, delay_minutes, condition)
  values (v_flow, 1, 60, '{"still_unrecovered": true}'::jsonb),
         (v_flow, 2, 1440, '{"still_unrecovered": true}'::jsonb)
  on conflict (flow_id, step_order) do nothing;

  -- Order lifecycle (transactional): confirmed, shipped, delivered.
  insert into public.flows (organization_id, key, name, is_enabled, config)
  values (p_org, 'order_lifecycle', 'Order lifecycle updates', false,
          '{"message_class": "transactional"}'::jsonb)
  on conflict (organization_id, key) do nothing;

  select id into v_flow from public.flows
   where organization_id = p_org and key = 'order_lifecycle';

  insert into public.flow_steps (flow_id, step_order, delay_minutes, condition)
  values (v_flow, 1, 0, '{"event": "order_created"}'::jsonb),
         (v_flow, 2, 0, '{"event": "order_fulfilled"}'::jsonb),
         (v_flow, 3, 0, '{"event": "order_delivered"}'::jsonb)
  on conflict (flow_id, step_order) do nothing;

  insert into public.organization_send_settings (organization_id)
  values (p_org)
  on conflict (organization_id) do nothing;
end;
$$;

revoke all on function public.seed_default_flows(uuid) from public, anon, authenticated;
grant execute on function public.seed_default_flows(uuid) to service_role;

do $$
declare r record;
begin
  for r in select id from public.organizations loop
    perform public.seed_default_flows(r.id);
  end loop;
end $$;

-- New workspaces get the same disabled defaults.
create or replace function public.seed_flows_for_new_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_default_flows(new.id);
  return new;
end;
$$;

drop trigger if exists seed_flows_after_org_insert on public.organizations;
create trigger seed_flows_after_org_insert after insert on public.organizations
  for each row execute function public.seed_flows_for_new_org();
