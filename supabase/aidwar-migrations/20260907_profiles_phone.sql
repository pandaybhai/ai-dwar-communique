-- The owner's own number, used as the fallback recipient for billing notices
-- when a workspace has no billing WhatsApp number on file.
alter table public.profiles add column if not exists phone text;
