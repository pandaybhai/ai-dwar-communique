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
   SET activity_actions = coalesce(activity_actions, '{}'::text[]) || array['campaign_test_sent']::text[],
       synced_at = now()
 WHERE key = 'campaigns'
   AND NOT ('campaign_test_sent' = ANY (coalesce(activity_actions, '{}'::text[])));

-- (3) ------------------------------------------------- WhatsApp profile
-- Settings → WhatsApp → profile reads and writes Meta's
-- whatsapp_business_profile directly; nothing is stored. Its three activity
-- actions are listed on the settings feature_registry row.
UPDATE public.feature_registry
   SET activity_actions = coalesce(activity_actions, '{}'::text[]) || ARRAY(
         SELECT a FROM unnest(array['whatsapp_profile_updated','whatsapp_profile_photo_updated','whatsapp_display_name_requested']::text[]) AS a
          WHERE NOT (a = ANY (coalesce(activity_actions, '{}'::text[])))
       ),
       synced_at = now()
 WHERE key = 'settings'
   AND NOT (coalesce(activity_actions, '{}'::text[]) @> array['whatsapp_profile_updated','whatsapp_profile_photo_updated','whatsapp_display_name_requested']::text[]);
