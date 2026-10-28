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
-- Supabase Vault, as the functions use it (create_secret / update_secret /
-- decrypted_secrets), with the secret kept as plain text: this is a
-- throwaway database.
create schema if not exists vault;
create table if not exists vault.secrets (
  id uuid primary key default gen_random_uuid(),
  name text unique,
  description text,
  secret text not null
);
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
returns uuid language sql as $$
  insert into vault.secrets (name, description, secret) values (new_name, new_description, new_secret) returning id;
$$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null)
returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id;
$$;
create or replace view vault.decrypted_secrets as select id, name, description, secret, secret as decrypted_secret from vault.secrets;
