-- Embedded Signup: store the 6-digit two-step verification PIN we register with Meta.
ALTER TABLE public.whatsapp_credentials
  ADD COLUMN IF NOT EXISTS two_step_pin text;
