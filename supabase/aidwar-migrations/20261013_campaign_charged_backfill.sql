-- Batch 9 (optional, NOT applied): one-off catch-up for campaigns that were
-- settled before Meta priced their messages, so charged_amount stayed below
-- the sum of their debit_message ledger rows (live: campaign "Demo" shows
-- 0.00 while 3 x 1.04 were debited). From Batch 9 the app keeps this in step
-- on every price; this only fixes rows written before that.
--
-- Idempotent: recomputed from the ledger every time and only ever raises
-- charged_amount, so running it twice changes nothing and nothing is counted
-- twice. No schema change.

UPDATE public.campaigns c
SET charged_amount = d.total
FROM (
  SELECT organization_id,
         metadata->>'campaign_id' AS campaign_id,
         round(sum(abs(amount))::numeric, 2) AS total
  FROM public.wallet_ledger
  WHERE entry_type = 'debit_message'
    AND metadata->>'campaign_id' IS NOT NULL
  GROUP BY 1, 2
) d
WHERE d.campaign_id = c.id::text
  AND d.organization_id = c.organization_id
  AND c.charged_amount < d.total;
