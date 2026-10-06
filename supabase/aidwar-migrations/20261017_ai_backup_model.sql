-- Batch 11B (item 1, NOT applied): the Anthropic model the AI backup answers
-- on, chosen on /admin/ai → AI backup and saved in platform settings.
--
-- NULL means the default (claude-sonnet-5-5, chosen to keep the cost down).
-- The server setting ANTHROPIC_BACKUP_MODEL still overrides whatever is saved
-- here. Until this is applied the card shows the default and saving a choice
-- says this update is needed; nothing else changes.
--
-- Idempotent: the column and the check are only added when missing. No data
-- is changed.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS ai_backup_anthropic_model text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_settings_ai_backup_anthropic_model_check'
      AND conrelid = 'public.platform_settings'::regclass
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_ai_backup_anthropic_model_check
      CHECK (
        ai_backup_anthropic_model IS NULL
        OR ai_backup_anthropic_model IN ('claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5')
      );
  END IF;
END $$;
