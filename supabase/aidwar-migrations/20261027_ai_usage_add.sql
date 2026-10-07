-- Batch 18 (NOT applied): AI usage counters added in the database.
--
-- meterAiUsage and rollUpUsage (ai-run.server.ts) read the day's row, added
-- in JS and wrote the sum back, so two workers metering at once lost one of
-- the two additions and the AI caps (billed_amount) under-counted. ai_usage_add() adds in one
-- statement (insert, or add to the existing row on its unique key
-- organization_id + usage_date + task), so nothing is lost.
--
-- The code works without this file: until it is applied both fall back to
-- what they did before (looked for again every 10 minutes, so applying it
-- needs no deploy). Sorts after Batch 16's 20261023-20261025 migrations.
--
-- Idempotent. Service role only.

create or replace function public.ai_usage_add(
  p_org uuid,
  p_usage_date date,
  p_task text,
  p_runs integer default 1,
  p_input_tokens bigint default 0,
  p_output_tokens bigint default 0,
  p_cost_amount numeric default 0,
  p_billed_amount numeric default 0,
  p_currency text default 'INR'
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ai_usage as u
    (organization_id, usage_date, task, runs, input_tokens, output_tokens,
     cost_amount, billed_amount, currency, updated_at)
  values
    (p_org, p_usage_date, p_task, coalesce(p_runs, 0), coalesce(p_input_tokens, 0),
     coalesce(p_output_tokens, 0), coalesce(p_cost_amount, 0), coalesce(p_billed_amount, 0),
     coalesce(p_currency, 'INR'), now())
  on conflict (organization_id, usage_date, task) do update
    set runs = u.runs + excluded.runs,
        input_tokens = u.input_tokens + excluded.input_tokens,
        output_tokens = u.output_tokens + excluded.output_tokens,
        cost_amount = u.cost_amount + excluded.cost_amount,
        billed_amount = u.billed_amount + excluded.billed_amount,
        updated_at = now();
$$;

revoke all on function public.ai_usage_add(uuid, date, text, integer, bigint, bigint, numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.ai_usage_add(uuid, date, text, integer, bigint, bigint, numeric, numeric, text) to service_role;
