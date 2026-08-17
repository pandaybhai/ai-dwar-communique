-- Cash-on-delivery order confirmation.
--
-- A COD order is asked for on WhatsApp before the merchant ships it, and the
-- customer's answer is recorded here. AiDwar holds read-only Shopify scopes, so
-- a cancellation is recorded in AiDwar only — the merchant still has to cancel
-- the order in Shopify themselves.

create table if not exists public.cod_confirmations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  order_id uuid not null unique references public.orders(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'cancelled', 'no_response')),
  asked_at timestamptz,
  responded_at timestamptz,
  response_raw text,
  message_id uuid references public.messages(id) on delete set null,
  scheduled_send_id uuid references public.scheduled_sends(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists cod_confirmations_org_status_idx
  on public.cod_confirmations (organization_id, status);
create index if not exists cod_confirmations_contact_idx
  on public.cod_confirmations (contact_id, status);

grant select on public.cod_confirmations to authenticated;
grant all on public.cod_confirmations to service_role;

alter table public.cod_confirmations enable row level security;

drop policy if exists "cod_confirmations_select" on public.cod_confirmations;
create policy "cod_confirmations_select" on public.cod_confirmations
  for select to authenticated
  using (public.has_permission(organization_id, 'flows.view') or public.is_super_admin());

drop trigger if exists update_cod_confirmations_updated_at on public.cod_confirmations;
create trigger update_cod_confirmations_updated_at before update on public.cod_confirmations
  for each row execute function public.update_updated_at_column();

-- ------------------------------------------------------------- seeded flow
-- Disabled on purpose: the merchant switches it on once both messages are
-- approved by WhatsApp.
create or replace function public.seed_cod_flow(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flow uuid;
begin
  insert into public.flows (organization_id, key, name, is_enabled, config)
  values (p_org, 'cod_confirmation', 'Cash-on-delivery confirmation', false,
          '{"message_class": "transactional"}'::jsonb)
  on conflict (organization_id, key) do nothing;

  select id into v_flow from public.flows
   where organization_id = p_org and key = 'cod_confirmation';

  insert into public.flow_steps (flow_id, step_order, delay_minutes, condition)
  values (v_flow, 1, 0, '{"event": "order_created", "cod_only": true}'::jsonb),
         (v_flow, 2, 240,
          '{"event": "order_created", "cod_only": true, "requires": "cod_pending"}'::jsonb)
  on conflict (flow_id, step_order) do nothing;
end;
$$;

revoke all on function public.seed_cod_flow(uuid) from public, anon, authenticated;
grant execute on function public.seed_cod_flow(uuid) to service_role;

-- Fold it into the default seed so new workspaces get it too.
create or replace function public.seed_default_flows(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flow uuid;
begin
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

  perform public.seed_cod_flow(p_org);

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
    perform public.seed_cod_flow(r.id);
  end loop;
end $$;
