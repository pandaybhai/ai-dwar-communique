-- Batch 28 item 1 (NOT applied): who the staff hand-off alert reached.
--
-- sendHandoffAlert (src/lib/handoff-alerts.server.ts) now always records the
-- alert — handoff_alert_at (or handoff_reminded_at for the reminder) in one
-- write, then this result in a second write — so the Inbox's "Waiting for
-- you" banner can say who was told, or that nobody could be reached
-- (describeAlertResult in src/lib/ai-outcome.ts).
--
-- Shape: {"at": iso, "reminder": bool, "whatsapp": [phones], "email": text|null,
--         "skipped": "no_staff_contact"|"not_delivered"|"error"|null}
--
-- Without this file the code still works: the timestamp write is separate,
-- the result write fails quietly, and the banner reads the column in its own
-- query and shows nothing when the read fails. Idempotent.

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS handoff_alert_result jsonb;

-- Marking a chat handled clears the alert result with the timestamps, so a
-- later hand-off never shows the previous one's outcome. Same function the
-- trigger from 20261024_handoff_alerts.sql already calls; only the new column
-- is added to it.
CREATE OR REPLACE FUNCTION public.reset_handoff_alert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.needs_human IS TRUE AND NEW.needs_human IS NOT TRUE THEN
    NEW.handoff_alert_at := NULL;
    NEW.handoff_reminded_at := NULL;
    NEW.handoff_alert_result := NULL;
  END IF;
  RETURN NEW;
END $$;
