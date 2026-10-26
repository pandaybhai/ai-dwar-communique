-- Cashfree as a payment provider, alongside Razorpay during the cutover.
-- 1. payments, subscriptions and workspace_connections accept 'cashfree'.
-- 2. The cashfree_billing flag (default OFF) decides which provider takes a
--    workspace's NEW platform payments; Super Admin turns it on per
--    workspace after sandbox verification.

ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_provider_check;
ALTER TABLE public.payments ADD CONSTRAINT payments_provider_check
  CHECK (provider IN ('razorpay', 'manual', 'bank_transfer', 'cashfree'));

ALTER TABLE public.subscriptions DROP CONSTRAINT IF EXISTS subscriptions_provider_check;
ALTER TABLE public.subscriptions ADD CONSTRAINT subscriptions_provider_check
  CHECK (provider IN ('razorpay', 'manual', 'cashfree'));

ALTER TABLE public.workspace_connections DROP CONSTRAINT IF EXISTS workspace_connections_provider_check;
ALTER TABLE public.workspace_connections ADD CONSTRAINT workspace_connections_provider_check
  CHECK (provider IN ('google', 'razorpay', 'cashfree'));

INSERT INTO public.feature_flags (key, name, description, default_enabled)
VALUES (
  'cashfree_billing',
  'Cashfree billing',
  'Take this workspace''s new plan purchases, credit top-ups and auto-pay mandates through Cashfree instead of Razorpay.',
  false
)
ON CONFLICT (key) DO NOTHING;
