-- Where a run came from (e.g. the owner's onboarding chat), so an onboarding
-- answer can be told apart from a customer answer without a new table.
alter table public.ai_runs
  add column if not exists metadata jsonb not null default '{}'::jsonb;
