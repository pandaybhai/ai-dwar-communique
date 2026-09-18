-- Silent gaps: a customer question the answer couldn't fully cover is filed
-- under Unanswered without messaging the owner. Only notify='ping' rows ever
-- reach the owner's phone, and nothing in the answering path sets that.
alter table public.pending_owner_replies
  add column if not exists notify text not null default 'silent';

-- When Aiden last told the owner, in their own test chat, that something was
-- noted under Unanswered. Throttled to once every ten minutes per session.
alter table public.onboarding_sessions
  add column if not exists last_gap_note_at timestamptz;
