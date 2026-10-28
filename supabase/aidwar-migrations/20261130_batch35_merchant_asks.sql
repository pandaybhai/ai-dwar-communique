-- Batch 35: merchant asks. Idempotent. NOT applied: apply by hand to the
-- Mumbai project (hcsacmqzspnfqoftoifu) after the code is live.
--
-- (1) Campaign test send: the new activity action campaign_test_sent is
--     listed on the campaigns feature_registry row (as feature-registry.ts
--     declares it). Nothing else: a test is an ordinary messages row
--     (metadata.test = true, campaign_id null), charged by the existing
--     messages billing trigger. Before this file: tests work; only the
--     registry row doesn't list the action yet.
-- (3) WhatsApp profile: its three activity actions on the settings
--     feature_registry row. The profile itself lives at Meta; nothing stored.
-- (4) Delete flows (Flows v2), a soft delete:
--     * flows.config.deleted_at / deleted_by / enabled_before mark a deleted
--       flow (the website-source precedent: no new column, so every read
--       that filters on it works before and after this file);
--     * flow_runs.end_reason, and 'ended' added to flow_runs_status_check
--       (rebuilt from the values it already allows — never narrower);
--     * flow_soft_delete(): one transaction — the mark, is_enabled off, and
--       every running / waiting / paused run ended (status 'ended',
--       end_reason 'flow_deleted', an 'ended' run event). Sends nothing;
--       runs, events and messages stay;
--     * flow_restore_deleted(): within 30 days and before the purge, undoes
--       the mark exactly (is_enabled back to what it was). Ended runs stay
--       ended;
--     * purge_deleted_flows(): after 30 days, the definition goes — the HTTP
--       step secrets (Vault removed by their own trigger), the triggers'
--       settings (switched off; their fire history stays), and every version
--       no run points at. The flows row and the versions runs point at stay,
--       because flow_runs / flow_run_events / flow_trigger_fires cascade from
--       them: deleting them would delete the run history. Messages are never
--       touched. Called by the daily flow-scan.
--     Before this file: "Delete flow" answers that the database update is
--     needed and changes nothing; every other flow path is as before.
-- (7) pending_owner_replies.notify may only be 'silent' or 'ping' (NOT VALID:
--     old rows aren't re-checked). The fix itself is in code: nothing writes
--     'ping' any more, the waiting list reads only 'ping' rows from a
--     customer, an answer needs the owner's explicit pick, and a plain owner
--     message right after a "customer is waiting" alert is never saved as a
--     fact. Before this file: all of that already holds.

SET lock_timeout = '5s';

-- (1) ------------------------------------------------- campaign test send
UPDATE public.feature_registry
   SET activity_actions = coalesce(activity_actions, '{}'::text[]) || array['campaign_test_sent']::text[],
       synced_at = now()
 WHERE key = 'campaigns'
   AND NOT ('campaign_test_sent' = ANY (coalesce(activity_actions, '{}'::text[])));

-- (3) ------------------------------------------------- WhatsApp profile
-- Settings → WhatsApp → profile reads and writes Meta's
-- whatsapp_business_profile directly; nothing is stored. Its three activity
-- actions are listed on the settings feature_registry row.
UPDATE public.feature_registry
   SET activity_actions = coalesce(activity_actions, '{}'::text[]) || ARRAY(
         SELECT a FROM unnest(array['whatsapp_profile_updated','whatsapp_profile_photo_updated','whatsapp_display_name_requested']::text[]) AS a
          WHERE NOT (a = ANY (coalesce(activity_actions, '{}'::text[])))
       ),
       synced_at = now()
 WHERE key = 'settings'
   AND NOT (coalesce(activity_actions, '{}'::text[]) @> array['whatsapp_profile_updated','whatsapp_profile_photo_updated','whatsapp_display_name_requested']::text[]);

-- (4) ----------------------------------------------------- delete flows
ALTER TABLE public.flow_runs ADD COLUMN IF NOT EXISTS end_reason text;

DO $$
DECLARE
  def text;
  current_values text[];
  allowed text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'flow_runs_status_check' AND conrelid = 'public.flow_runs'::regclass;
  IF def IS NOT NULL THEN
    SELECT coalesce(array_agg(m[1]), '{}') INTO current_values
    FROM regexp_matches(def, '''([^'']*)''', 'g') AS m;
    IF NOT ('ended' = ANY (current_values)) THEN
      SELECT string_agg(quote_literal(v), ', ' ORDER BY v) INTO allowed
      FROM (
        SELECT unnest(current_values) AS v
        UNION SELECT DISTINCT status FROM public.flow_runs WHERE status IS NOT NULL
        UNION SELECT 'ended'
      ) s;
      ALTER TABLE public.flow_runs DROP CONSTRAINT flow_runs_status_check;
      EXECUTE format('ALTER TABLE public.flow_runs ADD CONSTRAINT flow_runs_status_check CHECK (status IN (%s))', allowed);
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.flow_soft_delete(p_org uuid, p_flow uuid, p_actor uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_flow public.flows%rowtype;
  v_ended integer := 0;
begin
  select * into v_flow from public.flows
   where id = p_flow and organization_id = p_org and key like 'v2:%'
   for update;
  if not found then raise exception 'FLOW_NOT_FOUND'; end if;
  if coalesce(v_flow.config, '{}'::jsonb) ? 'deleted_at' then return 0; end if;

  update public.flows
     set config = coalesce(config, '{}'::jsonb) || jsonb_build_object(
           'deleted_at', now(), 'deleted_by', p_actor, 'enabled_before', is_enabled),
         is_enabled = false,
         updated_at = now()
   where id = p_flow;

  with ended as (
    update public.flow_runs
       set status = 'ended', end_reason = 'flow_deleted', ended_at = now(),
           waiting_for = null, wake_at = null, claimed_at = null
     where flow_id = p_flow and organization_id = p_org
       and status in ('running', 'waiting', 'paused')
    returning id, organization_id, current_node_id
  ), logged as (
    insert into public.flow_run_events (organization_id, run_id, node_id, event, detail, idempotency_key)
    select organization_id, id, current_node_id, 'ended', jsonb_build_object('reason', 'flow_deleted'), 'flow_deleted:' || id
      from ended
    on conflict (idempotency_key) do nothing
    returning 1
  )
  select count(*) into v_ended from ended;
  return v_ended;
end
$function$;

CREATE OR REPLACE FUNCTION public.flow_restore_deleted(p_org uuid, p_flow uuid, p_window interval DEFAULT interval '30 days')
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_flow public.flows%rowtype;
begin
  select * into v_flow from public.flows
   where id = p_flow and organization_id = p_org and key like 'v2:%'
   for update;
  if not found then raise exception 'FLOW_NOT_FOUND'; end if;
  if not (coalesce(v_flow.config, '{}'::jsonb) ? 'deleted_at') then return true; end if;
  if v_flow.config ? 'purged_at' or (v_flow.config->>'deleted_at')::timestamptz < now() - p_window then
    raise exception 'FLOW_RESTORE_EXPIRED';
  end if;
  update public.flows
     set config = config - 'deleted_at' - 'deleted_by' - 'enabled_before',
         is_enabled = coalesce((v_flow.config->>'enabled_before')::boolean, false),
         updated_at = now()
   where id = p_flow;
  return true;
end
$function$;

CREATE OR REPLACE FUNCTION public.purge_deleted_flows(p_older_than interval DEFAULT interval '30 days', p_limit integer DEFAULT 100)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_done integer := 0;
begin
  for v_id in
    select id from public.flows
     where key like 'v2:%'
       and config ? 'deleted_at'
       and not (config ? 'purged_at')
       and (config->>'deleted_at')::timestamptz < now() - p_older_than
     order by (config->>'deleted_at')::timestamptz
     limit greatest(p_limit, 0)
     for update skip locked
  loop
    delete from public.flow_http_secrets where flow_id = v_id;
    update public.flow_triggers set is_enabled = false, config = '{}'::jsonb where flow_id = v_id;
    delete from public.flow_versions v
     where v.flow_id = v_id
       and not exists (select 1 from public.flow_runs r where r.version_id = v.id);
    update public.flows
       set config = config || jsonb_build_object('purged_at', now()), updated_at = now()
     where id = v_id;
    v_done := v_done + 1;
  end loop;
  return v_done;
end
$function$;

REVOKE ALL ON FUNCTION public.flow_soft_delete(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.flow_restore_deleted(uuid, uuid, interval) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_deleted_flows(interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.flow_soft_delete(uuid, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.flow_restore_deleted(uuid, uuid, interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_deleted_flows(interval, integer) TO service_role;

-- flows_v2 activity actions for a delete and a restore.
UPDATE public.feature_registry
   SET activity_actions = coalesce(activity_actions, '{}'::text[]) || ARRAY(
         SELECT a FROM unnest(array['flow_v2_deleted','flow_v2_undeleted']::text[]) AS a
          WHERE NOT (a = ANY (coalesce(activity_actions, '{}'::text[])))
       ),
       synced_at = now()
 WHERE key = 'flows_v2'
   AND NOT (coalesce(activity_actions, '{}'::text[]) @> array['flow_v2_deleted','flow_v2_undeleted']::text[]);

-- (7) ------------------------------------- the owner's waiting list
-- Only two values exist: 'silent' (Unanswered, dashboard only — the default)
-- and 'ping' (the owner's WhatsApp waiting list, which no code writes since
-- Batch 35). Anything else is refused from now on; existing rows are not
-- re-checked (NOT VALID), so applying this can never fail on old data.
DO $$
BEGIN
  IF to_regclass('public.pending_owner_replies') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conname = 'pending_owner_replies_notify_check'
          AND conrelid = 'public.pending_owner_replies'::regclass
     ) THEN
    ALTER TABLE public.pending_owner_replies
      ADD CONSTRAINT pending_owner_replies_notify_check CHECK (notify IN ('silent', 'ping')) NOT VALID;
  END IF;
END $$;
