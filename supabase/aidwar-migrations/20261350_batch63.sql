-- Batch 63: plan-safe feature switches, "Not on WhatsApp", the template Sent report.
-- Idempotent and additive. NOT applied: apply by hand to the Mumbai project,
-- after 20261340_batch62.sql. Applying it twice changes nothing the second
-- time (batch63-sql.test.ts applies it twice to a throwaway Postgres).
-- Nothing is set for any workspace: every existing override row reads
-- 'plan' (the column default) and every contact is unmarked (NULL). The
-- one-time backfill for (1) is scripts/batch63-override-backfill.sql — a
-- separate file, NOT part of this migration, NOT applied.
--
-- (1) organization_feature_overrides.source text NOT NULL DEFAULT 'plan'
--     CHECK (source IN ('plan','manual')): who owns the switch. 'manual' =
--     a person set it (Super Admin's switches through
--     /api/admin/feature-overrides, the workspace's AI-assistants switch);
--     the plan sync (applyPlanFeatures: assign_plan, a trial reset,
--     resync_plan_features) never writes a 'manual' row, and "Reset to plan"
--     sets it back to 'plan'. The trigger trg_org_plan_assigned_billing_on
--     (billing = on with a plan) is unchanged.
--     The code works without this column: reads fall back to the old
--     columns (42703 / PGRST204), writes retry without `source`, and
--     limits_override._manual_flags (Batch 18, now also written by every
--     Super Admin switch) still keeps a hand-set feature through plan
--     changes (feature-ownership.server.ts; batch63-plan-overrides.test.ts).
--
-- (2) contacts.wa_unreachable jsonb (NULL = fine): "Not on WhatsApp" —
--     { since, last_at, code, reason, template, message_id, failures },
--     written only by the status webhook (noteSendStatus,
--     wa-reachability.server.ts): a template that failed with Meta 131026 /
--     1013 sets it, a delivered/read message clears it. Members read it with
--     the rest of the contact (RLS unchanged). It never stops a send; the
--     Public API's 202 adds warning "number_not_on_whatsapp_recently" while
--     it is under 30 days old.
--     The code works without this column: every read and write of it is
--     skipped on 42703 / PGRST204 (no badge, no warning, nothing marked).
--
-- (3) messages_template_sends_idx: the template Sent report and Home's
--     "Needs attention" count read outbound template messages by workspace,
--     template name and time (template-sends-data.ts). Partial, so only
--     outbound template rows are indexed. Without it the reads still work
--     (slower on a big workspace).

-- ------------------------------------------------ (1) who owns a switch
ALTER TABLE public.organization_feature_overrides
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'plan';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.organization_feature_overrides'::regclass
       AND conname = 'organization_feature_overrides_source_check'
  ) THEN
    ALTER TABLE public.organization_feature_overrides
      ADD CONSTRAINT organization_feature_overrides_source_check CHECK (source IN ('plan', 'manual'));
  END IF;
END $$;

COMMENT ON COLUMN public.organization_feature_overrides.source IS
  'Batch 63: plan = written by the plan sync (applyPlanFeatures); manual = a person set it (kept on every plan change until "Reset to plan").';

-- ------------------------------------------------ (2) Not on WhatsApp
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS wa_unreachable jsonb;

COMMENT ON COLUMN public.contacts.wa_unreachable IS
  'Batch 63: set when WhatsApp says this number can''t receive (a template failed with 131026 / 1013), cleared by the next delivered message. Written only by the status webhook. Never blocks a send.';

-- ------------------------------------------------ (3) the Sent report
CREATE INDEX IF NOT EXISTS messages_template_sends_idx
  ON public.messages (organization_id, template_name, created_at DESC)
  WHERE direction = 'outbound' AND type = 'template';

SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
