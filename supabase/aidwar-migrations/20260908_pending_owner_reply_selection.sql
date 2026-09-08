-- Which pending question the owner picked from the list, so their next plain
-- message is filed against the right business.
alter table public.pending_owner_replies
  add column if not exists selected_at timestamptz;
