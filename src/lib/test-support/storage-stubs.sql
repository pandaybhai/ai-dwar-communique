-- Test-only: the two Supabase storage tables a migration touches (Batch 32),
-- for the throwaway local Postgres. Never applied anywhere else.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  created_at timestamptz default now()
);
alter table storage.objects enable row level security;
