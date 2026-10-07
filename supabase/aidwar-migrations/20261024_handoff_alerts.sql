-- Batch 16 item 2 (NOT applied): hand-off alerts go to staff, never to the
-- business's own WhatsApp number.
--
-- Zoori (81c234b2…): owner_phone +919121024545 is its own business number,
-- so every alert would have landed in the inbox it was about.
--
-- organization_ai_settings gains the staff contacts (1–2 WhatsApp numbers +
-- an email; the 2-number limit and the "not our own number" rule are checked
-- on save in /api/ai/employee save_handoff_alerts, and again on every send)
-- and the hours a reminder may go in (null = Mon–Fri 9–18, Sat 10–14 in the
-- workspace's timezone). conversations gains when the alert and its single
-- reminder went. Nothing here changes needs_human: only a person clears it.
-- Idempotent.

ALTER TABLE public.organization_ai_settings
  ADD COLUMN IF NOT EXISTS handoff_alert_phones text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS handoff_alert_email text,
  ADD COLUMN IF NOT EXISTS handoff_alert_hours jsonb;

DO $$ BEGIN
  ALTER TABLE public.organization_ai_settings
    ADD CONSTRAINT organization_ai_settings_handoff_alert_phones_max2
    CHECK (coalesce(array_length(handoff_alert_phones, 1), 0) <= 2);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS handoff_alert_at timestamptz,
  ADD COLUMN IF NOT EXISTS handoff_reminded_at timestamptz;

-- The reminder sweep (flow-worker minute tick) reads only waiting chats.
CREATE INDEX IF NOT EXISTS conversations_handoff_reminder_idx
  ON public.conversations (handoff_alert_at)
  WHERE needs_human = true AND handoff_reminded_at IS NULL;

-- A new hand-off gets its own alert and reminder: clear both whenever a
-- person marks the chat handled (needs_human true → false).
CREATE OR REPLACE FUNCTION public.reset_handoff_alert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.needs_human IS TRUE AND NEW.needs_human IS NOT TRUE THEN
    NEW.handoff_alert_at := NULL;
    NEW.handoff_reminded_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS conversations_reset_handoff_alert ON public.conversations;
CREATE TRIGGER conversations_reset_handoff_alert
  BEFORE UPDATE OF needs_human ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.reset_handoff_alert();
