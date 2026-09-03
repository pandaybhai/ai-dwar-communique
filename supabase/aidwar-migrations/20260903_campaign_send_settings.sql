-- Campaigns can now carry their own media for a template's picture/clip/file
-- header and for carousel cards, so a media template no longer depends on the
-- file it was authored with.
alter table public.campaigns
  add column if not exists send_settings jsonb not null default '{}'::jsonb;
