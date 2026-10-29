-- Batch 47: Campaigns, Templates and Cards in the new design (behind the
-- new_design flag). One read-side index. Idempotent and additive. NOT applied:
-- apply by hand to the Mumbai project (hcsacmqzspnfqoftoifu).
--
-- The code works without this file: the new screens read only existing
-- tables and columns through the member's own RLS-scoped client, with the
-- same queries the Batch 41 list and results page already make; this index
-- only makes one of those reads cheaper. No table, column, view, function,
-- policy or grant is added or changed, so nothing about who can read what
-- moves.
--
-- campaign_recipients_campaign_updated_idx: a campaign's recipients, newest
-- change first, 20 at a time (the results' Recipients table, Batch 41's and
-- Batch 47's: .eq("campaign_id") .order("updated_at", desc) .range()). The
-- existing (campaign_id, status) index finds the rows but every page sorts the
-- whole campaign; for a 50,000-recipient send that is a 50,000-row sort every
-- 5 seconds while the page is open. With a status filter Postgres still uses
-- (campaign_id, status).
--
-- Large tables: CREATE INDEX blocks writes to the table while it builds
-- (lock_timeout stops it from waiting behind a busy table). If
-- campaign_recipients is big on live, run it on its own as
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS ... (outside a transaction) instead.
--
-- Rollback: DROP INDEX IF EXISTS public.campaign_recipients_campaign_updated_idx;
-- Nothing depends on it.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_updated_idx
  ON public.campaign_recipients (campaign_id, updated_at DESC);
