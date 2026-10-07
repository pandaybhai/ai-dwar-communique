-- Batch 21 item 2 (NOT applied): a flow's "Hand to Aiden" step can leave the
-- merchant's own Behaviour / Rules on the chat for Aiden, with an expiry the
-- merchant picks (default 24 h).
--
-- conversations.aiden_flow_rules = { flow_id, flow_name, run_id, behaviour,
-- rules, set_at, expires_at } or null. Written only by the flow engine
-- (service role, the Hand-to-Aiden step); read by Aiden's answer and the inbox
-- header. Merchant-written instructions, not secrets: members already read
-- conversations. Until this is applied the engine's write fails quietly and
-- Aiden answers exactly as before (the answer reads conversations with *).
-- Idempotent.

SET lock_timeout = '5s';

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS aiden_flow_rules jsonb;
