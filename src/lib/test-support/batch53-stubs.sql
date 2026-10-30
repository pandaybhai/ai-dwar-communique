-- Test-only: what 20261270_batch53_aiden_workspace.sql touches beyond the
-- load-test schema and batch52-stubs.sql: auth.users, Aiden's agents, the
-- members, and Supabase Auth's OAuth server tables (consents, clients and
-- sessions marked with their client), for batch53-sql.test.ts on the
-- throwaway local Postgres. Never applied anywhere else.
create table if not exists auth.users (id uuid primary key, email text);
create table if not exists public.ai_agents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  mode text
);
create table if not exists public.organization_members (
  organization_id uuid not null, user_id uuid not null, role text not null default 'agent',
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create table if not exists auth.oauth_clients (
  id uuid primary key, client_name text, client_uri text, created_at timestamptz default now()
);
create table if not exists auth.oauth_consents (
  id uuid primary key default gen_random_uuid(), user_id uuid not null, client_id uuid not null,
  scopes text, granted_at timestamptz not null default now(), revoked_at timestamptz
);
create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null,
  created_at timestamptz default now(), updated_at timestamptz, oauth_client_id uuid
);
