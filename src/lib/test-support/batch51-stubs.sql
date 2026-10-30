-- Test-only: what 20261250_batch51_gaps.sql touches that the load-test schema
-- leaves out (segments, the feature registry), and has_permission / auth.uid
-- answering from settings, for batch51-sql.test.ts on the throwaway local
-- Postgres. Never applied anywhere else.
create table if not exists public.feature_registry (
  key text primary key, name text not null, description text not null, icon text not null,
  nav_path text, nav_order int, nav_permission text, flag_key text not null, settings_path text,
  permissions jsonb not null default '[]'::jsonb, analytics jsonb not null default '{}'::jsonb,
  activity_actions text[] not null default '{}', usage_meters jsonb not null default '[]'::jsonb,
  ai_tools jsonb not null default '[]'::jsonb, data_tables text[] not null default '{}',
  depends_on text[] not null default '{}', synced_at timestamptz not null default now()
);
insert into public.feature_registry (key, name, description, icon, flag_key, activity_actions, data_tables) values
  ('templates', 'Templates', 'Templates', 'message-square-text', 'templates', array['template_created', 'template_synced'], array['message_templates']),
  ('contacts', 'Contacts', 'Contacts', 'users', 'contacts', array['contact_created', 'segment_created'], array['contacts', 'segments'])
on conflict (key) do nothing;

-- As 20260814_segments.sql creates it.
create table if not exists public.segments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  description text,
  filters jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- The signed-in member and their permissions come from settings here.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid $$;
create or replace function public.has_permission(org_id uuid, perm text) returns boolean
language sql stable as $$
  select perm = any(string_to_array(coalesce(current_setting('test.perms', true), ''), ',')) $$;
grant execute on function public.has_permission(uuid, text) to authenticated;
grant select on public.contacts, public.segments, public.organizations to authenticated;
