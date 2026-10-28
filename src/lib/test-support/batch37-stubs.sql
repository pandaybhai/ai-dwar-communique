-- Test-only: the tag tables the Batch 37 contacts list reads, shaped as
-- 20260814_contacts_tags_imports.sql makes them, for the throwaway local
-- Postgres. Never applied anywhere else.
create table if not exists public.tags (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  color text not null default '#10B981',
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
create table if not exists public.contact_tags (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tag_id uuid not null references public.tags(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (contact_id, tag_id)
);
