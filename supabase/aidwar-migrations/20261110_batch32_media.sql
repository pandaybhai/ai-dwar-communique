-- Batch 32: keep customer media. Idempotent. NOT applied: apply by hand to
-- the Mumbai project. Until it is applied nothing breaks and nothing is
-- saved: the upload fails (no bucket), the row keeps "meta:<id>" exactly as
-- before and the sweep tries again (a storage failure is never counted as a
-- give-up attempt — only Meta refusing the download is).
--
-- (1) chat-media: a PRIVATE bucket for every file a customer sends (image,
--     video, audio/voice, document, sticker), at
--     {organization_id}/{conversation_id}/{message_id}.{ext}
--     (src/lib/chat-media.server.ts, saveInboundMedia). 25 MB a file; any
--     type (customers send any document). NO storage.objects policies for
--     anon or authenticated: only the service role reads or writes it, and
--     the inbox gets the bytes through /api/whatsapp/chat-media/$messageId
--     after a membership / super admin check. Never a public link.

SET lock_timeout = '5s';

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('chat-media', 'chat-media', false, 26214400, NULL)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = NULL;

-- messages.metadata already exists on live; kept here so a fresh database has it.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS metadata jsonb;

-- The sweep's rescue / expiry reads: inbound rows still on a Meta ref.
CREATE INDEX IF NOT EXISTS messages_inbound_meta_media_idx
  ON public.messages (created_at DESC)
  WHERE direction = 'inbound' AND media_url LIKE 'meta:%';

-- (4) Retention: kept files older than this many days are removed by the
--     maintenance sweep (runChatMediaSweep in the billing sweep): the object
--     goes, messages.media_url becomes NULL and metadata.media_removed_at is
--     set — the message itself (its words, its time) is never deleted. NULL =
--     keep forever. Until this column exists nothing is removed.
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS media_retention_days integer DEFAULT 365;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'platform_settings_media_retention_days_check'
      AND conrelid = 'public.platform_settings'::regclass
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_media_retention_days_check
      CHECK (media_retention_days IS NULL OR media_retention_days > 0);
  END IF;
END $$;

-- The retention read: rows whose file we keep, oldest first.
CREATE INDEX IF NOT EXISTS messages_chat_media_created_idx
  ON public.messages (created_at)
  WHERE media_url LIKE 'storage:chat-media/%';
