-- Batch 10C: publishing a Flows v2 draft is one transaction.
-- NOT applied by the batch — apply when ready. Idempotent (create or replace,
-- revoke/grant). Until it is applied, src/lib/flow-publish.server.ts runs the
-- same writes step by step and puts back any that landed when a later one fails.
--
-- Archives the flow's published version, publishes the draft (with its sealed
-- graph) and switches the flow on — all or nothing. Service role only.

create or replace function public.flow_publish_version(
  p_organization_id uuid,
  p_flow_id uuid,
  p_version_id uuid,
  p_graph jsonb,
  p_user uuid
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version integer;
begin
  select version into v_version
    from public.flow_versions
   where id = p_version_id
     and flow_id = p_flow_id
     and organization_id = p_organization_id
     and status = 'draft'
   for update;
  if v_version is null then
    raise exception 'flow_publish_version: draft % not found for flow %', p_version_id, p_flow_id;
  end if;

  update public.flow_versions
     set status = 'archived'
   where flow_id = p_flow_id
     and status = 'published';

  update public.flow_versions
     set status = 'published',
         graph = p_graph,
         published_at = now(),
         published_by = p_user
   where id = p_version_id;

  update public.flows
     set is_enabled = true
   where id = p_flow_id
     and organization_id = p_organization_id;
  if not found then
    raise exception 'flow_publish_version: flow % not found', p_flow_id;
  end if;

  return v_version;
end;
$$;

revoke all on function public.flow_publish_version(uuid, uuid, uuid, jsonb, uuid) from public;
revoke all on function public.flow_publish_version(uuid, uuid, uuid, jsonb, uuid) from anon, authenticated;
grant execute on function public.flow_publish_version(uuid, uuid, uuid, jsonb, uuid) to service_role;
