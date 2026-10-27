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
