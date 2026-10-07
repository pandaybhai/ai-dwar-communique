-- Batch 23 (NOT applied): one queued invoice notice per invoice and channel.
--
-- notify() (billing.server.ts) already refuses an invoice_issued notice while
-- one for the same invoice and channel is queued or sent. It reads, then
-- inserts, so two runs at the same moment could both pass the read; this
-- index refuses the second queued row (notify ignores the refusal, so the
-- money path never breaks).
--
-- Only 'queued' rows are covered. 'sent' cannot be: the incident of 7 Oct
-- 2026 left five sent email notices for AD/2026-27/00013
-- (invoice 4822026b-e4d8-4dfa-a25d-8fc13a2ecebb), and those rows would stop
-- the index from being built. Checked on the live DB on 7 Oct: no invoice has
-- more than one queued notice per channel (no queued invoice_issued rows at
-- all), so this index builds over today's data. Re-check before applying:
--   select organization_id, channel, payload->>'invoice_id', count(*)
--     from public.billing_notifications
--    where kind = 'invoice_issued' and status = 'queued' and payload ? 'invoice_id'
--    group by 1, 2, 3 having count(*) > 1;
-- (resolve any by marking the extra ones failed).
--
-- Idempotent.

SET lock_timeout = '5s';

create unique index if not exists billing_notifications_invoice_queued_uidx
  on public.billing_notifications (organization_id, channel, (payload->>'invoice_id'))
  where kind = 'invoice_issued'
    and status = 'queued'
    and payload ? 'invoice_id';

RESET lock_timeout;
