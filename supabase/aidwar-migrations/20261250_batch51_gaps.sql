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
--   (3) contact_notes — without it the drawer's Notes block says notes
--       aren't switched on yet and offers no box.
--
-- Rollback (nothing else depends on these):
--   ALTER TABLE public.message_templates DROP COLUMN IF EXISTS deleted_at;
--   DROP TABLE IF EXISTS public.segment_members;  -- hand-picked segments then match nobody
--   DROP TABLE IF EXISTS public.contact_notes;

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
-- everyone. RLS mirrors public.segments as 20260816 left it: contacts.view
-- reads, segments.manage adds and removes (rows also go with their segment,
-- ON DELETE CASCADE).
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
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'contacts.view'));
-- The segment and the customer must both be this workspace's.
DROP POLICY IF EXISTS "segment_members_insert_permitted" ON public.segment_members;
CREATE POLICY "segment_members_insert_permitted" ON public.segment_members
  FOR INSERT TO authenticated WITH CHECK (
    public.has_permission(organization_id, 'segments.manage')
    AND EXISTS (SELECT 1 FROM public.segments s
                 WHERE s.id = segment_members.segment_id AND s.organization_id = segment_members.organization_id)
    AND EXISTS (SELECT 1 FROM public.contacts c
                 WHERE c.id = segment_members.contact_id AND c.organization_id = segment_members.organization_id)
  );
DROP POLICY IF EXISTS "segment_members_delete_permitted" ON public.segment_members;
CREATE POLICY "segment_members_delete_permitted" ON public.segment_members
  FOR DELETE TO authenticated USING (public.has_permission(organization_id, 'segments.manage'));

-- (3) ------------------------------------------------- notes on a customer
-- The customer drawer's Notes block (new design): who wrote it and when.
-- Read with contacts.view; written by a teammate who may edit contacts or
-- reply to customers (contacts.edit or inbox.reply), always as themselves;
-- a note can be deleted only by the person who wrote it. Notes are never
-- edited. Aiden does not read them (no context slot exists; proposed, not
-- built). Without this table the drawer shows that notes aren't switched on
-- yet and offers no box.
CREATE TABLE IF NOT EXISTS public.contact_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  author_id uuid DEFAULT auth.uid(),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, DELETE ON public.contact_notes TO authenticated;
GRANT ALL ON public.contact_notes TO service_role;
ALTER TABLE public.contact_notes ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS contact_notes_contact_idx
  ON public.contact_notes (organization_id, contact_id, created_at DESC);

DROP POLICY IF EXISTS "contact_notes_select_members" ON public.contact_notes;
CREATE POLICY "contact_notes_select_members" ON public.contact_notes
  FOR SELECT TO authenticated USING (public.has_permission(organization_id, 'contacts.view'));
DROP POLICY IF EXISTS "contact_notes_insert_permitted" ON public.contact_notes;
CREATE POLICY "contact_notes_insert_permitted" ON public.contact_notes
  FOR INSERT TO authenticated WITH CHECK (
    (public.has_permission(organization_id, 'contacts.edit')
      OR public.has_permission(organization_id, 'inbox.reply'))
    AND author_id = auth.uid()
    AND EXISTS (SELECT 1 FROM public.contacts c
                 WHERE c.id = contact_notes.contact_id AND c.organization_id = contact_notes.organization_id)
  );
DROP POLICY IF EXISTS "contact_notes_delete_own" ON public.contact_notes;
CREATE POLICY "contact_notes_delete_own" ON public.contact_notes
  FOR DELETE TO authenticated USING (
    author_id = auth.uid() AND public.has_permission(organization_id, 'contacts.view')
  );

-- The contacts feature lists the new activity and table.
UPDATE public.feature_registry
SET activity_actions = (
  SELECT array_agg(DISTINCT a ORDER BY a)
  FROM unnest(activity_actions || array['contact_note_added', 'contact_note_deleted']::text[]) AS a
)
WHERE key = 'contacts'
  AND NOT (activity_actions @> array['contact_note_added', 'contact_note_deleted']::text[]);
UPDATE public.feature_registry
SET data_tables = (
  SELECT array_agg(DISTINCT t ORDER BY t)
  FROM unnest(data_tables || array['contact_notes', 'segment_members']::text[]) AS t
)
WHERE key = 'contacts'
  AND NOT (data_tables @> array['contact_notes', 'segment_members']::text[]);
