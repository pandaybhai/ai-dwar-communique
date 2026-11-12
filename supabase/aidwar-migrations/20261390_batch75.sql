-- Batch 75 (NOT applied): when the one "finish sign-up" WhatsApp reminder
-- went to a /start lead (start-reminders.server.ts). NULL = not reminded.
-- A lead is reminded at most once: the worker claims the row by setting this
-- column while it is still NULL, so overlapping ticks can never both send.
--
-- Additive and idempotent. No data changes.

ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS nudged_at timestamptz;

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
