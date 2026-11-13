-- Batch 80 (NOT applied): the Basic plan — ₹999/month, self-serve from the
-- /999 page, the customer pays Meta directly for messages (zero markup).
--
-- Additive and idempotent. Applying it changes nothing for any existing
-- workspace: every rule below keys on the new 'meta_direct_billing' flag,
-- which is OFF by default and ON only in the Basic plan's features. ZOORI and
-- the other meta_direct workspaces keep today's billing byte for byte.
--
--   (1) the flag 'meta_direct_billing' (feature_flags default OFF +
--       feature_registry row, as scripts/sync-feature-registry.ts writes for
--       src/lib/feature-registry.ts). On = "this workspace pays Meta itself":
--       no message debits, no campaign holds or credit gates, no AI-answer
--       overage debit (Aiden hands chats to the inbox at the allowance).
--   (2) the plan: plans 'basic' (is_public false: never on /pricing, the
--       home page, /start or the in-app plan chooser; only /999 sells it and
--       a Super Admin can assign it) + its current plan_versions row.
--   (3) billing_debit_message: the 20261066 body with one line — a
--       meta_direct_billing workspace is never debited for a message.
--       billing_retry_failed_debits calls this same function, so a retry
--       can't charge it either.
--   (4) trg_ai_runs_billing: the 20261084 body with one condition — no
--       over-allowance AI debit for a meta_direct_billing workspace.
--   (5) trg_org_plan_meta_direct: a workspace moved onto a plan whose
--       features include 'meta_direct_billing' gets funding_model
--       'meta_direct' (self-serve purchase and a Super Admin's assignment
--       alike). Nothing else is touched.
--   (6) demo_leads: source 'landing_999' joins 'landing_start' in the
--       qualification exemption (a /999 buyer answers no /demo questions),
--       plus checkout_at / paid_at / payment_id for Admin → Leads
--       ("Checkout abandoned" = reached Pay, no paid_at after 30 minutes).
--
-- Without this file the code works as before: a flag that doesn't exist is
-- off (org_flag_enabled → false), so nobody is exempt; /999's checkout
-- answers "not available yet" because no 'basic' plan exists.

SET lock_timeout = '5s';

-- (1) ------------------------------------------------------------ flag rows
INSERT INTO public.feature_flags (key, name, description, default_enabled)
VALUES (
  'meta_direct_billing',
  'Pays Meta directly',
  'This workspace pays Meta for its messages on its own card: AiDwar never debits credits for messages, holds credits for campaigns or charges AI answers past the allowance.',
  false
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description;

INSERT INTO public.feature_registry (
  key, name, description, icon, nav_path, nav_order, nav_permission, flag_key, settings_path,
  permissions, analytics, activity_actions, usage_meters, ai_tools, data_tables, depends_on, synced_at
) VALUES (
  'meta_direct_billing', 'Pays Meta directly',
  'This workspace pays Meta for its messages on its own card: AiDwar never debits credits for messages, holds credits for campaigns or charges AI answers past the allowance.',
  'credit-card', null, null, null, 'meta_direct_billing', null,
  '[]'::jsonb,
  '{"event_types":[],"metrics":[],"dashboard_section":false}'::jsonb,
  '{}'::text[], '[]'::jsonb, '[]'::jsonb, '{}'::text[], array['billing']::text[], now()
)
ON CONFLICT (key) DO UPDATE SET
  name = excluded.name, description = excluded.description, flag_key = excluded.flag_key,
  depends_on = excluded.depends_on, synced_at = now();

-- (2) ------------------------------------------------------------- the plan
INSERT INTO public.plans (key, name, tagline, sort_order, is_active, is_public)
VALUES ('basic', 'Basic', 'Your AI salesperson on WhatsApp. Pay Meta directly — zero markup.', 5, true, false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.plan_versions (
  plan_id, version, price_monthly, price_annual, currency, limits, highlights, features, is_current
)
SELECT p.id, 1, 999, 9990, 'INR',
  '{"numbers": 1, "members": 2, "pages": 100, "ai_answers": 300, "ai_monthly_cap": 300}'::jsonb,
  array[
    '1 WhatsApp number',
    'Aiden replies to customers 24×7 (300 answers/month)',
    'Shared inbox',
    'Campaigns & templates',
    'Pay Meta directly — zero markup'
  ]::text[],
  array[
    'inbox', 'contacts', 'campaigns', 'templates', 'automations', 'analytics', 'settings',
    'team', 'compliance', 'ai_features', 'billing', 'cashfree_billing', 'meta_direct_billing'
  ]::text[],
  true
FROM public.plans p
WHERE p.key = 'basic'
  AND NOT EXISTS (SELECT 1 FROM public.plan_versions v WHERE v.plan_id = p.id);

-- (3) ------------------------------------------------- billing_debit_message
-- The 20261066 body (live md5 1960b0e87eb293f8e8ffcf747a19dbf9) + one line.
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
  -- Batch 80: the workspace pays Meta itself (Basic) — never debited for a message.
  if public.org_flag_enabled(m.organization_id, 'meta_direct_billing') then return false; end if;
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

-- (4) --------------------------------------------------- trg_ai_runs_billing
-- The 20261084 body + one condition (no over-allowance debit for Basic).
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
     and public.ai_run_is_customer_answer(new.task, new.conversation_id, new.metadata)
     and public.org_flag_enabled(new.organization_id, 'billing')
     -- Batch 80: the workspace pays Meta itself (Basic) — no AI overage debit.
     and not public.org_flag_enabled(new.organization_id, 'meta_direct_billing') then
    select billing_enabled_at into enabled_at from public.organizations where id = new.organization_id;
    if enabled_at is not null and new.created_at >= enabled_at then
      select count(*) into used from public.ai_runs
        where organization_id = new.organization_id and status = 'ok' and id <> new.id
          and public.ist_month(created_at) = m
          and public.ai_run_is_customer_answer(task, conversation_id, metadata);
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
  from (select count(*) filter (where public.ai_run_is_customer_answer(task, conversation_id, metadata)) answers, coalesce(sum(cost_amount),0) cost from public.ai_runs
        where organization_id = new.organization_id and status='ok' and public.ist_month(created_at) = m) s
  where a.organization_id = new.organization_id and a.month = m;
  return new;
end $function$;

REVOKE ALL ON FUNCTION public.trg_ai_runs_billing() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_ai_runs_billing() FROM anon;
REVOKE ALL ON FUNCTION public.trg_ai_runs_billing() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.trg_ai_runs_billing() TO service_role;

-- (5) ------------------------------------------- funding model follows Basic
CREATE OR REPLACE FUNCTION public.trg_org_plan_meta_direct()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.plan_version_id is not null
     and old.plan_version_id is distinct from new.plan_version_id
     and exists (
       select 1 from public.plan_versions pv
        where pv.id = new.plan_version_id and 'meta_direct_billing' = any(pv.features)
     ) then
    new.funding_model := 'meta_direct';
  end if;
  return new;
end $function$;

REVOKE ALL ON FUNCTION public.trg_org_plan_meta_direct() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_org_plan_meta_direct() FROM anon;
REVOKE ALL ON FUNCTION public.trg_org_plan_meta_direct() FROM authenticated;

DROP TRIGGER IF EXISTS trg_org_plan_meta_direct ON public.organizations;
CREATE TRIGGER trg_org_plan_meta_direct
  BEFORE UPDATE OF plan_version_id ON public.organizations
  FOR EACH ROW EXECUTE FUNCTION public.trg_org_plan_meta_direct();

-- (6) ----------------------------------------------------------- demo_leads
-- The Batch 72 rule, with 'landing_999' exempt like 'landing_start'.
ALTER TABLE public.demo_leads DROP CONSTRAINT IF EXISTS demo_leads_qualified_unless_landing_start;
ALTER TABLE public.demo_leads DROP CONSTRAINT IF EXISTS demo_leads_qualified_unless_landing;
ALTER TABLE public.demo_leads
  ADD CONSTRAINT demo_leads_qualified_unless_landing CHECK (
    source IN ('landing_start', 'landing_999')
    OR (
      business_type IS NOT NULL
      AND enquiry_band IS NOT NULL
      AND primary_need IS NOT NULL
      AND name IS NOT NULL
      AND business_name IS NOT NULL
    )
  );

ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS checkout_at timestamptz;
ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS paid_at timestamptz;
ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS payment_id uuid;

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
