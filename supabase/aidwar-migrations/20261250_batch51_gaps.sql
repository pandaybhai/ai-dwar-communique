-- Batch 51: the gaps found while building the new design (Batches 44 to 50).
-- Idempotent and additive only: new nullable columns, new tables with RLS
-- policies that mirror the existing org-scoped ones, and two registry arrays
-- extended. NOT applied: apply by hand to the Mumbai project
-- (hcsacmqzspnfqoftoifu).
--
-- The code works without this file, and each part says how:
--   (1) message_templates.deleted_at — without it a template deleted from the
--       new gallery shows there as Paused (the status Meta's DELETED notice
--       sets, which is written either way), as one deleted in WhatsApp
--       Manager does today. The write of deleted_at is its own update and a
--       failure is only logged.
--
-- Rollback (nothing else depends on these):
--   ALTER TABLE public.message_templates DROP COLUMN IF EXISTS deleted_at;

SET lock_timeout = '5s';

-- (1) ------------------------------------------------- deleted templates
-- Set by deleteMessageTemplate (src/lib/template-delete.server.ts) once Meta
-- has deleted the template; the new gallery hides a row with deleted_at whose
-- status is still the DELETED mark (isDeletedTemplate). Sync never writes it.
ALTER TABLE public.message_templates ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- The templates feature lists the new activity (as scripts/sync-feature-registry.ts
-- writes the manifest).
UPDATE public.feature_registry
SET activity_actions = (
  SELECT array_agg(DISTINCT a ORDER BY a)
  FROM unnest(activity_actions || array['template_deleted']::text[]) AS a
)
WHERE key = 'templates'
  AND NOT (activity_actions @> array['template_deleted']::text[]);
