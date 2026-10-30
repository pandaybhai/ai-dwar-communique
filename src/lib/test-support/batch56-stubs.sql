-- Test-only: what batch56-sql.test.ts needs on top of the Batch 52 stubs, for
-- the throwaway local Postgres. Never applied anywhere else.
--  - messages read by members under RLS (the Inbox's Realtime table),
--  - storage.objects / storage.buckets readable by members (a private bucket's
--    files, as Storage lists and downloads them under RLS),
--  - Supabase Realtime's realtime.messages (private Broadcast / Presence),
--  - a SECURITY DEFINER function members may call through /rpc.
alter table public.messages enable row level security;
drop policy if exists member_all on public.messages;
create policy member_all on public.messages for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
grant select, insert, update, delete on public.messages to authenticated;

alter table storage.buckets enable row level security;
drop policy if exists member_read on storage.buckets;
create policy member_read on storage.buckets for select to authenticated using (true);
grant usage on schema storage to anon, authenticated, service_role;
grant select on storage.buckets to authenticated;
drop policy if exists member_files on storage.objects;
create policy member_files on storage.objects for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
grant select, insert, update, delete on storage.objects to authenticated;

create schema if not exists realtime;
grant usage on schema realtime to anon, authenticated, service_role;
create table if not exists realtime.messages (
  id bigserial primary key,
  topic text not null,
  extension text not null default 'broadcast',
  payload jsonb,
  private boolean default true,
  inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
drop policy if exists member_channels on realtime.messages;
create policy member_channels on realtime.messages for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null);
grant select, insert on realtime.messages to authenticated;
grant usage on sequence realtime.messages_id_seq to authenticated;

create or replace function public.member_contact_count(p_org uuid) returns bigint
language sql stable security definer set search_path = public as $$
  select count(*) from public.contacts where organization_id = p_org $$;
grant execute on function public.member_contact_count(uuid) to authenticated;
