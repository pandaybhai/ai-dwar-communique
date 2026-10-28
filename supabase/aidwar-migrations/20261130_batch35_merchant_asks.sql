-- Batch 35: merchant asks. Idempotent. NOT applied: apply by hand to the
-- Mumbai project (hcsacmqzspnfqoftoifu) after the code is live.
--
-- (1) Campaign test send: the new activity action campaign_test_sent is
--     listed on the campaigns feature_registry row (as feature-registry.ts
--     declares it). Nothing else: a test is an ordinary messages row
--     (metadata.test = true, campaign_id null), charged by the existing
--     messages billing trigger. Before this file: tests work; only the
--     registry row doesn't list the action yet.

SET lock_timeout = '5s';

-- (1) ------------------------------------------------- campaign test send
UPDATE public.feature_registry
   SET activity_actions = (
         SELECT array_agg(DISTINCT a ORDER BY a)
           FROM unnest(coalesce(activity_actions, '{}'::text[]) || array['campaign_test_sent']::text[]) AS a
       ),
       synced_at = now()
 WHERE key = 'campaigns'
   AND NOT ('campaign_test_sent' = ANY (coalesce(activity_actions, '{}'::text[])));
