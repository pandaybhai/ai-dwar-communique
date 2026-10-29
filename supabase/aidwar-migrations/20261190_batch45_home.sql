-- Batch 45: the new Home (new design, behind the new_design flag). Two
-- read-side indexes. Idempotent and additive. NOT applied: apply by hand to
-- the Mumbai project (hcsacmqzspnfqoftoifu).
--
-- The code works without this file: Home reads only existing tables and
-- columns through the member's own RLS-scoped client; these indexes only
-- make two of those reads cheaper. No table, column, view, function, policy
-- or grant is added or changed, so nothing about who can read what moves.
--
-- (1) messages_conv_inbound_created_idx: each open chat's newest customer
--     message, for "Free replies running out" (the 24-hour window counts
--     from it). Home embeds it per conversation
--     (last_in:messages(created_at), direction = 'inbound', newest first,
--     limit 1); an embed joins on conversation_id alone, so the existing
--     (organization_id, conversation_id, created_at) index can't serve it.
--     Partial on inbound rows only.
--
-- (2) flow_runs_org_started_idx: "Your flows today" — this workspace's Flows
--     v2 runs since the local day began (organization_id, started_at).
--
-- Large tables: CREATE INDEX blocks writes to the table while it builds
-- (lock_timeout stops it from waiting behind a busy table). If messages is
-- big on live, run (1) on its own as CREATE INDEX CONCURRENTLY IF NOT EXISTS
-- ... (outside a transaction) instead.
--
-- Rollback: DROP INDEX IF EXISTS public.messages_conv_inbound_created_idx;
--           DROP INDEX IF EXISTS public.flow_runs_org_started_idx;
-- Nothing depends on either.

SET lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS messages_conv_inbound_created_idx
  ON public.messages (conversation_id, created_at DESC)
  WHERE direction = 'inbound';

CREATE INDEX IF NOT EXISTS flow_runs_org_started_idx
  ON public.flow_runs (organization_id, started_at DESC);
