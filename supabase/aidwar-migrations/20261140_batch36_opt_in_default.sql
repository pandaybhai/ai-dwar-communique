-- Batch 36: opted in by default on upload — the consent record.
--
-- Who/when/how a contact came to be opted in, written by the contacts import,
-- "Add contact", the contact drawer and the Contacts list's bulk actions
-- (src/lib/opt-in.server.ts). Both columns are new and nullable: no existing
-- row, default or constraint changes (opt_in_status keeps its CHECK and its
-- 'unknown' default). opt_in_source values: 'import' | 'manual' | 'bulk' |
-- 'keyword'; deliberately no CHECK, so a later path can't fail a write.
--
-- The code works without this file: every write retries without the two
-- columns when PostgREST answers PGRST204 (batch36-opt-in.test.ts), and the
-- activity log keeps who/when/how either way.
--
-- Idempotent: safe to run more than once. NOT applied by this PR.

SET lock_timeout = '5s';

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS opt_in_source text;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS opted_in_at timestamptz;

COMMENT ON COLUMN public.contacts.opt_in_source IS
  'How the contact was opted in: import | manual | bulk | keyword. Null = not recorded (before Batch 36, or not opted in).';
COMMENT ON COLUMN public.contacts.opted_in_at IS
  'When the contact was opted in by import / manual / bulk (Batch 36). Null = not recorded.';

-- The bulk "Mark as opted in" activity action, listed on the contacts row.
UPDATE public.feature_registry
   SET activity_actions = coalesce(activity_actions, '{}'::text[]) || ARRAY(
         SELECT a FROM unnest(array['contacts_opted_in','contacts_import_consent']::text[]) AS a
          WHERE NOT (a = ANY (coalesce(activity_actions, '{}'::text[])))
       ),
       synced_at = now()
 WHERE key = 'contacts'
   AND NOT (coalesce(activity_actions, '{}'::text[]) @> array['contacts_opted_in','contacts_import_consent']::text[]);
