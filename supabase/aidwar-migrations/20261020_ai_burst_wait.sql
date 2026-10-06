-- Batch 15A (NOT applied): how long Aiden waits for a second text before
-- answering (the "burst" window), as a platform setting edited on
-- Super Admin → AI. Was a fixed 5 s in code; the default is now 1 s — two
-- quick texts may get two replies, every reply comes ~4 s sooner (Vinay,
-- 7 Oct).
--
-- Until this is applied the code uses 1 s (DEFAULT_BURST_WINDOW_MS in
-- whatsapp-webhook.server.ts) and saving a different value on the admin page
-- says this update is needed. Idempotent: the column and its check are only
-- added when missing. No other data changes.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS ai_burst_wait_ms integer NOT NULL DEFAULT 1000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_settings_ai_burst_wait_ms_check'
      AND conrelid = 'public.platform_settings'::regclass
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_ai_burst_wait_ms_check
      CHECK (ai_burst_wait_ms BETWEEN 0 AND 10000);
  END IF;
END $$;
