-- Batch 28 (NOT applied): an invoice notice is sent at most once per invoice
-- and channel.
--
-- 7 Oct 2026: the email for invoice AD/2026-27/00013 (Growth plan) went to
-- the client six times (10:36–10:40 x5, then 19:00) because its WhatsApp half
-- kept failing (client_invoice_issued still pending at Meta) and every pass
-- queued both channels again. The code now refuses this at three points:
--   * notify() (billing.server.ts, invoiceNoticeExists) queues no
--     invoice_issued notice while one for the same invoice and channel is
--     queued, sent, or failed by the drain (that row is the channel's retry);
--   * both drains (drainBillingNotifications, drainEmailNotices) retry a
--     failed row alone, with backoff, up to the cap (noticeRetryDue), and
--     close a row whose invoice another row already delivered on that channel
--     (invoiceNoticeSentElsewhere) — skipped, "already_sent";
--   * marking a row 'sent' that this index refuses (23505) is read as
--     "already sent" (writeNoticeOutcome): the row is closed as skipped,
--     never left pending for a resend.
-- This index is the database's own guard for a race between two drains.
--
-- Scoped to rows created from 2026-10-09 (IST) on: the 7 Oct incident left
-- several 'sent' email rows for AD/2026-27/00013, and those existing
-- duplicates would make an unscoped index fail to build. Those rows are history and are not
-- deleted. The predicate compares created_at with a timestamptz literal,
-- which is immutable, so it is allowed in a partial index.
--
-- Read-only check for existing duplicates (expected: the 7 Oct rows only,
-- all created before 2026-10-09, so outside the index):
--   select organization_id, channel, payload->>'invoice_id' as invoice_id,
--          count(*) as sent_rows, min(created_at), max(created_at)
--     from public.billing_notifications
--    where kind = 'invoice_issued' and status = 'sent' and payload ? 'invoice_id'
--    group by 1, 2, 3
--   having count(*) > 1
--    order by max(created_at) desc;
--
-- Read-only check that the index exists after applying:
--   select schemaname, tablename, indexname, indexdef
--     from pg_indexes
--    where schemaname = 'public'
--      and tablename = 'billing_notifications'
--      and indexname = 'billing_notifications_invoice_sent_uidx';
--
-- Idempotent.

SET lock_timeout = '5s';

create unique index if not exists billing_notifications_invoice_sent_uidx
  on public.billing_notifications (organization_id, channel, (payload->>'invoice_id'))
  where kind = 'invoice_issued'
    and status = 'sent'
    and payload ? 'invoice_id'
    and created_at >= '2026-10-09T00:00:00+05:30'::timestamptz;

RESET lock_timeout;
