-- Campaign broadcasts: campaigns + per-recipient snapshot rows
CREATE TABLE IF NOT EXISTS public.campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  template_name text,
  template_language text NOT NULL DEFAULT 'en_US',
  variable_mappings jsonb NOT NULL DEFAULT '{}'::jsonb,
  segment_id uuid REFERENCES public.segments(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','sending','paused','completed','cancelled','failed')),
  scheduled_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  total_recipients int NOT NULL DEFAULT 0,
  sent_count int NOT NULL DEFAULT 0,
  delivered_count int NOT NULL DEFAULT 0,
  read_count int NOT NULL DEFAULT 0,
  failed_count int NOT NULL DEFAULT 0,
  replied_count int NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.campaigns(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  phone text NOT NULL,
  resolved_variables jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','delivered','read','failed','skipped')),
  message_id uuid REFERENCES public.messages(id) ON DELETE SET NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX IF NOT EXISTS campaigns_org_idx ON public.campaigns (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON public.campaigns (status, scheduled_at);
CREATE INDEX IF NOT EXISTS campaign_recipients_campaign_idx
  ON public.campaign_recipients (campaign_id, status);
CREATE INDEX IF NOT EXISTS campaign_recipients_message_idx
  ON public.campaign_recipients (message_id);
CREATE INDEX IF NOT EXISTS campaign_recipients_contact_idx
  ON public.campaign_recipients (organization_id, contact_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.campaigns TO authenticated;
GRANT ALL ON public.campaigns TO service_role;
GRANT SELECT ON public.campaign_recipients TO authenticated;
GRANT ALL ON public.campaign_recipients TO service_role;

ALTER TABLE public.campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.campaign_recipients ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "campaigns_select_members" ON public.campaigns;
CREATE POLICY "campaigns_select_members" ON public.campaigns
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP POLICY IF EXISTS "campaigns_insert_admins" ON public.campaigns;
CREATE POLICY "campaigns_insert_admins" ON public.campaigns
  FOR INSERT TO authenticated
  WITH CHECK (public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin'));

DROP POLICY IF EXISTS "campaigns_update_admins" ON public.campaigns;
CREATE POLICY "campaigns_update_admins" ON public.campaigns
  FOR UPDATE TO authenticated
  USING (public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin'))
  WITH CHECK (public.has_org_role(organization_id, 'owner') OR public.has_org_role(organization_id, 'admin'));

DROP POLICY IF EXISTS "campaign_recipients_select_members" ON public.campaign_recipients;
CREATE POLICY "campaign_recipients_select_members" ON public.campaign_recipients
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

DROP TRIGGER IF EXISTS update_campaigns_updated_at ON public.campaigns;
CREATE TRIGGER update_campaigns_updated_at
  BEFORE UPDATE ON public.campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_campaign_recipients_updated_at ON public.campaign_recipients;
CREATE TRIGGER update_campaign_recipients_updated_at
  BEFORE UPDATE ON public.campaign_recipients
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Atomically claim queued recipients for the sender worker.
CREATE OR REPLACE FUNCTION public.claim_campaign_recipients(p_campaign_id uuid, p_limit int)
RETURNS TABLE (id uuid, contact_id uuid, phone text, resolved_variables jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT r.id
    FROM public.campaign_recipients r
    WHERE r.campaign_id = p_campaign_id AND r.status = 'queued'
    ORDER BY r.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public.campaign_recipients r
  SET status = 'sending', updated_at = now()
  FROM claimed
  WHERE r.id = claimed.id
  RETURNING r.id, r.contact_id, r.phone, r.resolved_variables;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_campaign_recipients(uuid, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_campaign_recipients(uuid, int) TO service_role;

-- Counter bumps used by the worker and the webhook processor.
CREATE OR REPLACE FUNCTION public.bump_campaign_counters(
  p_campaign_id uuid,
  p_sent int DEFAULT 0,
  p_delivered int DEFAULT 0,
  p_read int DEFAULT 0,
  p_failed int DEFAULT 0,
  p_replied int DEFAULT 0
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.campaigns
  SET sent_count = sent_count + p_sent,
      delivered_count = delivered_count + p_delivered,
      read_count = read_count + p_read,
      failed_count = failed_count + p_failed,
      replied_count = replied_count + p_replied,
      updated_at = now()
  WHERE id = p_campaign_id;
$$;

REVOKE ALL ON FUNCTION public.bump_campaign_counters(uuid, int, int, int, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bump_campaign_counters(uuid, int, int, int, int, int) TO service_role;

-- Reply attribution (one reply counted per contact per campaign)
ALTER TABLE public.campaign_recipients ADD COLUMN IF NOT EXISTS replied_at timestamptz;
