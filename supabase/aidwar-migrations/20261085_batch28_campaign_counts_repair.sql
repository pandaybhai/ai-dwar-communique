-- Batch 28 items 7 + 8 (NOT applied): campaign counters left at 0 while
-- campaign_recipient_status() was missing on live.
--
-- 20261016_send_at_scale.sql was not on live until 8 Oct 12:36: every
-- campaign status webhook failed ("Could not find the function
-- public.campaign_recipient_status"), so recipients stayed at 'sent' and
-- campaigns.delivered_count / read_count stayed 0 (a 1-contact campaign showed
-- Delivered 0% / Read 0% while its message row was delivered). The webhook no
-- longer depends on the function (applyCampaignStatus never throws; the
-- message is still moved, priced and its event emitted), but the rows that
-- failed before are repaired here, once:
--
--   1. a recipient behind its own message's status is moved up to it
--      (delivered / read only, never down; failed is left to the sender);
--   2. delivered_count / read_count are RAISED to what the recipients now
--      say (delivered_count counts delivered + read, as the function does).
--      Raise-only: a counter is never lowered.
--
-- Run as postgres (the campaigns guard trigger, 20261008, keeps counters for
-- the server only). Idempotent: a second run changes nothing.

UPDATE public.campaign_recipients r
   SET status = m.status,
       message_id = coalesce(r.message_id, m.id),
       updated_at = now()
  FROM public.messages m
 WHERE (m.id = r.message_id OR (r.message_id IS NULL AND m.metadata->>'campaign_recipient_id' = r.id::text))
   AND m.status IN ('delivered', 'read')
   AND (
         r.status IN ('queued', 'sending', 'sent', 'skipped')
      OR (r.status = 'delivered' AND m.status = 'read')
   );

WITH counted AS (
  SELECT campaign_id,
         count(*) FILTER (WHERE status IN ('delivered', 'read')) AS delivered,
         count(*) FILTER (WHERE status = 'read') AS read
    FROM public.campaign_recipients
   GROUP BY campaign_id
)
UPDATE public.campaigns c
   SET delivered_count = greatest(c.delivered_count, counted.delivered),
       read_count = greatest(c.read_count, counted.read),
       updated_at = now()
  FROM counted
 WHERE counted.campaign_id = c.id
   AND (c.delivered_count < counted.delivered OR c.read_count < counted.read);

-- Read-only check (0 rows once applied):
--   SELECT c.id, c.name, c.delivered_count, c.read_count,
--          count(*) FILTER (WHERE r.status IN ('delivered','read')) AS recipients_delivered,
--          count(*) FILTER (WHERE r.status = 'read') AS recipients_read
--     FROM public.campaigns c JOIN public.campaign_recipients r ON r.campaign_id = c.id
--    GROUP BY c.id
--   HAVING c.delivered_count < count(*) FILTER (WHERE r.status IN ('delivered','read'))
--       OR c.read_count < count(*) FILTER (WHERE r.status = 'read');
