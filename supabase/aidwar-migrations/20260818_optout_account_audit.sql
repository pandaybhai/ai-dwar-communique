-- Audit trail: which connected number an opt-out / opt-in keyword arrived on.
-- The block itself stays organization-wide — STOP to one number stops all.
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS opt_status_account_id uuid
  REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.contacts.opt_status_account_id IS
  'Audit only: connected number the last opt-out/opt-in keyword arrived on. Opt-out is enforced organization-wide.';
