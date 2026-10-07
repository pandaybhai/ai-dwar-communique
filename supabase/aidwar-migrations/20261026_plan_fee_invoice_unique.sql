-- Batch 18 (NOT applied): one plan-fee invoice per workspace per period.
--
-- invoicePlanFee (plan-billing.server.ts) read "is there one?" and then
-- built one, so two overlapping billing runs could both raise this period's
-- invoice (and payment link). The code now handles the refusal from this
-- index (a failed build that finds the other run's invoice answers
-- "already_invoiced"), and until this is applied it removes its own later
-- draft when an older one exists.
--
-- Only the invoices invoicePlanFee raises are covered: plan_fee tax invoices
-- with a period and no payment yet. A mandate charge's invoice is built with
-- its payment (subscriptions.server.ts) and a reissue has no period, so
-- neither can ever be refused by this index. A void invoice frees its period.
--
-- Before applying, check there are no duplicates already (the index cannot
-- be built over them; resolve any by voiding the extra one):
--   select organization_id, period_start, count(*)
--     from public.invoices
--    where purpose = 'plan_fee' and kind = 'tax_invoice' and status <> 'void'
--      and period_start is not null and payment_id is null
--    group by 1, 2 having count(*) > 1;
--
-- Idempotent.

create unique index if not exists plan_fee_invoice_period_uidx
  on public.invoices (organization_id, period_start)
  where purpose = 'plan_fee'
    and kind = 'tax_invoice'
    and status <> 'void'
    and period_start is not null
    and payment_id is null;
