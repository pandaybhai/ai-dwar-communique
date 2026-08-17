-- Refresh health, observable without expiry maths.
-- A store with no sync work still has to refresh its Shopify grant, so we need
-- to see at a glance when a token was last actually rotated rather than
-- inferring it from expires_at.

alter table public.integration_credentials
  add column if not exists token_refreshed_at timestamptz;

comment on column public.integration_credentials.token_refreshed_at is
  'Last successful OAuth token refresh. Null means never refreshed since install.';
