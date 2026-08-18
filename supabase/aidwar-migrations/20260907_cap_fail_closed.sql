-- A spending ceiling of zero used to mean "no ceiling", which is the exact
-- exposure a ceiling exists to prevent. From here a cap must be a real
-- positive number; a missing or nonsensical one stops runs instead of
-- letting them through.

-- Platform-wide ceiling.
UPDATE public.platform_settings
   SET ai_monthly_cap_amount = 25000
 WHERE ai_monthly_cap_amount IS NULL
    OR ai_monthly_cap_amount <= 0;

ALTER TABLE public.platform_settings
  ALTER COLUMN ai_monthly_cap_amount SET DEFAULT 25000,
  ALTER COLUMN ai_monthly_cap_amount SET NOT NULL;

ALTER TABLE public.platform_settings
  DROP CONSTRAINT IF EXISTS platform_settings_cap_positive;
ALTER TABLE public.platform_settings
  ADD CONSTRAINT platform_settings_cap_positive
  CHECK (ai_monthly_cap_amount > 0);

-- Per-merchant ceiling, same rule.
UPDATE public.organization_ai_settings
   SET ai_monthly_cap_amount = 500
 WHERE ai_monthly_cap_amount IS NULL
    OR ai_monthly_cap_amount <= 0;

ALTER TABLE public.organization_ai_settings
  ALTER COLUMN ai_monthly_cap_amount SET DEFAULT 500,
  ALTER COLUMN ai_monthly_cap_amount SET NOT NULL;

ALTER TABLE public.organization_ai_settings
  DROP CONSTRAINT IF EXISTS organization_ai_settings_cap_positive;
ALTER TABLE public.organization_ai_settings
  ADD CONSTRAINT organization_ai_settings_cap_positive
  CHECK (ai_monthly_cap_amount > 0);
