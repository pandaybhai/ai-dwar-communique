-- Batch 27 (H1): catch-up holds a stored webhook event with a lease instead
-- of marking it processed before it runs. Idempotent. NOT applied: apply by
-- hand to the Mumbai project (hcsacmqzspnfqoftoifu).
--
-- Found (health check #2, re-verified on main b5d4002): reprocessUnprocessedEvents
-- claimed an event by setting processed_at first; a catch-up pass that died
-- after the claim (pg_net drop, worker cut) left the event "processed" and
-- its customer message was never answered.
--
-- lease_until  null = nobody holds it. A catch-up pass sets it a few minutes
--              ahead (one conditional update on the value it read) and the
--              close (finishEvent) sets it back to null with processed_at. A
--              lease that ran out with processed_at still null is a pass
--              that died: the next catch-up counts it as an attempt
--              (WEBHOOK_MAX_ATTEMPTS still bounds it) and runs it again.
--
-- Nullable, no default: catalogue-only, no table rewrite. Until this is
-- applied the app reads the column as missing and claims with processed_at
-- exactly as before.

SET lock_timeout = '5s';

ALTER TABLE public.webhook_events ADD COLUMN IF NOT EXISTS lease_until timestamptz;

RESET lock_timeout;
