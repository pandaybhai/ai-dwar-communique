ALTER TABLE public.ai_instructions
  ADD COLUMN IF NOT EXISTS handover_message text NOT NULL
  DEFAULT 'Let me get someone from the team to help — they''ll reply here shortly.';

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS needs_human boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_human_reason text,
  ADD COLUMN IF NOT EXISTS needs_human_question text,
  ADD COLUMN IF NOT EXISTS needs_human_at timestamptz,
  ADD COLUMN IF NOT EXISTS handover_state text;

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_handover_state_check;
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_handover_state_check
  CHECK (handover_state IS NULL OR handover_state IN ('sent','window_closed','opted_out','failed','not_configured'));

CREATE INDEX IF NOT EXISTS conversations_needs_human_idx
  ON public.conversations (organization_id, needs_human_at DESC)
  WHERE needs_human;
