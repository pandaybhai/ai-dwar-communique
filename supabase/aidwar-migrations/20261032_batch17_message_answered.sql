-- Batch 17 (3): an inbound message records "answered" separately from "stored".
-- Idempotent. Apply by hand to the Mumbai project (hcsacmqzspnfqoftoifu); do not auto-apply.
--
-- Found (7 Oct health check, re-verified): processWebhookPayload stores the
-- inbound message first; if the pass dies after that (worker cut off, a
-- throw before the reply), the retry finds the message already stored, treats
-- it as a duplicate and nobody ever answers the customer.
--
-- answered_at       set when a pass finished routing the message (replied, or
--                   deliberately didn't). A retry re-answers only a row with
--                   answered_at IS NULL.
-- answer_claimed_at when a pass started answering: stamped by the insert itself
--                   (DEFAULT now(), no extra write on the reply path) and by a
--                   retry's claim. A retry claims only a row whose stamp is
--                   older than 3 minutes, so one live pass is never doubled.
--
-- Every row that exists when this runs reads answered_at = 'epoch' (a constant
-- default: catalogue-only, no table rewrite), so no old message is ever
-- answered again; the default is then dropped so new rows start unanswered.
-- Until this is applied the app sees the columns missing and keeps today's
-- behaviour (a duplicate stays a duplicate).

SET lock_timeout = '5s';

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS answered_at timestamptz DEFAULT 'epoch';
ALTER TABLE public.messages ALTER COLUMN answered_at DROP DEFAULT;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS answer_claimed_at timestamptz DEFAULT now();

RESET lock_timeout;
