-- Test-only: the conversations columns the load-test schema leaves out, as on
-- live (20260813 phase2: assigned_to, last_customer_message_at,
-- unread_count), for batch38-sql.test.ts on the throwaway local Postgres.
-- Never applied anywhere else.
alter table public.conversations add column if not exists assigned_to uuid;
alter table public.conversations add column if not exists last_customer_message_at timestamptz;
alter table public.conversations add column if not exists unread_count int not null default 0;
insert into public.feature_registry (key, name, description, icon, flag_key, activity_actions)
values ('inbox', 'Inbox', 'Inbox', 'inbox', 'inbox', array['conversation_assigned', 'conversation_closed'])
on conflict (key) do nothing;
