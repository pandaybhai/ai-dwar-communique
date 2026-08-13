-- Phase 2: WhatsApp data plane (external aidwar-mumbai project)
-- Tables only. All RLS via existing security definer helpers is_org_member/has_org_role.

-- ============ whatsapp_accounts ============
CREATE TABLE IF NOT EXISTS public.whatsapp_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  waba_id text,
  phone_number_id text UNIQUE,
  display_phone_number text,
  verified_name text,
  quality_rating text NOT NULL DEFAULT 'UNKNOWN',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','disconnected')),
  connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.whatsapp_accounts TO authenticated;
GRANT ALL ON public.whatsapp_accounts TO service_role;
ALTER TABLE public.whatsapp_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "whatsapp_accounts_select_members" ON public.whatsapp_accounts
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));

CREATE INDEX IF NOT EXISTS whatsapp_accounts_org_idx ON public.whatsapp_accounts(organization_id);

-- ============ whatsapp_credentials (service role only, NO policies) ============
CREATE TABLE IF NOT EXISTS public.whatsapp_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL UNIQUE REFERENCES public.organizations(id) ON DELETE CASCADE,
  access_token text,
  token_type text NOT NULL DEFAULT 'business',
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.whatsapp_credentials FROM anon, authenticated;
GRANT ALL ON public.whatsapp_credentials TO service_role;
ALTER TABLE public.whatsapp_credentials ENABLE ROW LEVEL SECURITY;
-- intentionally no policies: only the service role may read/write tokens
CREATE TRIGGER whatsapp_credentials_updated_at BEFORE UPDATE ON public.whatsapp_credentials
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ webhook_events (service role only, NO policies) ============
CREATE TABLE IF NOT EXISTS public.webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'meta',
  payload jsonb NOT NULL,
  signature_valid boolean,
  processed_at timestamptz,
  error text,
  received_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON public.webhook_events FROM anon, authenticated;
GRANT ALL ON public.webhook_events TO service_role;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS webhook_events_received_idx ON public.webhook_events(received_at DESC);
CREATE INDEX IF NOT EXISTS webhook_events_unprocessed_idx ON public.webhook_events(processed_at) WHERE processed_at IS NULL;

-- ============ contacts ============
CREATE TABLE IF NOT EXISTS public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  wa_id text,
  phone text NOT NULL,
  name text,
  opt_in_status text NOT NULL DEFAULT 'unknown' CHECK (opt_in_status IN ('opted_in','opted_out','unknown')),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, phone)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;
GRANT ALL ON public.contacts TO service_role;
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "contacts_select_members" ON public.contacts
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "contacts_insert_members" ON public.contacts
  FOR INSERT TO authenticated WITH CHECK (public.is_org_member(organization_id));
CREATE POLICY "contacts_update_members" ON public.contacts
  FOR UPDATE TO authenticated USING (public.is_org_member(organization_id))
  WITH CHECK (public.is_org_member(organization_id));
CREATE POLICY "contacts_delete_admins" ON public.contacts
  FOR DELETE TO authenticated USING (public.has_org_role(organization_id, 'admin'));
CREATE INDEX IF NOT EXISTS contacts_org_idx ON public.contacts(organization_id);
CREATE INDEX IF NOT EXISTS contacts_org_wa_idx ON public.contacts(organization_id, wa_id);
CREATE TRIGGER contacts_updated_at BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============ conversations ============
CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  whatsapp_account_id uuid REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','pending')),
  assigned_to uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  last_message_at timestamptz,
  last_customer_message_at timestamptz,
  unread_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT ALL ON public.conversations TO service_role;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "conversations_select_members" ON public.conversations
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
CREATE POLICY "conversations_insert_members" ON public.conversations
  FOR INSERT TO authenticated WITH CHECK (public.is_org_member(organization_id));
CREATE POLICY "conversations_update_members" ON public.conversations
  FOR UPDATE TO authenticated USING (public.is_org_member(organization_id))
  WITH CHECK (public.is_org_member(organization_id));
CREATE POLICY "conversations_delete_admins" ON public.conversations
  FOR DELETE TO authenticated USING (public.has_org_role(organization_id, 'admin'));
CREATE INDEX IF NOT EXISTS conversations_org_last_msg_idx
  ON public.conversations(organization_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_contact_idx ON public.conversations(contact_id);

-- ============ messages ============
CREATE TABLE IF NOT EXISTS public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES public.conversations(id) ON DELETE CASCADE,
  meta_message_id text UNIQUE,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  type text NOT NULL DEFAULT 'text',
  body text,
  media_url text,
  media_mime text,
  template_name text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','delivered','read','failed')),
  status_updated_at timestamptz,
  error_detail text,
  sent_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messages_select_members" ON public.messages
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
-- outbound drafts only; inbound rows are written by the service role
CREATE POLICY "messages_insert_members" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (public.is_org_member(organization_id) AND direction = 'outbound');
CREATE INDEX IF NOT EXISTS messages_org_conv_created_idx
  ON public.messages(organization_id, conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_meta_id_idx ON public.messages(meta_message_id);
