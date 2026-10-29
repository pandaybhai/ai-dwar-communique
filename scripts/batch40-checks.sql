-- Batch 40 (onboarding) — read-only checks. Every statement is a SELECT;
-- nothing here writes. Run in the Supabase SQL editor (Mumbai project).

-- 1. BEFORE applying 20261170: duplicate onboarding steps (must return no rows).
SELECT organization_id, event_type, count(*) AS rows
FROM public.analytics_events
WHERE event_type LIKE 'onboarding.%'
GROUP BY organization_id, event_type
HAVING count(*) > 1;

-- 2. AFTER applying 20261170: the once-per-step index exists (1 row).
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND indexname = 'analytics_events_onboarding_once';

-- 3. AFTER applying 20261170: the settings registry row lists the journey (both true).
SELECT key,
       'onboarding_callback_requested' = ANY (activity_actions) AS has_action,
       coalesce(analytics -> 'event_types', '[]'::jsonb) ? 'onboarding.went_live' AS has_events
FROM public.feature_registry
WHERE key = 'settings';

-- 4. AFTER deploy: the funnel, last 30 days (workspaces per step).
SELECT event_type, count(DISTINCT organization_id) AS workspaces
FROM public.analytics_events
WHERE event_type LIKE 'onboarding.%'
  AND occurred_at > now() - interval '30 days'
GROUP BY event_type
ORDER BY event_type;

-- 5. AFTER deploy: setup sessions by status, and how many recorded a connected number.
SELECT status, step, count(*) AS sessions,
       count(*) FILTER (WHERE connected_account_id IS NOT NULL) AS with_number
FROM public.onboarding_sessions
GROUP BY status, step
ORDER BY status, step;

-- 6. The nudge templates on the platform workspace (the link one must be APPROVED to be used).
SELECT name, language, status
FROM public.message_templates
WHERE name IN ('aidwar_onboarding_start', 'aidwar_onboarding_resume', 'aidwar_onboarding_resume_link')
ORDER BY name;

-- 7. "We'll call you" requests that reached the team.
SELECT created_at, organization_id, payload ->> 'headline' AS headline, payload ->> 'detail' AS detail
FROM public.billing_notifications
WHERE audience = 'admin' AND kind = 'onboarding_callback'
ORDER BY created_at DESC
LIMIT 20;

-- 8. Everything any migration expects (Batch 28's after-publish check):
--    run scripts/schema-parity.sql; it lists only what is missing.
