-- Test-only: the slice of the live schema 20261290_batch55_no_gst.sql touches
-- (platform_settings with the Billing v1b supplier columns, invoices with the
-- kind check as Supabase prints it) and a no-op mcp_block_oauth_writes(), for
-- batch55-sql.test.ts on the throwaway local Postgres. Never applied anywhere else.
create table public.platform_settings (
  id boolean primary key default true check (id),
  supplier_legal_name text,
  supplier_gstin text,
  supplier_pan text,
  supplier_state_code text,
  invoice_footer text,
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (id, supplier_legal_name, supplier_gstin, supplier_pan, supplier_state_code, invoice_footer)
values (true, 'Meezoy Ventures Private Limited', '36AAACM0000D1Z5', 'AAACM0000D', '36',
        'Thank you for choosing AiDwar. [DEMO GSTIN 36AAACM0000D1Z5 — replace before go-live] Questions: support@aidwar.in');

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  invoice_number text,
  kind text not null default 'tax_invoice',
  purpose text not null,
  status text not null default 'draft',
  period_start date,
  payment_id uuid,
  constraint invoices_kind_check check ((kind = any (array['tax_invoice'::text, 'proforma'::text, 'credit_note'::text])))
);

create function public.mcp_block_oauth_writes() returns void language sql as $$ select $$;
