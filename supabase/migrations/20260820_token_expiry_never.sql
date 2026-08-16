alter table public.whatsapp_credentials
  add column if not exists expires_never boolean not null default false;

comment on column public.whatsapp_credentials.expires_never is
  'True when Meta /debug_token reported expires_at = 0 (permanent system-user token).';

-- Backfill: debug_token succeeded (scopes captured) but no expiry => 0 => permanent.
update public.whatsapp_credentials
   set expires_never = true
 where expires_at is null
   and granted_scopes is not null;
