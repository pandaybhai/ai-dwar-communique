-- Teaching loop guards: remember what we suggested, when we asked, and whether
-- we have already nudged about a question still waiting for an answer.
alter table public.onboarding_sessions
  add column if not exists pending_asked_at timestamptz,
  add column if not exists suggested_questions jsonb not null default '[]'::jsonb;

alter table public.pending_owner_replies
  add column if not exists reminded_at timestamptz;
