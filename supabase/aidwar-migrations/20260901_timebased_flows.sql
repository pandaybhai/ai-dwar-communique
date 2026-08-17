-- Time-based flows: winback, reorder and review request.
--
-- Winback and reorder are not event-driven — they trigger on elapsed time
-- since a customer's last order, so a daily scan (/api/internal/flow-scan)
-- enrols them. No enrolment table exists on purpose: the partial unique index
-- on scheduled_sends (flow_step_id, trigger_id) already guarantees one send per
-- order, and both flows key their trigger to an order id.

alter table public.organization_send_settings
  add column if not exists winback_after_days int not null default 90
    check (winback_after_days between 1 and 730);
alter table public.organization_send_settings
  add column if not exists reorder_after_days int not null default 45
    check (reorder_after_days between 1 and 730);

create or replace function public.seed_timebased_flows(p_org uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_flow uuid;
begin
  -- Winback (marketing): one message when a customer has gone quiet.
  insert into public.flows (organization_id, key, name, is_enabled, config)
  values (p_org, 'winback', 'Winback', false, '{"message_class": "marketing"}'::jsonb)
  on conflict (organization_id, key) do nothing;
  select id into v_flow from public.flows where organization_id = p_org and key = 'winback';
  insert into public.flow_steps (flow_id, step_order, delay_minutes, condition)
  values (v_flow, 1, 0, '{}'::jsonb)
  on conflict (flow_id, step_order) do nothing;

  -- Reorder (marketing): one message per order once it is old enough.
  insert into public.flows (organization_id, key, name, is_enabled, config)
  values (p_org, 'reorder', 'Reorder reminder', false, '{"message_class": "marketing"}'::jsonb)
  on conflict (organization_id, key) do nothing;
  select id into v_flow from public.flows where organization_id = p_org and key = 'reorder';
  insert into public.flow_steps (flow_id, step_order, delay_minutes, condition)
  values (v_flow, 1, 0, '{}'::jsonb)
  on conflict (flow_id, step_order) do nothing;

  -- Review request (marketing): event-driven, three days after delivery.
  insert into public.flows (organization_id, key, name, is_enabled, config)
  values (p_org, 'review_request', 'Review request', false,
          '{"message_class": "marketing"}'::jsonb)
  on conflict (organization_id, key) do nothing;
  select id into v_flow from public.flows where organization_id = p_org and key = 'review_request';
  insert into public.flow_steps (flow_id, step_order, delay_minutes, condition)
  values (v_flow, 1, 4320, '{"event": "order_delivered"}'::jsonb)
  on conflict (flow_id, step_order) do nothing;
end;
$$;

revoke all on function public.seed_timebased_flows(uuid) from public, anon, authenticated;
grant execute on function public.seed_timebased_flows(uuid) to service_role;

-- Fold into the default seed so new workspaces get them too.
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
  perform public.seed_timebased_flows(p_org);

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
    perform public.seed_timebased_flows(r.id);
  end loop;
end $$;
