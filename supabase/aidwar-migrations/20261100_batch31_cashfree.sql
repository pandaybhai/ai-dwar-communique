-- Batch 31: Cashfree as AiDwar's own payment gateway (plan fees, credit
-- top-ups, auto-pay). Idempotent. NOT applied: apply by hand to the Mumbai
-- project (hcsacmqzspnfqoftoifu).
--
-- Applying it changes nothing for any workspace: the cashfree_billing flag
-- is created OFF, and only a workspace with it switched on (an
-- organization_feature_overrides row, Super Admin -> Flags) takes NEW
-- payments through Cashfree. Everyone else stays on Razorpay byte for byte.
--
-- The code works without this file (tested in batch31-cashfree.test.ts):
-- paymentGateway() asks org_flag_enabled for 'cashfree_billing', and a flag
-- that doesn't exist yet is off = Razorpay; the unique index below is a
-- second guard, the code checks provider_payment_id first.
--
-- Reuses public.payments / public.subscriptions / public.webhook_events with
-- provider = 'cashfree'. No second payments table, no second ledger path: a
-- paid Cashfree order settles through settlePayment, so
-- wallet_ledger_payment_credit_once and plan_fee_invoice_period_uidx keep
-- guarding it. Nothing is migrated or deleted: the Razorpay rows, the one
-- active Razorpay mandate and the Razorpay webhook keep working until they end.
--
-- (1) the flag rows: feature_flags 'cashfree_billing' (default_enabled false),
--     its feature_registry row (feature 'cashfree_billing', no page, depends
--     on 'billing') and its one permission 'cashfree_billing.pay' (owner by
--     default, like billing.pay; checked only on the Cashfree path) — what
--     scripts/sync-feature-registry.ts writes for the manifest in
--     src/lib/feature-registry.ts. permissions_category_check, where it
--     exists, also allows the category 'cashfree_billing'.
-- (2) provider checks (only where one exists) also allow 'cashfree', keeping
--     every value already in the table.
-- (3) payments_cashfree_payment_once: one payments row per Cashfree payment
--     (cf_payment_id) — a mandate charge delivered twice at the same moment
--     is recorded once. Only provider 'cashfree' rows, of which there are
--     none yet, so the index builds on an empty set.
-- (4) payments_cashfree_pending_idx: the billing sweep's "unpaid Cashfree
--     orders of the last days" read.

SET lock_timeout = '5s';

-- (1) ------------------------------------------------------- flag rows
INSERT INTO public.feature_flags (key, name, description, default_enabled)
VALUES (
  'cashfree_billing',
  'Cashfree payments',
  'Take this workspace''s new payments (credits, plan fee, auto-pay) through Cashfree instead of Razorpay.',
  false
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description;

INSERT INTO public.feature_registry (
  key, name, description, icon, nav_path, nav_order, nav_permission, flag_key, settings_path,
  permissions, analytics, activity_actions, usage_meters, ai_tools, data_tables, depends_on, synced_at
) VALUES (
  'cashfree_billing', 'Cashfree payments',
  'Take this workspace''s new payments (credits, plan fee, auto-pay) through Cashfree instead of Razorpay.',
  'credit-card', null, null, null, 'cashfree_billing', null,
  '[{"key":"cashfree_billing.pay","name":"Pay through Cashfree","description":"Buy credits, pay the plan fee and set up auto-pay on Cashfree''s checkout.","min_role":"owner"}]'::jsonb,
  '{"event_types":[],"metrics":[],"dashboard_section":false}'::jsonb,
  array['payment_refunded']::text[], '[]'::jsonb, '[]'::jsonb, '{}'::text[], array['billing']::text[], now()
)
ON CONFLICT (key) DO UPDATE SET
  name = excluded.name, description = excluded.description, icon = excluded.icon,
  flag_key = excluded.flag_key, permissions = excluded.permissions, analytics = excluded.analytics,
  activity_actions = excluded.activity_actions, depends_on = excluded.depends_on,
  synced_at = now();

-- The permission's category is its feature key; a category check that
-- doesn't know it yet is rebuilt with every category already stored.
DO $$
DECLARE
  def text;
  allowed text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
  FROM pg_constraint
  WHERE conname = 'permissions_category_check' AND conrelid = 'public.permissions'::regclass;
  IF def IS NOT NULL AND position('cashfree_billing' IN def) = 0 THEN
    SELECT string_agg(quote_literal(c), ', ' ORDER BY c) INTO allowed
    FROM (
      SELECT DISTINCT category AS c FROM public.permissions WHERE category IS NOT NULL
      UNION SELECT key FROM public.feature_registry
      UNION SELECT 'cashfree_billing'
    ) s;
    ALTER TABLE public.permissions DROP CONSTRAINT permissions_category_check;
    EXECUTE format('ALTER TABLE public.permissions ADD CONSTRAINT permissions_category_check CHECK (category IN (%s))', allowed);
  END IF;
END $$;

INSERT INTO public.permissions (key, name, description, category, min_role)
VALUES (
  'cashfree_billing.pay', 'Pay through Cashfree',
  'Buy credits, pay the plan fee and set up auto-pay on Cashfree''s checkout.',
  'cashfree_billing', 'owner'
)
ON CONFLICT (key) DO UPDATE SET name = excluded.name, description = excluded.description,
  category = excluded.category, min_role = excluded.min_role;

INSERT INTO public.role_permissions (role, permission_key)
VALUES ('owner', 'cashfree_billing.pay')
ON CONFLICT DO NOTHING;

-- (2) ---------------------------------------------- provider checks widen
-- A CHECK on <table>.provider that doesn't name 'cashfree' is replaced by one
-- that allows every provider already stored plus razorpay, manual, cashfree.
DO $$
DECLARE
  t text;
  c record;
  allowed text;
BEGIN
  FOREACH t IN ARRAY ARRAY['payments', 'subscriptions', 'webhook_events'] LOOP
    FOR c IN
      SELECT con.conname, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_attribute att
        ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
      WHERE con.conrelid = format('public.%I', t)::regclass
        AND con.contype = 'c'
        AND att.attname = 'provider'
    LOOP
      IF position('cashfree' IN c.def) = 0 THEN
        EXECUTE format(
          'SELECT string_agg(quote_literal(v), %L ORDER BY v) FROM (
             SELECT DISTINCT provider AS v FROM public.%I WHERE provider IS NOT NULL
             UNION SELECT unnest(ARRAY[%L, %L, %L])
           ) s',
          ', ', t, 'razorpay', 'manual', 'cashfree'
        ) INTO allowed;
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, c.conname);
        EXECUTE format(
          'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK (provider IN (%s))',
          t, c.conname, allowed
        );
      END IF;
    END LOOP;
  END LOOP;
END $$;

-- (3) ------------------------------------------- one row per Cashfree payment
CREATE UNIQUE INDEX IF NOT EXISTS payments_cashfree_payment_once
  ON public.payments (provider_payment_id)
  WHERE provider = 'cashfree' AND provider_payment_id IS NOT NULL;

-- (4) ------------------------------------------------ the sweep's re-check
CREATE INDEX IF NOT EXISTS payments_cashfree_pending_idx
  ON public.payments (created_at DESC)
  WHERE provider = 'cashfree' AND status IN ('pending', 'failed');

RESET lock_timeout;
