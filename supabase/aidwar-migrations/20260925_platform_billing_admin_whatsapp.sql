-- One agreed place for the platform owner's billing WhatsApp number, so every
-- audience=admin notice (float_low, topup_due, topup_reminder) resolves the
-- same recipient instead of depending on an environment variable.
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS billing_admin_whatsapp text;
