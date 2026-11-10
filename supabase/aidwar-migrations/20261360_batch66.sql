-- Batch 66: a workspace's default country code for phone numbers typed or
-- sent without one. Idempotent and additive. NOT applied: apply by hand to
-- the Mumbai project, after 20261350_batch63.sql. Applying it twice changes
-- nothing the second time (batch66-sql.test.ts applies it twice to a
-- throwaway Postgres). No data changes: every workspace reads '91' (the
-- column default), and no contact or message is touched.
--
-- organizations.default_country_code text NOT NULL DEFAULT '91'
-- CHECK (^[1-9][0-9]{0,3}$): E.164's calling code without "+". Read by the
-- one phone rule (enteredPhone, src/lib/phone.ts) for a 10-digit number (or
-- a trunk 0 + 10 digits) in the contact import, Add contact, the Settings
-- default copy numbers and every Public API phone; shown read-only in
-- Settings > Workspace. Never read by the inbound or status webhooks (Meta's
-- wa_id always has its country code). Members read it with the rest of the
-- organizations row (RLS unchanged); nothing writes it in Batch 66.
-- The code works without this column: a read that answers 42703 / PGRST204
-- is "91" (default-country.ts; batch66-phone.test.ts).

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS default_country_code text NOT NULL DEFAULT '91';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.organizations'::regclass
       AND conname = 'organizations_default_country_code_check'
  ) THEN
    ALTER TABLE public.organizations
      ADD CONSTRAINT organizations_default_country_code_check
      CHECK (default_country_code ~ '^[1-9][0-9]{0,3}$');
  END IF;
END $$;

COMMENT ON COLUMN public.organizations.default_country_code IS
  'Batch 66: calling code without + (e.g. 91) added to a 10-digit phone number typed, imported or sent through the API without one (enteredPhone, src/lib/phone.ts). Never used for webhook numbers.';

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
