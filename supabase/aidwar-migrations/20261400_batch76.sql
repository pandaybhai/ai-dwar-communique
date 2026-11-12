-- Batch 76 (NOT applied): every new lead is alerted to the sales numbers on
-- WhatsApp, and mirrored into AiDwar's own workspace as a contact.
--
-- (1) platform_settings.lead_alert_numbers — who gets the new-lead alert
--     (E.164), seeded with Vinay's two numbers while it is still empty.
-- (2) demo_leads.alerted_at — when the alert went (claimed once per lead).
-- (3) demo_leads.mirrored_at — when the lead was last copied into the
--     platform workspace's Contacts (tag "AiDwar lead", attributes, note).
--
-- Additive and idempotent. The only data change is the one-time seed in (1).

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS lead_alert_numbers text[] NOT NULL DEFAULT '{}';
UPDATE public.platform_settings
  SET lead_alert_numbers = ARRAY['+917981223192', '+919121883067']
  WHERE lead_alert_numbers = '{}';
ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS alerted_at timestamptz;
ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS mirrored_at timestamptz;

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
