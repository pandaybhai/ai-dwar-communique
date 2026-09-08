-- Billing 2: credit notes, the credit_note ledger entry, and a fourth dunning
-- rung ('suspended' = plan paused, AI in draft mode). Applied to aidwar-mumbai
-- through AIDWAR_MUMBAI_DB_URL.
begin;

create table if not exists public.credit_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete restrict,
  number text unique,
  reason text not null,
  amount numeric(12,2) not null check (amount > 0),
  taxable_value numeric(12,2) not null default 0,
  cgst numeric(12,2) not null default 0,
  sgst numeric(12,2) not null default 0,
  igst numeric(12,2) not null default 0,
  status text not null default 'issued' check (status in ('issued','void')),
  refund_mode text not null default 'none' check (refund_mode in ('none','wallet')),
  ledger_entry_id uuid,
  pdf_path text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists credit_notes_org_idx on public.credit_notes(organization_id, created_at desc);
create index if not exists credit_notes_invoice_idx on public.credit_notes(invoice_id);

grant select on public.credit_notes to authenticated;
grant all on public.credit_notes to service_role;

alter table public.credit_notes enable row level security;

drop policy if exists credit_notes_select on public.credit_notes;
create policy credit_notes_select on public.credit_notes
  for select to authenticated
  using (public.has_permission(organization_id, 'billing.view'));

drop trigger if exists update_credit_notes_updated_at on public.credit_notes;
create trigger update_credit_notes_updated_at
  before update on public.credit_notes
  for each row execute function public.update_updated_at_column();

-- The wallet refund behind a credit note is its own entry type, so a refund
-- is never mistaken for an adjustment or a purchase.
alter table public.wallet_ledger drop constraint if exists wallet_ledger_entry_type_check;
alter table public.wallet_ledger add constraint wallet_ledger_entry_type_check
  check (entry_type = any (array[
    'credit_purchase','bonus_credits','starter_credits','coupon_credits',
    'debit_message','debit_ai','debit_addon','hold','hold_release',
    'refund','adjustment','expiry','credit_note'
  ]));

-- Dunning ladder: reminder_1 (due+1), reminder_2 (due+3), paused (campaigns
-- paused at due+pause days), suspended (plan paused at due+suspend days).
alter table public.organization_billing_settings drop constraint if exists obs_dunning_stage_check;
alter table public.organization_billing_settings add constraint obs_dunning_stage_check
  check (dunning_stage is null or dunning_stage in
    ('due','reminder_1','reminder_2','paused','suspended','locked'));

commit;
