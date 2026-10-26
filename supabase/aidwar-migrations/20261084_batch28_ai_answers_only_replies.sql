-- Batch 28 item 11 (NOT applied; apply by hand to the Mumbai project
-- hcsacmqzspnfqoftoifu): the AI-answer allowance counts only replies Aiden
-- wrote to customers. Idempotent; safe to run twice.
--
-- Found (8 Oct 2026): trg_ai_runs_billing counted EVERY ai_runs row with
-- status 'ok' as an answer. One workspace showed 863 answers this month, 799
-- of them website reading (extract_facts); another had 272 over_answers that
-- were all extract_facts. Inbox "Draft a reply" (suggest_reply), "Catch me
-- up" (summarise), Try me / comparisons (agent_reply with no conversation)
-- and the owner's onboarding chat counted too. The Billing page's "AI answers
-- used" and the over-allowance debit_ai read that count, so a merchant could
-- be charged for answers no customer ever got.
--
-- An answer is now (public.ai_run_is_customer_answer, below):
--   task = 'agent_reply'                 Aiden's reply (agentAnswer)
--   and conversation_id is not null      in a real chat, not Try me / tests
--   and metadata->>'purpose' is null     not background work done inside a
--                                        chat: describeImage writes
--                                        agent_reply + conversation_id with
--                                        purpose 'customer_image' for every
--                                        customer photo
--   and metadata->>'channel' is not 'onboarding'
--                                        not the owner's own setup chat
--                                        (merchantAnswer: agent_reply with a
--                                        platform-org conversation_id)
-- The app says the same in src/lib/ai-answers.ts (onlyCustomerAnswers /
-- isCustomerAnswer). Keep the two in step.
--
-- Draft mode: an Aiden draft is written as task 'suggest_reply' (suggestReply,
-- the same as the inbox's "Draft a reply"), so it no longer counts when it is
-- written. Counting it when a person SENDS it is not done here: the send
-- carries no link to the draft's ai_runs row today (see the PR notes).
--
-- Changed:
--   trg_ai_runs_billing()          body from 20261066_live_only_billing.sql
--                                  (live md5 5b3edd37602e6e3f10d9fe0280b68c60),
--                                  byte-identical except the three lines that
--                                  add ai_run_is_customer_answer: the debit
--                                  only for an answer, the month's "used"
--                                  count, and ai_usage_months.answers (hence
--                                  over_answers). provider_cost still sums
--                                  every ok run: that money was really spent.
--   billing_debit_ai_run(uuid)     body from 20261065_batch26a_wallet.sql
--                                  (its only definition), byte-identical
--                                  except: reads task, conversation_id,
--                                  metadata; returns false (nothing to charge)
--                                  for a run that isn't an answer; "used"
--                                  counts answers only. A billing_debit_failed
--                                  row for background work is then closed by
--                                  billing_retry_failed_debits as
--                                  'nothing_to_charge', never charged.
--   ai_usage_months                answers / over_answers for the current IST
--                                  month recomputed once (back-fill below).
-- Not changed: wallet_ledger, wallet_balances, ai_usage_months.billed_amount
-- and provider_cost. debit_ai entries already taken for background work stay
-- in the ledger; refunding them is a separate, explicit decision.

SET lock_timeout = '5s';

-- ------------------------------------------------------------ the rule
CREATE OR REPLACE FUNCTION public.ai_run_is_customer_answer(p_task text, p_conversation_id uuid, p_metadata jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select coalesce(
    p_task = 'agent_reply'
    and p_conversation_id is not null
    and p_metadata->>'purpose' is null
    and coalesce(p_metadata->>'channel', '') <> 'onboarding',
    false)
$function$;

REVOKE ALL ON FUNCTION public.ai_run_is_customer_answer(text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ai_run_is_customer_answer(text, uuid, jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.ai_run_is_customer_answer(text, uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.ai_run_is_customer_answer(text, uuid, jsonb) TO service_role;

-- ------------------------------------------------------------ trg_ai_runs_billing
-- The 20261066 body with ai_run_is_customer_answer added (three lines).
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
     and public.org_flag_enabled(new.organization_id, 'billing') then
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

-- ------------------------------------------------------------ billing_debit_ai_run
-- The 20261065 body with ai_run_is_customer_answer added (three lines).
CREATE OR REPLACE FUNCTION public.billing_debit_ai_run(p_ai_run_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r record; enabled_at timestamptz; used int; allowance int; m date;
begin
  select id, organization_id, status, billed_amount, cost_amount, created_at, task, conversation_id, metadata
    into r from public.ai_runs where id = p_ai_run_id;
  if r.id is null or r.status <> 'ok' or coalesce(r.billed_amount, 0) <= 0 then return false; end if;
  if not public.ai_run_is_customer_answer(r.task, r.conversation_id, r.metadata) then return false; end if;
  if exists(select 1 from public.wallet_ledger
             where reference_type = 'ai_run' and reference_id = r.id and entry_type = 'debit_ai') then
    return false;
  end if;
  if not public.org_flag_enabled(r.organization_id, 'billing') then return false; end if;
  select billing_enabled_at into enabled_at from public.organizations where id = r.organization_id;
  if enabled_at is null or r.created_at < enabled_at then return false; end if;

  m := public.ist_month(r.created_at);
  select a.allowance into allowance from public.ai_usage_months a
   where a.organization_id = r.organization_id and a.month = m;
  select count(*) into used from public.ai_runs
   where organization_id = r.organization_id and status = 'ok' and id <> r.id
     and public.ist_month(created_at) = m and created_at < r.created_at
     and public.ai_run_is_customer_answer(task, conversation_id, metadata);

  perform public.wallet_apply(r.organization_id, 'debit_ai', r.billed_amount, 'ai_run', r.id, 'AI answer (over allowance)',
    jsonb_build_object('provider_cost', r.cost_amount, 'used_this_month', used + 1, 'allowance', allowance, 'retried', true));

  update public.ai_usage_months a set
    billed_amount = coalesce((select sum(-l.amount) from public.wallet_ledger l join public.ai_runs x on x.id = l.reference_id
                              where l.entry_type = 'debit_ai' and l.reference_type = 'ai_run' and x.organization_id = a.organization_id
                                and public.ist_month(x.created_at) = a.month), 0),
    updated_at = now()
  where a.organization_id = r.organization_id and a.month = m;
  return true;
end $function$;

REVOKE ALL ON FUNCTION public.billing_debit_ai_run(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.billing_debit_ai_run(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.billing_debit_ai_run(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.billing_debit_ai_run(uuid) TO service_role;

-- ------------------------------------------------------------ back-fill
-- The current IST month only (public.ist_month, the trigger's own month key):
-- answers recounted with the rule above, over_answers = greatest(answers -
-- allowance, 0) exactly as the trigger writes it, from the row's own stored
-- allowance. Touches ai_usage_months only, and only rows whose numbers
-- change; a re-run changes nothing. Earlier months keep what they recorded.
WITH fresh AS (
  SELECT a.organization_id, a.month,
         (SELECT count(*) FROM public.ai_runs r
           WHERE r.organization_id = a.organization_id AND r.status = 'ok'
             AND public.ist_month(r.created_at) = a.month
             AND public.ai_run_is_customer_answer(r.task, r.conversation_id, r.metadata))::int AS answers
    FROM public.ai_usage_months a
   WHERE a.month = public.ist_month(now())
)
UPDATE public.ai_usage_months a SET
  answers = f.answers,
  over_answers = greatest(f.answers - a.allowance, 0),
  updated_at = now()
FROM fresh f
WHERE a.organization_id = f.organization_id AND a.month = f.month
  AND (a.answers IS DISTINCT FROM f.answers
       OR a.over_answers IS DISTINCT FROM greatest(f.answers - a.allowance, 0));

RESET lock_timeout;
