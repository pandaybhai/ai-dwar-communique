-- Short links behind template URL buttons.
--
-- Meta requires a URL button with a variable to be filled at send time, and the
-- link has to be short and stable. We mint one row per send, resolve it at
-- /r/:token, count the click, and redirect to the real destination.
CREATE TABLE IF NOT EXISTS public.short_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  target_url text NOT NULL,
  scheduled_send_id uuid REFERENCES public.scheduled_sends(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  click_count integer NOT NULL DEFAULT 0,
  first_clicked_at timestamptz,
  last_clicked_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS short_links_org_idx ON public.short_links (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS short_links_send_idx ON public.short_links (scheduled_send_id);

GRANT SELECT ON public.short_links TO authenticated;
GRANT ALL ON public.short_links TO service_role;

ALTER TABLE public.short_links ENABLE ROW LEVEL SECURITY;

-- Members with flow visibility can see the links their messages created.
-- Resolution and click counting happen with the service role only.
DROP POLICY IF EXISTS "short_links_select_members" ON public.short_links;
CREATE POLICY "short_links_select_members"
  ON public.short_links FOR SELECT TO authenticated
  USING (public.has_permission(organization_id, 'flows.view') OR public.is_super_admin());
