-- Batch 26a item M17 (NOT applied): the billing functions, triggers and the
-- coupons table that existed only on the live database, saved as it runs
-- them. pg_get_functiondef output, trigger definitions and the coupons table
-- were pulled read-only on 8 Oct 2026 and pasted on PR #34. Function bodies
-- are byte-for-byte as pasted (each followed by its live md5 and length);
-- only the closing semicolons, the REVOKE/GRANT lines restating the live
-- grants, and IF NOT EXISTS / OR REPLACE on the tables and triggers are added.
-- Idempotent: re-stating identical definitions changes nothing on live.
--
-- Live grants: every function here is SECURITY DEFINER, owner postgres,
-- EXECUTE for postgres + service_role only.
--
-- Still live-only (referenced here, not yet in the repo; ask before saving):
--   public.meta_consume(...)      called by trg_messages_meta_consume
--   public.ist_month(timestamptz) called by trg_ai_runs_billing
--   table public.ai_usage_months  written by trg_ai_runs_billing
-- Their bodies / definition were not pasted, so none is guessed here.
--
-- Other live triggers on these tables use functions already in the repo
-- (live md5 of pg_get_functiondef, for comparison):
--   log_super_admin_write 202adcdc7af873669a937ae461b06c4d
--   track_send_health 5df537d6883a0dde9194b0541939f389
--   trg_guard_org_privileged_columns 80fc35088af0203bc5550a92678da3ab
--   trg_org_defaults_on_insert 28ffbd2c93ba8722dccf2459f6803abf
--   seed_org_ai_defaults fba79dbe3b34b19986ecd1de38f172e9
--   seed_flows_for_new_org 454fd53c20fc28c0608a176e54bf159a
--   update_updated_at_column bde6071fc6ee0e836c2d7605807f0070
-- and are recorded (not re-created) at the end of this file.

SET lock_timeout = '5s';
-- billing_debit_message(uuid): live md5 1960b0e87eb293f8e8ffcf747a19dbf9, 1774 chars
CREATE OR REPLACE FUNCTION public.billing_debit_message(p_message_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare m record; phone text; cc text; r record; already boolean; enabled_at timestamptz;
begin
  select id, organization_id, conversation_id, pricing_category, cost_amount, status, campaign_id, flow_id, created_at
    into m from public.messages where id = p_message_id;
  if m.id is null or coalesce(m.cost_amount,0) <= 0 then return false; end if;
  if not public.org_flag_enabled(m.organization_id, 'billing') then return false; end if;
  select billing_enabled_at into enabled_at from public.organizations where id = m.organization_id;
  if enabled_at is null or m.created_at < enabled_at then return false; end if;

  select exists(select 1 from public.wallet_ledger where reference_type='message' and reference_id=m.id and entry_type='debit_message') into already;
  if already then return false; end if;

  select c2.phone into phone from public.conversations cv join public.contacts c2 on c2.id = cv.contact_id where cv.id = m.conversation_id;
  select mr.country_code into cc from public.message_rates mr
    where regexp_replace(coalesce(phone,''),'\D','','g') like mr.dial_code || '%' order by length(mr.dial_code) desc limit 1;
  select * into r from public.client_rate_for(m.organization_id, coalesce(cc,'IN'), m.pricing_category);

  perform public.wallet_apply(m.organization_id, 'debit_message', coalesce(r.rate, m.cost_amount), 'message', m.id,
    'Message ' || m.pricing_category, jsonb_build_object('meta_cost', m.cost_amount, 'client_rate', r.rate,
      'campaign_id', m.campaign_id, 'flow_id', m.flow_id, 'from_hold', (m.campaign_id is not null)));
  return true;
end $function$;

REVOKE ALL ON FUNCTION public.billing_debit_message(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_debit_message(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.billing_debit_message(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.billing_debit_message(uuid) TO service_role;

-- trg_messages_billing(): live md5 e1f833e9e678dd3ac69f82e2ee5c8247, 643 chars
CREATE OR REPLACE FUNCTION public.trg_messages_billing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.direction = 'outbound' and coalesce(new.cost_amount,0) > 0
     and (old.cost_amount is distinct from new.cost_amount) then
    begin
      perform public.billing_debit_message(new.id);
    exception when others then
      insert into public.usage_records(organization_id, meter_key, quantity, metadata)
      values (new.organization_id, 'billing_debit_failed', 1, jsonb_build_object('message_id', new.id, 'error', sqlerrm));
    end;
  end if;
  return new;
end $function$;

REVOKE ALL ON FUNCTION public.trg_messages_billing() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_messages_billing() FROM anon;
REVOKE ALL ON FUNCTION public.trg_messages_billing() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trg_messages_billing() TO service_role;

-- trg_messages_meta_consume(): live md5 06f00ffdb6732c4d43331b33ca3c94b1, 828 chars
CREATE OR REPLACE FUNCTION public.trg_messages_meta_consume()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare fm text; wa uuid; enabled_at timestamptz;
begin
  if new.direction = 'outbound' and coalesce(new.cost_amount,0) > 0 and (old.cost_amount is distinct from new.cost_amount) then
    select funding_model, billing_enabled_at into fm, enabled_at from public.organizations where id = new.organization_id;
    if fm = 'aidwar_prepaid' and enabled_at is not null and new.created_at >= enabled_at then
      select id into wa from public.whatsapp_accounts where organization_id = new.organization_id and is_default limit 1;
      perform public.meta_consume(new.organization_id, wa, new.cost_amount, 'message', new.id);
    end if;
  end if;
  return new;
end $function$;

REVOKE ALL ON FUNCTION public.trg_messages_meta_consume() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_messages_meta_consume() FROM anon;
REVOKE ALL ON FUNCTION public.trg_messages_meta_consume() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trg_messages_meta_consume() TO service_role;

-- trg_ai_runs_billing(): live md5 5b3edd37602e6e3f10d9fe0280b68c60, 2700 chars
CREATE OR REPLACE FUNCTION public.trg_ai_runs_billing()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare used int; allowance int; already boolean; enabled_at timestamptz; m date;
begin
  if new.status <> 'ok' then return new; end if;
  m := public.ist_month(new.created_at);

  insert into public.ai_usage_months(organization_id, month, allowance)
  values (new.organization_id, m, public.ai_answers_allowance(new.organization_id))
  on conflict (organization_id, month) do nothing;
  select a.allowance into allowance from public.ai_usage_months a where a.organization_id = new.organization_id and a.month = m;

  select exists(select 1 from public.wallet_ledger where reference_type='ai_run' and reference_id=new.id) into already;

  if not already and coalesce(new.billed_amount,0) > 0
     and public.org_flag_enabled(new.organization_id, 'billing') then
    select billing_enabled_at into enabled_at from public.organizations where id = new.organization_id;
    if enabled_at is not null and new.created_at >= enabled_at then
      select count(*) into used from public.ai_runs
        where organization_id = new.organization_id and status = 'ok' and id <> new.id
          and public.ist_month(created_at) = m;
      if allowance >= 0 and used >= allowance then
        begin
          perform public.wallet_apply(new.organization_id, 'debit_ai', new.billed_amount, 'ai_run', new.id, 'AI answer (over allowance)',
            jsonb_build_object('provider_cost', new.cost_amount, 'used_this_month', used + 1, 'allowance', allowance));
        exception when others then
          insert into public.usage_records(organization_id, meter_key, quantity, metadata)
          values (new.organization_id, 'billing_debit_failed', 1, jsonb_build_object('ai_run_id', new.id, 'error', sqlerrm));
        end;
      end if;
    end if;
  end if;

  update public.ai_usage_months a set
    answers = s.answers,
    over_answers = greatest(s.answers - a.allowance, 0),
    provider_cost = s.cost,
    billed_amount = coalesce((select sum(-l.amount) from public.wallet_ledger l join public.ai_runs r on r.id = l.reference_id
                              where l.entry_type='debit_ai' and l.reference_type='ai_run' and r.organization_id = a.organization_id
                                and public.ist_month(r.created_at) = a.month), 0),
    updated_at = now()
  from (select count(*) answers, coalesce(sum(cost_amount),0) cost from public.ai_runs
        where organization_id = new.organization_id and status='ok' and public.ist_month(created_at) = m) s
  where a.organization_id = new.organization_id and a.month = m;
  return new;
end $function$;

REVOKE ALL ON FUNCTION public.trg_ai_runs_billing() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_ai_runs_billing() FROM anon;
REVOKE ALL ON FUNCTION public.trg_ai_runs_billing() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trg_ai_runs_billing() TO service_role;

-- trg_ai_runs_welcome_credits(): live md5 0d224bd8b79831619ca424bdaf06e362, 1136 chars
CREATE OR REPLACE FUNCTION public.trg_ai_runs_welcome_credits()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare amt numeric; has_plan boolean; has_ledger boolean;
begin
  if new.status <> 'ok' or jsonb_array_length(coalesce(new.sources, '[]'::jsonb)) = 0 then return new; end if;
  select plan_version_id is not null into has_plan from public.organizations where id = new.organization_id;
  select exists(select 1 from public.wallet_ledger where organization_id = new.organization_id) into has_ledger;
  if coalesce(has_plan,false) or has_ledger then return new; end if;
  select coalesce(starter_credits, 100) into amt from public.organization_billing_settings where organization_id = new.organization_id;
  amt := coalesce(amt, 100);
  begin
    perform public.wallet_apply(new.organization_id, 'starter_credits', amt, 'ai_run', new.id,
      'Welcome credits — Aiden learned your business',
      jsonb_build_object('reason', 'first_sourced_answer', 'sources', jsonb_array_length(new.sources)));
  exception when unique_violation then null;
  end;
  return new;
end $function$;

REVOKE ALL ON FUNCTION public.trg_ai_runs_welcome_credits() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_ai_runs_welcome_credits() FROM anon;
REVOKE ALL ON FUNCTION public.trg_ai_runs_welcome_credits() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trg_ai_runs_welcome_credits() TO service_role;

-- trg_guard_plan_status(): live md5 bb3cef87ed53c5c58f9731c003000ba5, 790 chars
CREATE OR REPLACE FUNCTION public.trg_guard_plan_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.plan_status in ('past_due','locked','paused') and old.plan_status is distinct from new.plan_status then
    -- Allowed: a plan with billing on (dunning), or an expired trial being locked.
    if not (
      (new.plan_version_id is not null and public.org_flag_enabled(new.id, 'billing'))
      or (new.plan_status = 'locked' and old.plan_status = 'trial' and new.trial_ends_at is not null and new.trial_ends_at <= now())
    ) then
      raise exception 'PLAN_STATUS_GUARD: cannot set % on an organisation without an assigned plan and billing enabled', new.plan_status;
    end if;
  end if;
  return new;
end $function$;

REVOKE ALL ON FUNCTION public.trg_guard_plan_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_guard_plan_status() FROM anon;
REVOKE ALL ON FUNCTION public.trg_guard_plan_status() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trg_guard_plan_status() TO service_role;

-- trg_org_plan_assigned_before(): live md5 f2867972f460516d68974a1174900240, 954 chars
CREATE OR REPLACE FUNCTION public.trg_org_plan_assigned_before()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cap numeric;
begin
  if new.plan_version_id is not null and old.plan_version_id is distinct from new.plan_version_id then
    if new.billing_enabled_at is null then new.billing_enabled_at := now(); end if;
    select coalesce((pv.limits->>'ai_monthly_cap')::numeric, 500) into cap from public.plan_versions pv where pv.id = new.plan_version_id;
    insert into public.organization_ai_settings(organization_id, ai_monthly_cap_amount) values (new.id, cap)
      on conflict (organization_id) do update set ai_monthly_cap_amount = greatest(organization_ai_settings.ai_monthly_cap_amount, excluded.ai_monthly_cap_amount);
    insert into public.organization_billing_settings(organization_id) values (new.id) on conflict (organization_id) do nothing;
  end if;
  return new;
end $function$;

REVOKE ALL ON FUNCTION public.trg_org_plan_assigned_before() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_org_plan_assigned_before() FROM anon;
REVOKE ALL ON FUNCTION public.trg_org_plan_assigned_before() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trg_org_plan_assigned_before() TO service_role;

-- trg_org_plan_assigned_billing_on(): live md5 74f5d2a6be2e6d6ac3ca1b46d768f58d, 536 chars
CREATE OR REPLACE FUNCTION public.trg_org_plan_assigned_billing_on()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.plan_version_id is not null and (old.plan_version_id is distinct from new.plan_version_id) then
    insert into public.organization_feature_overrides(organization_id, flag_key, enabled)
    values (new.id, 'billing', true)
    on conflict (organization_id, flag_key) do update set enabled = true, updated_at = now();
  end if;
  return new;
end $function$;

REVOKE ALL ON FUNCTION public.trg_org_plan_assigned_billing_on() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_org_plan_assigned_billing_on() FROM anon;
REVOKE ALL ON FUNCTION public.trg_org_plan_assigned_billing_on() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trg_org_plan_assigned_billing_on() TO service_role;

-- trg_ai_agent_mode_guard(): live md5 ada86bb9dbb13fcd371694743eb24bb6, 936 chars
CREATE OR REPLACE FUNCTION public.trg_ai_agent_mode_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare ok boolean; st text;
begin
  if new.mode in ('draft','replying') and (old.mode is distinct from new.mode) then
    select o.plan_status,
           (o.plan_version_id is not null and o.plan_status = 'active')
           or coalesce((select balance from public.wallet_balances b where b.organization_id = o.id), 0) > 0
      into st, ok from public.organizations o where o.id = new.organization_id;
    if st in ('locked','paused') then
      raise exception 'AI_GUARD: this workspace is % — choose a plan to continue', st using errcode = 'P0001';
    end if;
    if not coalesce(ok, false) then
      raise exception 'AI_GUARD: Aiden can start replying once this workspace has credits or a plan' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $function$;

REVOKE ALL ON FUNCTION public.trg_ai_agent_mode_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_ai_agent_mode_guard() FROM anon;
REVOKE ALL ON FUNCTION public.trg_ai_agent_mode_guard() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trg_ai_agent_mode_guard() TO service_role;

-- ------------------------------------------------------------ triggers
-- As pg_get_triggerdef reports them; OR REPLACE added so a re-run is a no-op.
CREATE OR REPLACE TRIGGER messages_billing_debit AFTER UPDATE OF cost_amount ON public.messages FOR EACH ROW EXECUTE FUNCTION trg_messages_billing();
CREATE OR REPLACE TRIGGER messages_meta_consume AFTER UPDATE OF cost_amount ON public.messages FOR EACH ROW EXECUTE FUNCTION trg_messages_meta_consume();
CREATE OR REPLACE TRIGGER ai_runs_billing_debit AFTER INSERT OR UPDATE OF billed_amount, status ON public.ai_runs FOR EACH ROW EXECUTE FUNCTION trg_ai_runs_billing();
CREATE OR REPLACE TRIGGER ai_runs_welcome_credits AFTER INSERT OR UPDATE OF status, sources ON public.ai_runs FOR EACH ROW EXECUTE FUNCTION trg_ai_runs_welcome_credits();
CREATE OR REPLACE TRIGGER guard_plan_status BEFORE UPDATE OF plan_status ON public.organizations FOR EACH ROW EXECUTE FUNCTION trg_guard_plan_status();
CREATE OR REPLACE TRIGGER org_plan_assigned_before BEFORE UPDATE OF plan_version_id ON public.organizations FOR EACH ROW EXECUTE FUNCTION trg_org_plan_assigned_before();
CREATE OR REPLACE TRIGGER org_plan_assigned_billing_on AFTER UPDATE OF plan_version_id ON public.organizations FOR EACH ROW EXECUTE FUNCTION trg_org_plan_assigned_billing_on();
CREATE OR REPLACE TRIGGER ai_agent_mode_guard BEFORE INSERT OR UPDATE OF mode ON public.ai_agents FOR EACH ROW EXECUTE FUNCTION trg_ai_agent_mode_guard();

-- ------------------------------------------------------------ coupons
-- As live (no coupon_redemptions table exists). Grants restated as live:
-- anon and authenticated hold every table privilege and RLS (super admin
-- only) is what protects the table — saved as is, not changed in this batch.
CREATE TABLE IF NOT EXISTS public.coupons (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  code text NOT NULL,
  kind text NOT NULL,
  value numeric NOT NULL,
  max_uses integer,
  uses integer NOT NULL DEFAULT 0,
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  valid_to date,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT coupons_pkey PRIMARY KEY (id),
  CONSTRAINT coupons_code_key UNIQUE (code),
  CONSTRAINT coupons_kind_check CHECK ((kind = ANY (ARRAY['percent_off_plan'::text, 'fixed_off_plan'::text, 'bonus_credits'::text])))
);
ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS coupons_admin ON public.coupons;
CREATE POLICY coupons_admin ON public.coupons FOR ALL TO authenticated USING (is_super_admin()) WITH CHECK (is_super_admin());
GRANT ALL ON public.coupons TO anon, authenticated, service_role;
CREATE OR REPLACE TRIGGER coupons_super_admin_audit AFTER INSERT OR DELETE OR UPDATE ON public.coupons FOR EACH ROW EXECUTE FUNCTION log_super_admin_write();

-- ------------------------------------------------------------ recorded only
-- The other live triggers on these tables (functions already in the repo),
-- as pg_get_triggerdef reported them on 8 Oct; not re-created here:
--   CREATE TRIGGER ai_agents_updated_at BEFORE UPDATE ON public.ai_agents FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()
--   CREATE TRIGGER log_super_admin_write_trg AFTER INSERT OR DELETE OR UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION log_super_admin_write()
--   CREATE TRIGGER messages_track_send_health AFTER INSERT OR UPDATE OF status ON public.messages FOR EACH ROW EXECUTE FUNCTION track_send_health()
--   CREATE TRIGGER aaa_guard_org_privileged_columns BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION trg_guard_org_privileged_columns()
--   CREATE TRIGGER org_defaults_on_insert BEFORE INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION trg_org_defaults_on_insert()
--   CREATE TRIGGER organizations_seed_ai_defaults AFTER INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION seed_org_ai_defaults()
--   CREATE TRIGGER seed_flows_after_org_insert AFTER INSERT ON public.organizations FOR EACH ROW EXECUTE FUNCTION seed_flows_for_new_org()
--   CREATE TRIGGER plan_versions_super_admin_audit AFTER INSERT OR DELETE OR UPDATE ON public.plan_versions FOR EACH ROW EXECUTE FUNCTION log_super_admin_write()
--   CREATE TRIGGER plans_super_admin_audit AFTER INSERT OR DELETE OR UPDATE ON public.plans FOR EACH ROW EXECUTE FUNCTION log_super_admin_write()

RESET lock_timeout;
