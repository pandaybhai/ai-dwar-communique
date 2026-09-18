-- Remember when we last nudged an owner, so a code reminder can only go once.
alter table public.onboarding_sessions
  add column if not exists last_nudge_at timestamptz;
