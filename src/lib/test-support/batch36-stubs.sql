-- Test-only: public.contacts' opt-in column shaped as on live (NOT NULL,
-- default 'unknown', the three-value CHECK) and the contacts registry row,
-- for the throwaway local Postgres. Never applied anywhere else.
alter table public.contacts alter column opt_in_status set default 'unknown';
update public.contacts set opt_in_status = 'unknown' where opt_in_status is null;
alter table public.contacts alter column opt_in_status set not null;
alter table public.contacts
  add constraint contacts_opt_in_status_check check (opt_in_status in ('opted_in', 'opted_out', 'unknown'));
insert into public.feature_registry (key, name, description, icon, flag_key, activity_actions)
values ('contacts', 'Contacts', 'Contacts', 'users', 'contacts', array['contact_created', 'optin_changed'])
on conflict (key) do nothing;
