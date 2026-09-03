-- Admin billing surfaces: a skipped top-up must carry the reason it was
-- skipped, and the sweep needs a place to remember when it last warned an
-- organisation so it can't warn every hour.
begin;

alter table public.topup_tasks
  add column if not exists skip_reason text;

alter table public.organization_billing_settings
  add column if not exists last_low_credit_notice_at timestamptz,
  add column if not exists last_float_low_notice_at timestamptz,
  add column if not exists last_expiry_sweep_at timestamptz;

commit;
