-- Batch 12: send at scale. Idempotent. NOT applied by the PR that adds it.
--
-- Batch 28 correction: this used to say "the code works without this file
-- (it falls back to what it did before)". It did not: on live (applied by
-- hand 8 Oct 12:36) every campaign status failed on (2) and every campaign
-- settle on (1). Since Batch 28 the code really works without it — (1) falls
-- back to summing the debit rows (campaignLedgerCharge, PGRST202), and a
-- failing (2) no longer stops a status: the message is moved, priced and its
-- event emitted; only the counter waits for a retry. Tested in
-- src/lib/batch28-campaigns.test.ts. The file is cheaper with it:
--   1. campaign_ledger_charge(): a campaign's charged total summed in the
--      database (one row back) instead of paging through every debit row.
--   2. campaign_recipient_status(): a status webhook's recipient move and
--      counter bump in one round trip, one row lock, no double count.
--   3. Two exact duplicate indexes on messages dropped: every message insert
--      maintained each of them twice.

-- 1 ---------------------------------------------------------------------
create index if not exists wallet_ledger_campaign_debits_idx
  on public.wallet_ledger (organization_id, ((metadata ->> 'campaign_id')))
  where entry_type = 'debit_message';

create or replace function public.campaign_ledger_charge(p_org uuid, p_campaign_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(abs(amount)), 0)::numeric
    from public.wallet_ledger
   where organization_id = p_org
     and entry_type = 'debit_message'
     and metadata ->> 'campaign_id' = p_campaign_id::text;
$$;

revoke all on function public.campaign_ledger_charge(uuid, uuid) from public;
grant execute on function public.campaign_ledger_charge(uuid, uuid) to service_role;

-- 2 ---------------------------------------------------------------------
-- Locks exactly one recipient row, then (only when something changed) the
-- campaign row: recipient before campaign, like every other writer, and no
-- writer holds a campaign row while waiting for a recipient, so this can't
-- take part in a deadlock. Returns 'applied', 'noop' or 'none'.
create or replace function public.campaign_recipient_status(
  p_message_id uuid,
  p_recipient_id uuid,
  p_status text,
  p_error text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_campaign uuid;
  v_prev text;
  v_message uuid;
begin
  if p_recipient_id is not null then
    select id, campaign_id, status into v_id, v_campaign, v_prev
      from public.campaign_recipients where id = p_recipient_id for update;
    v_message := p_message_id;
  else
    select id, campaign_id, status into v_id, v_campaign, v_prev
      from public.campaign_recipients where message_id = p_message_id limit 1 for update;
    v_message := null;
  end if;
  if v_id is null then return 'none'; end if;

  if p_status = 'failed' then
    if v_prev = 'failed' then return 'noop'; end if;
    update public.campaign_recipients
       set status = 'failed',
           error = left(coalesce(p_error, 'Delivery failed'), 300),
           message_id = coalesce(v_message, message_id)
     where id = v_id;
    update public.campaigns set failed_count = failed_count + 1, updated_at = now() where id = v_campaign;
    return 'applied';
  end if;

  if p_status = 'sent' then
    if v_prev not in ('queued', 'sending', 'skipped') then return 'noop'; end if;
    update public.campaign_recipients
       set status = 'sent', message_id = coalesce(v_message, message_id)
     where id = v_id;
    return 'applied';
  end if;

  if p_status = 'delivered' then
    if v_prev not in ('queued', 'sending', 'sent', 'skipped') then return 'noop'; end if;
    update public.campaign_recipients
       set status = 'delivered', message_id = coalesce(v_message, message_id)
     where id = v_id;
    update public.campaigns set delivered_count = delivered_count + 1, updated_at = now() where id = v_campaign;
    return 'applied';
  end if;

  if p_status = 'read' then
    if v_prev in ('queued', 'sending', 'sent', 'skipped') then
      update public.campaign_recipients
         set status = 'read', message_id = coalesce(v_message, message_id)
       where id = v_id;
      -- Read without a delivered first: it was delivered too.
      update public.campaigns
         set read_count = read_count + 1, delivered_count = delivered_count + 1, updated_at = now()
       where id = v_campaign;
      return 'applied';
    elsif v_prev = 'delivered' then
      update public.campaign_recipients
         set status = 'read', message_id = coalesce(v_message, message_id)
       where id = v_id;
      update public.campaigns set read_count = read_count + 1, updated_at = now() where id = v_campaign;
      return 'applied';
    end if;
    return 'noop';
  end if;

  return 'noop';
end;
$$;

revoke all on function public.campaign_recipient_status(uuid, uuid, text, text) from public;
grant execute on function public.campaign_recipient_status(uuid, uuid, text, text) to service_role;

-- 3 ---------------------------------------------------------------------
-- messages_meta_id_idx duplicates the unique messages_meta_message_id_key;
-- messages_cost_idx duplicates messages_outbound_created_idx.
-- Each is dropped only while its twin exists.
do $$
begin
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'messages_meta_message_id_key') then
    drop index if exists public.messages_meta_id_idx;
  end if;
  if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'messages_outbound_created_idx') then
    drop index if exists public.messages_cost_idx;
  end if;
end $$;
