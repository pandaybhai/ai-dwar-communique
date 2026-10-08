-- Batch 26a (NOT applied by the PR that adds it): the wallet never gives
-- messages away. Idempotent; safe to run twice.
--
--  C1  A campaign hold now refuses when the wallet can't cover it:
--        balance + overdraft - (held + amount) < 0  ->  INSUFFICIENT_CREDITS.
--      Before, a hold only raised `held` and never checked anything, so two
--      campaigns launched back to back both held and both sent.
--      billing_retry_failed_debits() retries the message debits that
--      trg_messages_billing swallowed into usage_records
--      (meter billing_debit_failed); the billing sweep calls it and alerts
--      the platform admins about what is still uncharged.
--  H3  An 'adjustment' is signed: -50 lowers the balance by 50 (it used to
--      add abs(amount)). Every other entry type is unchanged.
--  H4  A campaign message debit marked from_hold takes from `held` only what
--      that campaign's own hold still has (wallet_campaign_holds), so a
--      message priced after its campaign settled never eats another
--      campaign's reservation. A campaign hold_release is capped the same way.
--  M10 price_message no longer writes cost 0 for good when Meta's pricing
--      hasn't arrived yet (billable unknown, e.g. a read status landing before
--      delivered): an unknown message stays unpriced for an hour, then the
--      reprice job settles it as before.
--  --  campaigns.pause_reason: why the worker paused a campaign
--      ('insufficient_credits'), shown on the campaign and cleared on resume.
--
-- wallet_apply, price_message and reprice_unpriced_messages are given here
-- with their full new bodies; the previous bodies are in
-- 20261054_live_only_functions.sql and 20260831_message_cost_receipts.sql.
-- billing_debit_message / trg_messages_billing are NOT redefined (their live
-- bodies are being saved separately, item M17).

SET lock_timeout = '5s';

-- ------------------------------------------------------------ campaigns
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS pause_reason text;

-- ------------------------------------------------------------ H4: per-campaign holds
-- What each campaign's own reservation still has. Written only by
-- wallet_apply, always under the wallet_balances row lock of the same
-- workspace, so it can never race the wallet itself.
CREATE TABLE IF NOT EXISTS public.wallet_campaign_holds (
  campaign_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  remaining numeric(14,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.wallet_campaign_holds ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.wallet_campaign_holds FROM PUBLIC;
REVOKE ALL ON public.wallet_campaign_holds FROM anon;
REVOKE ALL ON public.wallet_campaign_holds FROM authenticated;
GRANT ALL ON public.wallet_campaign_holds TO service_role;

-- The row for one campaign, locked. A campaign that held before this
-- migration has no row yet: it is worked out once from the ledger (its holds,
-- minus its releases, minus what its from_hold debits took — rows written
-- before this migration took their full amount).
CREATE OR REPLACE FUNCTION public.wallet_campaign_hold_lock(p_org uuid, p_campaign uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v numeric; held_in numeric; released numeric; taken numeric;
begin
  select remaining into v from public.wallet_campaign_holds where campaign_id = p_campaign for update;
  if found then return v; end if;

  select coalesce(sum(abs(amount)) filter (where entry_type = 'hold' and reference_type = 'campaign'), 0),
         coalesce(sum(abs(amount)) filter (where entry_type = 'hold_release'), 0)
    into held_in, released
    from public.wallet_ledger
   where organization_id = p_org
     and reference_id = p_campaign
     and reference_type in ('campaign', 'campaign_duplicate_hold')
     and entry_type in ('hold', 'hold_release');

  select coalesce(sum(case when metadata ? 'held_taken' then (metadata->>'held_taken')::numeric
                           else abs(amount) end), 0)
    into taken
    from public.wallet_ledger
   where organization_id = p_org
     and entry_type = 'debit_message'
     and metadata->>'campaign_id' = p_campaign::text
     and metadata->>'from_hold' = 'true';

  insert into public.wallet_campaign_holds(campaign_id, organization_id, remaining)
  values (p_campaign, p_org, greatest(0, held_in - released - taken))
  on conflict (campaign_id) do nothing;
  select remaining into v from public.wallet_campaign_holds where campaign_id = p_campaign for update;
  return v;
end $function$;

REVOKE ALL ON FUNCTION public.wallet_campaign_hold_lock(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wallet_campaign_hold_lock(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.wallet_campaign_hold_lock(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_campaign_hold_lock(uuid, uuid) TO service_role;

-- ------------------------------------------------------------ wallet_apply (C1, H3, H4)
-- Full new body. Unchanged from 20261054 except where marked "26a".
CREATE OR REPLACE FUNCTION public.wallet_apply(p_org uuid, p_type text, p_amount numeric, p_ref_type text DEFAULT NULL::text, p_ref_id uuid DEFAULT NULL::uuid, p_description text DEFAULT NULL::text, p_metadata jsonb DEFAULT '{}'::jsonb, p_actor uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare b record; new_bal numeric; new_held numeric; od numeric; entry_id uuid;
  meta jsonb := coalesce(p_metadata, '{}'::jsonb);
  entry_amount numeric; own numeric; take numeric; v_campaign uuid;
begin
  insert into public.wallet_balances(organization_id) values (p_org) on conflict do nothing;
  select * into b from public.wallet_balances where organization_id = p_org for update;
  select coalesce(overdraft_limit,0) into od from public.organization_billing_settings where organization_id = p_org;
  od := coalesce(od,0);

  new_bal := b.balance; new_held := b.held;
  entry_amount := case when p_type in ('debit_message','debit_ai','debit_addon','expiry','hold') then -abs(p_amount) else abs(p_amount) end;
  case p_type
    when 'hold' then
      new_held := b.held + abs(p_amount);
      -- 26a C1: a reservation must fit what the wallet can still spend.
      if b.balance + od - new_held < 0 then
        raise exception 'INSUFFICIENT_CREDITS: hold % exceeds available % (balance %, held %, overdraft %)',
          abs(p_amount), b.balance + od - b.held, b.balance, b.held, od
          using errcode = 'P0001';
      end if;
      if p_ref_type = 'campaign' and p_ref_id is not null then
        own := public.wallet_campaign_hold_lock(p_org, p_ref_id);
        update public.wallet_campaign_holds set remaining = own + abs(p_amount), updated_at = now()
         where campaign_id = p_ref_id;
      end if;
    when 'hold_release' then
      take := abs(p_amount);
      -- 26a H4: a campaign gives back at most what its own hold still has.
      if p_ref_type in ('campaign','campaign_duplicate_hold') and p_ref_id is not null then
        own := public.wallet_campaign_hold_lock(p_org, p_ref_id);
        take := least(take, greatest(own, 0));
        update public.wallet_campaign_holds set remaining = own - take, updated_at = now()
         where campaign_id = p_ref_id;
        entry_amount := take;
        meta := meta || jsonb_build_object('requested', abs(p_amount));
      end if;
      new_held := greatest(0, b.held - take);
    when 'debit_message','debit_ai','debit_addon','expiry' then
      new_bal := b.balance - abs(p_amount);
      if meta ? 'from_hold' and (meta->>'from_hold')::boolean then
        -- 26a H4: only from this campaign's own hold, while it lasts.
        take := 0;
        v_campaign := case when coalesce(meta->>'campaign_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                           then (meta->>'campaign_id')::uuid end;
        if v_campaign is not null then
          own := public.wallet_campaign_hold_lock(p_org, v_campaign);
          take := least(abs(p_amount), greatest(own, 0));
          update public.wallet_campaign_holds set remaining = own - take, updated_at = now()
           where campaign_id = v_campaign;
        end if;
        new_held := greatest(0, b.held - take);
        meta := meta || jsonb_build_object('held_taken', take);
      end if;
    when 'adjustment' then
      -- 26a H3: an adjustment is signed (a negative one lowers the balance).
      new_bal := b.balance + p_amount;
      entry_amount := p_amount;
    else new_bal := b.balance + abs(p_amount);
  end case;

  if new_bal < -od then
    raise exception 'INSUFFICIENT_CREDITS: balance % would fall below overdraft limit %', new_bal, -od
      using errcode = 'P0001';
  end if;

  insert into public.wallet_ledger(organization_id, entry_type, amount, balance_after, held_after, currency,
    reference_type, reference_id, description, metadata, created_by)
  values (p_org, p_type, entry_amount,
    new_bal, new_held, b.currency, p_ref_type, p_ref_id, p_description, meta, p_actor)
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

-- The server asks this before a negative adjustment, so a negative amount is
-- never sent to a wallet_apply that would still add it (H3).
CREATE OR REPLACE FUNCTION public.wallet_apply_version()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ select 2 $function$;

REVOKE ALL ON FUNCTION public.wallet_apply_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.wallet_apply_version() FROM anon;
REVOKE ALL ON FUNCTION public.wallet_apply_version() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.wallet_apply_version() TO service_role;

-- ------------------------------------------------------------ C1: debits that failed
-- trg_messages_billing catches a failed billing_debit_message into
-- usage_records (meter billing_debit_failed, metadata.message_id). This
-- retries them, oldest first. billing_debit_message is idempotent per
-- message, so a retry never charges twice. A row is closed
-- (metadata.resolved_at) once the debit is in the ledger or there is nothing
-- to charge; otherwise attempts / last_error / last_attempt_at are kept and
-- the next sweep tries again (e.g. after the workspace adds credits).
CREATE INDEX IF NOT EXISTS usage_records_debit_failed_open_idx
  ON public.usage_records (occurred_at)
  WHERE meter_key = 'billing_debit_failed' AND NOT (metadata ? 'resolved_at');

CREATE OR REPLACE FUNCTION public.billing_retry_failed_debits(p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; v_msg uuid; charged boolean; n_retried int := 0; n_charged int := 0;
  n_closed int := 0; n_failing int := 0; failing jsonb := '[]'::jsonb;
begin
  for r in
    select id, organization_id, metadata, occurred_at from public.usage_records
     where meter_key = 'billing_debit_failed' and not (metadata ? 'resolved_at')
     order by occurred_at
     limit greatest(1, least(coalesce(p_limit, 200), 1000))
     for update skip locked
  loop
    n_retried := n_retried + 1;
    v_msg := case when coalesce(r.metadata->>'message_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (r.metadata->>'message_id')::uuid end;
    if v_msg is null then
      update public.usage_records
         set metadata = metadata || jsonb_build_object('resolved_at', now(), 'resolution', 'no_message')
       where id = r.id;
      n_closed := n_closed + 1;
      continue;
    end if;
    begin
      charged := public.billing_debit_message(v_msg);
      update public.usage_records
         set metadata = metadata || jsonb_build_object(
               'resolved_at', now(),
               'resolution', case when charged then 'charged' else 'nothing_to_charge' end,
               'attempts', coalesce((metadata->>'attempts')::int, 0) + 1)
       where id = r.id;
      if charged then n_charged := n_charged + 1; else n_closed := n_closed + 1; end if;
    exception when others then
      update public.usage_records
         set metadata = metadata || jsonb_build_object(
               'attempts', coalesce((metadata->>'attempts')::int, 0) + 1,
               'last_error', left(sqlerrm, 300),
               'last_attempt_at', now())
       where id = r.id;
      n_failing := n_failing + 1;
      failing := failing || jsonb_build_object(
        'organization_id', r.organization_id, 'message_id', v_msg,
        'since', r.occurred_at, 'error', left(sqlerrm, 120));
    end;
  end loop;
  return jsonb_build_object('retried', n_retried, 'charged', n_charged, 'closed', n_closed,
    'failing', n_failing, 'failing_rows', failing);
end $function$;

REVOKE ALL ON FUNCTION public.billing_retry_failed_debits(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_retry_failed_debits(integer) FROM anon;
REVOKE ALL ON FUNCTION public.billing_retry_failed_debits(integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.billing_retry_failed_debits(integer) TO service_role;

-- ------------------------------------------------------------ M10: unknown pricing
-- Full new body. Unchanged from 20260831 except where marked "26a".
CREATE OR REPLACE FUNCTION public.price_message(p_message_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  m record;
  phone text;
  found record;
BEGIN
  SELECT id, conversation_id, billable, pricing_category, status, created_at, cost_amount
    INTO m
  FROM public.messages WHERE id = p_message_id;

  IF m.id IS NULL THEN RETURN false; END IF;

  -- 26a M10: Meta hasn't said yet whether this message is billable (its
  -- pricing comes with sent/delivered; a read can land first). Leave it
  -- unpriced for an hour so the pricing can still arrive; after that the
  -- reprice job settles it as free, exactly as before.
  IF m.billable IS NULL AND m.created_at > now() - interval '1 hour' THEN
    RETURN true;
  END IF;

  -- Only billable, actually-delivered messages cost anything. A utility message
  -- inside an open service window is free, and Meta says so on the webhook.
  IF COALESCE(m.billable, false) = false THEN
    UPDATE public.messages SET cost_amount = 0, cost_currency = COALESCE(cost_currency, 'INR')
    WHERE id = m.id AND cost_amount IS DISTINCT FROM 0;
    RETURN true;
  END IF;

  IF m.status NOT IN ('delivered','read') THEN RETURN true; END IF;

  SELECT c2.phone INTO phone
  FROM public.conversations cv
  JOIN public.contacts c2 ON c2.id = cv.contact_id
  WHERE cv.id = m.conversation_id;

  SELECT * INTO found FROM public.message_rate_for(phone, m.pricing_category, m.created_at);

  IF found.rate IS NULL THEN
    RETURN false;
  END IF;

  UPDATE public.messages
  SET cost_amount = found.rate, cost_currency = found.currency
  WHERE id = m.id;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.price_message(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.price_message(uuid) TO service_role;

-- Full new body. Unchanged from 20261054 except the 26a line: a message whose
-- pricing is still unknown is picked up once its hour is over (not before, so
-- it never fills the 500-row window run after run).
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
      and (billable is not null or created_at < now() - interval '1 hour') -- 26a M10
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

RESET lock_timeout;
