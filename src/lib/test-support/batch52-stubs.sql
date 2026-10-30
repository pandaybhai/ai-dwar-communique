-- Test-only: what 20261260_batch52_mcp.sql touches that the load-test schema
-- leaves out (feature flags, the registry, permissions, segments), Supabase's
-- auth.jwt() answering from request.jwt.claims (as PostgREST sets it), and
-- RLS with permissive policies on a few tables the app's members write, for
-- batch52-sql.test.ts on the throwaway local Postgres. Never applied anywhere else.
create table if not exists public.feature_flags (
  key text primary key, name text not null, description text, default_enabled boolean not null default false
);
create table if not exists public.feature_registry (
  key text primary key, name text not null, description text not null, icon text not null,
  nav_path text, nav_order int, nav_permission text, flag_key text not null, settings_path text,
  permissions jsonb not null default '[]'::jsonb, analytics jsonb not null default '{}'::jsonb,
  activity_actions text[] not null default '{}', usage_meters jsonb not null default '[]'::jsonb,
  ai_tools jsonb not null default '[]'::jsonb, data_tables text[] not null default '{}',
  depends_on text[] not null default '{}', synced_at timestamptz not null default now()
);
insert into public.feature_registry (key, name, description, icon, flag_key) values
  ('campaigns', 'Campaigns', 'Campaigns', 'megaphone', 'campaigns')
on conflict (key) do nothing;
create table if not exists public.permissions (
  key text primary key, name text not null, description text, category text, min_role text,
  constraint permissions_category_check check (category in ('campaigns', 'contacts'))
);
insert into public.permissions (key, name, category, min_role) values
  ('campaigns.send', 'Send campaigns', 'campaigns', 'marketer')
on conflict (key) do nothing;
create table if not exists public.role_permissions (
  role text not null, permission_key text not null, primary key (role, permission_key)
);
create table if not exists public.segments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null, description text, filters jsonb not null default '{}'::jsonb,
  created_by uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- Supabase's auth.jwt(): the claims PostgREST put on the request.
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated;

-- Tables a member writes from the browser today: RLS on, permissive policies
-- (any signed-in user, for the test), writes granted to authenticated.
do $$
declare t text;
begin
  foreach t in array array['contacts', 'campaigns', 'segments', 'conversations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists member_all on public.%I', t);
    execute format('create policy member_all on public.%I for all to authenticated using (auth.uid() is not null) with check (auth.uid() is not null)', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
-- RLS on but members only read it: no write policies are added.
alter table public.message_templates enable row level security;
drop policy if exists member_read on public.message_templates;
create policy member_read on public.message_templates for select to authenticated using (true);
grant select on public.message_templates to authenticated;
-- RLS off and writable (a hole the pre-request guard closes for OAuth tokens).
grant select, insert on public.short_links to authenticated;
grant select on public.organizations to authenticated;
