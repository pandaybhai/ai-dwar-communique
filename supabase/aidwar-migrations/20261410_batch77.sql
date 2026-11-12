-- Batch 77 (NOT applied): a lead's sales stage goes back to Meta.
--
-- (1) What the original Lead was matched with, kept on the lead for its later
--     stage events: meta_fbc (the _fbc cookie, else "fb.1.<ms>.<fbclid>" from
--     the visit), meta_fbp (only when the _fbp cookie existed — set only after
--     the cookie banner's Accept) and meta_external_id (the lead id the Lead
--     used). Never the raw IP or user agent.
-- (2) meta_events_sent — the stage events already sent, by stage
--     ({ "contacted": { event, event_id, at }, … }), so each goes once and the
--     Admin side sheet can say "Sent to Meta ✓".
--
-- Additive and idempotent; no data is changed. Without it the code still
-- sends each event once (the activity_log once-marker) and stores nothing.

ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS meta_fbc text;
ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS meta_fbp text;
ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS meta_external_id text;
ALTER TABLE public.demo_leads
  ADD COLUMN IF NOT EXISTS meta_events_sent jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
