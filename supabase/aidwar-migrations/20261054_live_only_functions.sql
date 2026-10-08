-- Batch 20 item 7 (NOT applied): the seven functions that existed only on the
-- live database, saved exactly as it runs them — pg_get_functiondef output
-- and EXECUTE grants pulled read-only on 7 Oct 2026 12:25 UTC (PR #32).
-- Definitions are byte-for-byte as pasted; only the closing semicolons and
-- the REVOKE/GRANT lines (which restate the live grants) are added.
-- Idempotent: CREATE OR REPLACE of an identical definition and re-stating
-- the same grants change nothing on the live database.
--
-- Live grants (owner postgres):
--   ai_answers_allowance, client_rate_for  -> authenticated, service_role
--   firecrawl_try_spend, meta_balance_estimate, next_invoice_number,
--   wallet_apply, reprice_unpriced_messages -> service_role only
-- The first two are SECURITY DEFINER and executable by any signed-in user for
-- any p_org; 20261055_revoke_billing_reads.sql removes that, on its own.
--
-- Depends on (already live): organization_billing_settings, organizations,
-- plan_versions, message_rates, rate_cards, platform_settings
-- (firecrawl_monthly_credit_cap, firecrawl_workspace_monthly_cap),
-- firecrawl_usage, meta_prepaid_ledger, invoice_sequences, billing_fy(date),
-- wallet_balances, wallet_ledger, messages, price_message(uuid).

SET lock_timeout = '5s';

-- ai_answers_allowance: live grants postgres, authenticated, service_role
CREATE OR REPLACE FUNCTION public.ai_answers_allowance(p_org uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    (select ai_answers_included_override from public.organization_billing_settings where organization_id = p_org),
    (select (pv.limits->>'ai_answers')::int from public.organizations o join public.plan_versions pv on pv.id = o.plan_version_id where o.id = p_org),
    0);
$function$;

REVOKE ALL ON FUNCTION public.ai_answers_allowance(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_answers_allowance(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.ai_answers_allowance(uuid) TO authenticated, service_role;

-- client_rate_for: live grants postgres, authenticated, service_role
CREATE OR REPLACE FUNCTION public.client_rate_for(p_org uuid, p_country text, p_category text, p_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(rate numeric, currency text, meta_rate numeric, mode text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare rc record; mr record;
begin
  select r.rate, r.currency into mr
  from public.message_rates r
  where r.country_code = coalesce(p_country,'IN') and r.category = p_category
    and r.effective_from <= p_at::date and (r.effective_to is null or r.effective_to >= p_at::date)
  order by r.effective_from desc limit 1;

  select * into rc from public.rate_cards c
  where (c.organization_id = p_org or c.organization_id is null)
    and c.country_code = coalesce(p_country,'IN') and c.category = p_category
    and c.effective_from <= p_at::date and (c.effective_to is null or c.effective_to >= p_at::date)
  order by (c.organization_id is not null) desc, c.effective_from desc limit 1;

  if rc.id is null then
    return query select round(mr.rate, 2), mr.currency, mr.rate, 'passthrough'::text; return;
  end if;
  if rc.mode = 'fixed' then
    return query select round(rc.fixed_rate, 2), rc.currency, mr.rate, 'fixed'::text;
  else
    -- client-facing rates are always 2 decimals so estimate, rate card and debit agree
    return query select round(coalesce(mr.rate,0) * (1 + rc.markup_percent/100.0), 2), coalesce(mr.currency, rc.currency), mr.rate, 'markup'::text;
  end if;
end $function$;

REVOKE ALL ON FUNCTION public.client_rate_for(uuid, text, text, timestamp with time zone) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.client_rate_for(uuid, text, text, timestamp with time zone) FROM anon;
GRANT EXECUTE ON FUNCTION public.client_rate_for(uuid, text, text, timestamp with time zone) TO authenticated, service_role;

-- firecrawl_try_spend: live grants postgres, service_role
CREATE OR REPLACE FUNCTION public.firecrawl_try_spend(_org uuid, _credits integer)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  _month date := date_trunc('month', now())::date;
  _platform_cap integer; _org_cap integer; _platform_used integer; _org_used integer;
BEGIN
  SELECT firecrawl_monthly_credit_cap, firecrawl_workspace_monthly_cap INTO _platform_cap, _org_cap FROM platform_settings LIMIT 1;
  PERFORM pg_advisory_xact_lock(hashtext('firecrawl_spend'));
  SELECT COALESCE(SUM(credits), 0) INTO _platform_used FROM firecrawl_usage WHERE month = _month;
  SELECT credits INTO _org_used FROM firecrawl_usage WHERE organization_id = _org AND month = _month;
  _org_used := COALESCE(_org_used, 0);
  IF (_platform_cap IS NOT NULL AND _platform_used + _credits > _platform_cap)
     OR (_org_cap IS NOT NULL AND _org_used + _credits > _org_cap) THEN
    INSERT INTO firecrawl_usage (organization_id, month, refused) VALUES (_org, _month, 1)
      ON CONFLICT (organization_id, month) DO UPDATE SET refused = firecrawl_usage.refused + 1, updated_at = now();
    RETURN false;
  END IF;
  INSERT INTO firecrawl_usage (organization_id, month, credits, calls) VALUES (_org, _month, _credits, 1)
    ON CONFLICT (organization_id, month) DO UPDATE
      SET credits = firecrawl_usage.credits + _credits, calls = firecrawl_usage.calls + 1, updated_at = now();
  RETURN true;
END; $function$;

REVOKE ALL ON FUNCTION public.firecrawl_try_spend(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.firecrawl_try_spend(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.firecrawl_try_spend(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.firecrawl_try_spend(uuid, integer) TO service_role;

-- meta_balance_estimate: live grants postgres, service_role
CREATE OR REPLACE FUNCTION public.meta_balance_estimate(p_org uuid)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select balance_after from public.meta_prepaid_ledger where organization_id = p_org order by created_at desc limit 1), 0);
$function$;

REVOKE ALL ON FUNCTION public.meta_balance_estimate(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.meta_balance_estimate(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.meta_balance_estimate(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.meta_balance_estimate(uuid) TO service_role;

-- next_invoice_number: live grants postgres, service_role
CREATE OR REPLACE FUNCTION public.next_invoice_number(p_series text DEFAULT 'AD'::text, p_date date DEFAULT CURRENT_DATE)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_fy text := public.billing_fy(p_date); n int;
begin
  insert into public.invoice_sequences(series, fy) values (p_series, v_fy) on conflict do nothing;
  update public.invoice_sequences s set last_number = s.last_number + 1 where s.series = p_series and s.fy = v_fy returning s.last_number into n;
  return p_series || '/' || v_fy || '/' || lpad(n::text, 5, '0');
end $function$;

REVOKE ALL ON FUNCTION public.next_invoice_number(text, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.next_invoice_number(text, date) FROM anon;
REVOKE ALL ON FUNCTION public.next_invoice_number(text, date) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.next_invoice_number(text, date) TO service_role;

-- wallet_apply: live grants postgres, service_role
CREATE OR REPLACE FUNCTION public.wallet_apply(p_org uuid, p_type text, p_amount numeric, p_ref_type text DEFAULT NULL::text, p_ref_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_actor uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b record; new_bal numeric; new_held numeric; od numeric; entry_id uuid;
begin
  insert into public.wallet_balances(organization_id) values (p_org) on conflict do nothing;
  select * into b from public.wallet_balances where organization_id = p_org for update;
  select coalesce(overdraft_limit,0) into od from public.organization_billing_settings where organization_id = p_org;
  od := coalesce(od,0);

  new_bal := b.balance; new_held := b.held;
  case p_type
    when 'hold' then new_held := b.held + abs(p_amount);
    when 'hold_release' then new_held := greatest(0, b.held - abs(p_amount));
    when 'debit_message','debit_ai','debit_addon','expiry' then
      new_bal := b.balance - abs(p_amount);
      if p_metadata ? 'from_hold' and (p_metadata->>'from_hold')::boolean then new_held := greatest(0, b.held - abs(p_amount)); end if;
    else new_bal := b.balance + abs(p_amount);
  end case;

  if new_bal < -od then
    raise exception 'INSUFFICIENT_CREDITS: balance % would fall below overdraft limit %', new_bal, -od
      using errcode = 'P0001';
  end if;

  insert into public.wallet_ledger(organization_id, entry_type, amount, balance_after, held_after, currency,
    reference_type, reference_id, description, metadata, created_by)
  values (p_org, p_type,
    case when p_type in ('debit_message','debit_ai','debit_addon','expiry','hold') then -abs(p_amount) else abs(p_amount) end,
    new_bal, new_held, b.currency, p_ref_type, p_ref_id, p_description, p_metadata, p_actor)
  returning id into entry_id;

  update public.wallet_balances set
    balance = new_bal, held = new_held, updated_at = now(),
    lifetime_purchased = lifetime_purchased + case when p_type in ('credit_purchase','bonus_credits','starter_credits','coupon_credits') then abs(p_amount) else 0 end,
    lifetime_consumed  = lifetime_consumed  + case when p_type in ('debit_message','debit_ai','debit_addon') then abs(p_amount) else 0 end
  where organization_id = p_org;
  return entry_id;
end $function$;

REVOKE ALL ON FUNCTION public.wallet_apply(uuid, text, numeric, text, uuid, text, jsonb, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wallet_apply(uuid, text, numeric, text, uuid, text, jsonb, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.wallet_apply(uuid, text, numeric, text, uuid, text, jsonb, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_apply(uuid, text, numeric, text, uuid, text, jsonb, uuid) TO service_role;

-- reprice_unpriced_messages: live grants postgres, service_role
-- (pasted separately on PR #32; 609 chars, md5 dc8fbb7ebc27d7e5432b06d7dcad74cf
-- as live. Calls public.price_message(uuid), 20260831_message_cost_receipts.sql.)
CREATE OR REPLACE FUNCTION public.reprice_unpriced_messages(p_older_than interval DEFAULT '00:10:00'::interval)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int := 0; r record;
begin
  for r in select id from public.messages
    where direction='outbound' and status in ('delivered','read') and cost_amount is null and billable is not false
      and created_at < now() - p_older_than and created_at > now() - interval '30 days'
    limit 500
  loop
    if public.price_message(r.id) then n := n + 1; end if;
  end loop;
  return n;
end $function$;

REVOKE ALL ON FUNCTION public.reprice_unpriced_messages(interval) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reprice_unpriced_messages(interval) FROM anon;
REVOKE ALL ON FUNCTION public.reprice_unpriced_messages(interval) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reprice_unpriced_messages(interval) TO service_role;
