-- Batch 3 safety. NOT APPLIED — review, then apply by hand. Idempotent: safe
-- to run more than once. The app code in the same PR works before and after
-- it is applied (see notes per section).
--
-- (1) claim_flow_runs: a timer claim moves the run to 'running', so a
--     customer reply (whose claim only takes runs still 'waiting' for a reply)
--     can no longer advance the same run at the same moment. The engine
--     advances a claimed run from the wait it was claimed in. Before each
--     claim, runs that a claim moved to 'running' but that never saved a step
--     for over 5 minutes (the process died) go back to 'waiting' and are
--     claimed again. A run that saved a step has claimed_at cleared, so it is
--     never touched by the reclaim.
--     Before this is applied, the old claim leaves the run 'waiting' and the
--     engine behaves exactly as it does today.
-- (2) wallet_ledger: at most one credit_purchase / bonus_credits /
--     coupon_credits entry per payment written by settlePayment (the ones
--     carrying metadata.payment_id). Manual corrections (no payment_id in
--     metadata) are not affected. Checked on live 29 Sep 2026: no existing
--     rows conflict. settlePayment also checks the ledger before crediting
--     and treats a unique conflict (23505) as "already credited", so it is
--     idempotent with or without this index; the index closes the race
--     between two deliveries arriving at the same instant.

-- ------------------------------------------------------ (1) claim_flow_runs
CREATE OR REPLACE FUNCTION public.claim_flow_runs(p_limit integer)
RETURNS SETOF public.flow_runs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Claimed, moved to running, never saved a step: back to the wait it was in.
  UPDATE public.flow_runs
     SET status = 'waiting', claimed_at = NULL, updated_at = now()
   WHERE status = 'running'
     AND claimed_at IS NOT NULL
     AND claimed_at < now() - interval '5 minutes'
     AND waiting_for IS NOT NULL;

  RETURN QUERY
  UPDATE public.flow_runs r
     SET status = 'running', claimed_at = now()
   WHERE r.id IN (
     SELECT id FROM public.flow_runs
      WHERE status = 'waiting' AND wake_at IS NOT NULL AND wake_at <= now()
        AND (claimed_at IS NULL OR claimed_at < now() - interval '5 minutes')
      ORDER BY wake_at
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED)
  RETURNING r.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_flow_runs(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_flow_runs(integer) TO service_role;

-- ------------------------------------------- (2) one credit per payment
CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_payment_credit_once
  ON public.wallet_ledger (reference_id, entry_type)
  WHERE reference_type = 'payment'
    AND entry_type IN ('credit_purchase', 'bonus_credits', 'coupon_credits')
    AND metadata ? 'payment_id';
