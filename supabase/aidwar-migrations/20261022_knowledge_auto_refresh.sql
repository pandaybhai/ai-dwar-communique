-- Batch 15C (NOT applied): whether websites are re-read automatically on a
-- schedule. Off by default — Vinay's decision (6–7 Oct): a site is re-read
-- only when the merchant asks ("Re-read whole site" / "Re-read this page");
-- the cron job aidwar-knowledge-refresh is paused live.
--
-- With this off, /api/internal/knowledge-refresh does nothing, and neither
-- the merchant's Knowledge screen nor Super Admin → Reading says a site
-- "refreshes every N days". Until this is applied the code treats the
-- missing column as off (reading.server.ts loadKnowledgeAutoRefresh) and
-- turning it on in Super Admin says this update is needed.
--
-- The nightly backfill (knowledge-backfill) is a different job and is not
-- touched. Idempotent: the column is only added when missing.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS knowledge_auto_refresh boolean NOT NULL DEFAULT false;
