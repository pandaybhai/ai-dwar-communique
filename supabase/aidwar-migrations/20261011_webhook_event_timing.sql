-- Batch 6: per-stage reply timings, stored with the webhook event they belong to.
-- Written by processWebhookPayload in the same update that marks the event
-- processed (no extra round trip). The app works before this is applied: the
-- update is retried without the column when it is missing.
-- Idempotent. Apply by hand to the Mumbai project; do not auto-apply.

ALTER TABLE public.webhook_events
  ADD COLUMN IF NOT EXISTS timing jsonb;

COMMENT ON COLUMN public.webhook_events.timing IS
  'Per-stage timings (ms) of processing this event: store, dedupe, contact/conversation, guards, flow routing, flow engine, WhatsApp send API, post-send bookkeeping. Null for events processed before batch 6 or with nothing to time.';
