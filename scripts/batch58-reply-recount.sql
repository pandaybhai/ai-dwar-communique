-- Batch 58 item 5: which past campaigns' reply counts would change under the
-- new rule. READ-ONLY: one SELECT, nothing is written. Run it in the
-- Supabase SQL editor (or psql) and paste the result on the PR.
--
-- New rule (applyCampaignReply, whatsapp-webhook.server.ts): a reply counts
-- for a recipient only when
--   * its status is delivered or read, and
--   * the customer's message came after the campaign message was sent (the
--     recipient's messages row, campaign_recipients.message_id), within
--     7 days of that send.
-- replied_at was stamped when the customer's message was processed (seconds
-- after it arrived), so it stands in for the customer's message time.
--
-- Columns: the counter every screen shows today (campaigns.replied_count),
-- the recipients with replied_at today, and the count under the new rule.
-- Only campaigns whose number would change are listed.
WITH per_campaign AS (
  SELECT
    c.id,
    c.organization_id,
    o.name AS workspace,
    c.name AS campaign,
    c.created_at::date AS created_on,
    c.delivered_count,
    c.read_count,
    c.replied_count,
    count(r.id) FILTER (WHERE r.replied_at IS NOT NULL) AS replied_rows_now,
    count(r.id) FILTER (
      WHERE r.replied_at IS NOT NULL
        AND r.status IN ('delivered', 'read')
        AND m.created_at IS NOT NULL
        AND r.replied_at > m.created_at
        AND r.replied_at <= m.created_at + interval '7 days'
    ) AS replied_new_rule,
    count(r.id) FILTER (WHERE r.replied_at IS NOT NULL AND r.status NOT IN ('delivered', 'read')) AS dropped_not_delivered,
    count(r.id) FILTER (
      WHERE r.replied_at IS NOT NULL AND r.status IN ('delivered', 'read')
        AND (m.created_at IS NULL OR r.replied_at <= m.created_at)
    ) AS dropped_before_send_or_no_message,
    count(r.id) FILTER (
      WHERE r.replied_at IS NOT NULL AND r.status IN ('delivered', 'read')
        AND m.created_at IS NOT NULL AND r.replied_at > m.created_at + interval '7 days'
    ) AS dropped_after_window
  FROM public.campaigns c
  JOIN public.organizations o ON o.id = c.organization_id
  LEFT JOIN public.campaign_recipients r ON r.campaign_id = c.id
  LEFT JOIN public.messages m ON m.id = r.message_id
  GROUP BY c.id, o.name
)
SELECT *
FROM per_campaign
WHERE replied_new_rule <> replied_count OR replied_rows_now <> replied_count
ORDER BY created_on DESC, workspace, campaign;
