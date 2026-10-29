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
--   (2) segment_members — without it "Send campaign" in the Customers bulk
--       bar says hand-picked lists aren't switched on yet and saves nothing.
--
-- Rollback (nothing else depends on these):
--   ALTER TABLE public.message_templates DROP COLUMN IF EXISTS deleted_at;
--   DROP TABLE IF EXISTS public.segment_members;  -- hand-picked segments then match nobody

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

-- (2) ------------------------------------------- hand-picked segment lists
-- A segment can only hold rules (segments.filters). "Send campaign" from the
-- Customers bulk bar saves the ticked customers as a segment whose one rule
-- is { field: "list", value: <its own id> }; segmentExpressions
-- (src/lib/segments.server.ts) reads this table for that rule, so the campaign
-- wizard's audience, opt-in filter, estimate and launch read it like any
-- segment. Opted-out customers are never written here (saveHandPicked).
-- Without this table the bulk bar says the list isn't switched on yet and
-- saves nothing; a "list" rule that can't be read matches nobody, never
-- everyone. RLS mirrors public.segments: members read and add, admins delete
-- (rows also go with their segment, ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS public.segment_members (
  segment_id uuid NOT NULL REFERENCES public.segments(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  added_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (segment_id, contact_id)
);
GRANT SELECT, INSERT, DELETE ON public.segment_members TO authenticated;
GRANT ALL ON public.segment_members TO service_role;
ALTER TABLE public.segment_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS segment_members_org_segment_idx
  ON public.segment_members (organization_id, segment_id, contact_id);

DROP POLICY IF EXISTS "segment_members_select_members" ON public.segment_members;
CREATE POLICY "segment_members_select_members" ON public.segment_members
  FOR SELECT TO authenticated USING (public.is_org_member(organization_id));
-- The segment and the customer must both be this workspace's.
DROP POLICY IF EXISTS "segment_members_insert_members" ON public.segment_members;
CREATE POLICY "segment_members_insert_members" ON public.segment_members
  FOR INSERT TO authenticated WITH CHECK (
    public.is_org_member(organization_id)
    AND EXISTS (SELECT 1 FROM public.segments s
                 WHERE s.id = segment_members.segment_id AND s.organization_id = segment_members.organization_id)
    AND EXISTS (SELECT 1 FROM public.contacts c
                 WHERE c.id = segment_members.contact_id AND c.organization_id = segment_members.organization_id)
  );
DROP POLICY IF EXISTS "segment_members_delete_admins" ON public.segment_members;
CREATE POLICY "segment_members_delete_admins" ON public.segment_members
  FOR DELETE TO authenticated USING (public.has_org_role(organization_id, 'admin'));
