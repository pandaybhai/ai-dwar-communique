-- Template parity: media headers, carousels and copy-code buttons.
--
-- Meta needs two different things for the same picture: a one-time upload
-- "handle" when the template is created, and a reachable URL (or media id)
-- every time the template is sent. The handle expires and cannot be reused at
-- send time, so we keep our own copy of the file and remember both.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'template-media',
  'template-media',
  true,
  16777216, -- 16 MB, Meta's document ceiling
  ARRAY[
    'image/jpeg','image/png',
    'video/mp4','video/3gpp',
    'application/pdf'
  ]
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Reads are public: Meta fetches these URLs from its own servers with no
-- credentials. Paths are org-scoped and random, and nothing private is ever
-- placed here — only artwork the merchant is about to broadcast.
DROP POLICY IF EXISTS "template media public read" ON storage.objects;
CREATE POLICY "template media public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'template-media');

-- Writes only ever happen through the upload route on the service role, which
-- has already checked templates.manage. No client-side write path exists.
DROP POLICY IF EXISTS "template media service write" ON storage.objects;
CREATE POLICY "template media service write"
  ON storage.objects FOR ALL
  TO service_role
  USING (bucket_id = 'template-media')
  WITH CHECK (bucket_id = 'template-media');

CREATE TABLE IF NOT EXISTS public.template_media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  message_template_id uuid REFERENCES public.message_templates(id) ON DELETE CASCADE,
  -- Which part of the template this file belongs to: 'header', or 'card:0'…'card:9'.
  slot text NOT NULL DEFAULT 'header',
  format text NOT NULL,
  storage_path text NOT NULL,
  media_url text NOT NULL,
  mime_type text NOT NULL,
  file_name text,
  byte_size bigint,
  -- Meta's upload handle. Valid for template creation only, never for sending.
  meta_handle text,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT template_media_assets_format_check
    CHECK (format IN ('IMAGE','VIDEO','DOCUMENT')),
  CONSTRAINT template_media_assets_slot_check
    CHECK (slot = 'header' OR slot ~ '^card:[0-9]$')
);

GRANT SELECT ON public.template_media_assets TO authenticated;
GRANT ALL ON public.template_media_assets TO service_role;

ALTER TABLE public.template_media_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "template media assets readable by template viewers" ON public.template_media_assets;
CREATE POLICY "template media assets readable by template viewers"
  ON public.template_media_assets FOR SELECT
  TO authenticated
  USING (
    has_permission(organization_id, 'inbox.view')
    OR has_permission(organization_id, 'campaigns.view')
  );

CREATE INDEX IF NOT EXISTS template_media_assets_template_idx
  ON public.template_media_assets (message_template_id, slot);
CREATE INDEX IF NOT EXISTS template_media_assets_org_idx
  ON public.template_media_assets (organization_id, created_at DESC);

DROP TRIGGER IF EXISTS update_template_media_assets_updated_at ON public.template_media_assets;
CREATE TRIGGER update_template_media_assets_updated_at
  BEFORE UPDATE ON public.template_media_assets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
