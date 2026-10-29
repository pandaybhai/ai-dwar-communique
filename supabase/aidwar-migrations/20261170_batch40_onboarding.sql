-- Batch 40: onboarding that converts. Idempotent. NOT applied: apply by hand
-- to the Mumbai project (hcsacmqzspnfqoftoifu).
--
-- Only additions: no column, default, constraint or row of existing data
-- changes, and nothing is narrowed.
--
-- Before this file is applied (tested in batch40-onboarding.test.ts): the
-- funnel works exactly as written — recordFunnelStep looks for the step
-- before writing it, so each step is recorded once per workspace; the only
-- thing missing is the guarantee under a race (two tabs recording the same
-- step in the same instant could both write; the admin funnel counts
-- workspaces, not rows, so its numbers don't change).
--
-- (1) analytics_events: one onboarding.<step> row per workspace — a unique
--     index on (organization_id, event_type) for the onboarding.* events
--     only (no other event is touched; none of these existed before Batch 40).
-- (2) the settings feature_registry row lists the journey's event types and
--     its activity action (as scripts/sync-feature-registry.ts writes them
--     for the manifest).

-- Applying it: run the duplicate check (scripts/batch40-checks.sql, query 1)
-- first — it must return no rows, or the unique index can't be built (only
-- possible if two tabs recorded the same step in the same instant before
-- this file; keep the earliest row of each pair). The index build reads
-- analytics_events once and holds its writes meanwhile (the partial index
-- itself is tiny): apply in a quiet hour. lock_timeout stops it waiting
-- behind a long write instead of queueing everyone behind it.

SET lock_timeout = '5s';

-- (1) ------------------------------------------------------- once per step
CREATE UNIQUE INDEX IF NOT EXISTS analytics_events_onboarding_once
  ON public.analytics_events (organization_id, event_type)
  WHERE event_type LIKE 'onboarding.%';

-- (2) ------------------------------------------------------- registry
UPDATE public.feature_registry
SET activity_actions = (
  SELECT array_agg(DISTINCT a ORDER BY a)
  FROM unnest(activity_actions || array['onboarding_callback_requested']::text[]) AS a
)
WHERE key = 'settings'
  AND NOT (activity_actions @> array['onboarding_callback_requested']::text[]);

UPDATE public.feature_registry
SET analytics = jsonb_set(
  coalesce(analytics, '{}'::jsonb),
  '{event_types}',
  (
    SELECT coalesce(jsonb_agg(DISTINCT e ORDER BY e), '[]'::jsonb)
    FROM (
      SELECT jsonb_array_elements_text(coalesce(analytics -> 'event_types', '[]'::jsonb)) AS e
      UNION
      SELECT unnest(array[
        'onboarding.started', 'onboarding.website_read', 'onboarding.connect_opened',
        'onboarding.connected', 'onboarding.aiden_tested', 'onboarding.went_live',
        'onboarding.connect_skipped', 'onboarding.dismissed', 'onboarding.callback_requested'
      ]::text[])
    ) all_events
  )
)
WHERE key = 'settings'
  AND NOT (coalesce(analytics -> 'event_types', '[]'::jsonb) ? 'onboarding.went_live');
