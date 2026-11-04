-- Batch 63 (A): one-time backfill of organization_feature_overrides.source.
-- NOT APPLIED. NOT part of 20261350_batch63.sql. Run by hand, once, after
-- 20261350 is applied, only if the founder agrees with the list it prints.
--
-- Step 1 is read-only: it lists every row this backfill would mark 'manual'
-- and why. Step 2 (commented out) writes them. Nothing else changes; every
-- other row stays 'plan' (the column default).
--
-- A row becomes 'manual' when a person decided it, as far as the database
-- can still tell:
--   (a) the feature is in organization_billing_settings.limits_override
--       ._manual_flags (Batch 18's record, written by Super Admin's
--       set_feature / setFeatureOverride), matched by registry key or flag
--       key (registry key -> flag key below: ai -> ai_features,
--       catalog -> catalogs, mcp -> mcp_access; others are equal); or
--   (b) the activity log has a by-hand change of that switch for that
--       workspace: mcp_access_changed (the workspace's own AI-assistants
--       switch, Batch 53), feature_override_set (Batch 63's route, if the
--       app ran before this backfill).
-- Super Admin > Flags and the workspace Features sheet used to write rows
-- straight from the browser and left no activity line, so a switch flipped
-- there before Batch 63 can't be recognised: re-set it once by hand (Zoori:
-- Shopify off, Catalogs off, new_design on, aiden_workspace on,
-- mcp_access on) and it is 'manual' from then on.

-- ---- Step 1 (read-only): what would change
WITH manual_flags AS (
  SELECT s.organization_id,
         CASE k.key
           WHEN 'ai' THEN 'ai_features'
           WHEN 'catalog' THEN 'catalogs'
           WHEN 'mcp' THEN 'mcp_access'
           ELSE k.key
         END AS flag_key,
         'limits_override._manual_flags' AS why
    FROM public.organization_billing_settings s
    CROSS JOIN LATERAL jsonb_object_keys(coalesce(s.limits_override -> '_manual_flags', '{}'::jsonb)) AS k(key)
), logged AS (
  SELECT DISTINCT a.organization_id,
         CASE a.action WHEN 'mcp_access_changed' THEN 'mcp_access' ELSE a.details ->> 'flag_key' END AS flag_key,
         'activity_log.' || a.action AS why
    FROM public.activity_log a
   WHERE a.action IN ('mcp_access_changed', 'feature_override_set')
), candidates AS (
  SELECT * FROM manual_flags
  UNION
  SELECT * FROM logged WHERE flag_key IS NOT NULL
)
SELECT o.organization_id, org.name AS workspace, o.flag_key, o.enabled, o.source AS source_now,
       string_agg(DISTINCT c.why, ', ') AS why
  FROM public.organization_feature_overrides o
  JOIN candidates c ON c.organization_id = o.organization_id AND c.flag_key = o.flag_key
  JOIN public.organizations org ON org.id = o.organization_id
 WHERE o.source <> 'manual'
 GROUP BY o.organization_id, org.name, o.flag_key, o.enabled, o.source
 ORDER BY org.name, o.flag_key;

-- ---- Step 2 (writes): uncomment to apply, after reading Step 1's list.
-- WITH manual_flags AS (
--   SELECT s.organization_id,
--          CASE k.key WHEN 'ai' THEN 'ai_features' WHEN 'catalog' THEN 'catalogs' WHEN 'mcp' THEN 'mcp_access' ELSE k.key END AS flag_key
--     FROM public.organization_billing_settings s
--     CROSS JOIN LATERAL jsonb_object_keys(coalesce(s.limits_override -> '_manual_flags', '{}'::jsonb)) AS k(key)
-- ), logged AS (
--   SELECT DISTINCT a.organization_id,
--          CASE a.action WHEN 'mcp_access_changed' THEN 'mcp_access' ELSE a.details ->> 'flag_key' END AS flag_key
--     FROM public.activity_log a
--    WHERE a.action IN ('mcp_access_changed', 'feature_override_set')
-- )
-- UPDATE public.organization_feature_overrides o
--    SET source = 'manual', updated_at = now()
--   FROM (SELECT * FROM manual_flags UNION SELECT * FROM logged WHERE flag_key IS NOT NULL) c
--  WHERE c.organization_id = o.organization_id
--    AND c.flag_key = o.flag_key
--    AND o.source <> 'manual';
