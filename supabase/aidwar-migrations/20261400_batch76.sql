-- Batch 76 (NOT applied): a sales role for Leads & Demos, and WhatsApp alerts
-- for every new lead.
--
-- (1) profiles.is_sales — a sales member sees /admin/leads only (checked on
--     the server in /api/admin/leads; every other /api/admin/* route still
--     requires is_super_admin). Set only by the server or a super admin.
-- (2) platform_settings.lead_alert_numbers — who gets the new-lead alert
--     (E.164), seeded with Vinay's two numbers while it is still empty.
-- (3) demo_leads.alerted_at — when the alert went (claimed once per lead).
-- (4) The profiles guard now also keeps a user from raising their own
--     is_sales (UPDATE), and a client INSERT can never start with it set.
--     Same exemptions as before: the server roles and super admins.
--
-- Additive and idempotent. The only data change is the one-time seed in (2).

-- ------------------------------------------------------------- (1)-(3)
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_sales boolean NOT NULL DEFAULT false;
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS lead_alert_numbers text[] NOT NULL DEFAULT '{}';
UPDATE public.platform_settings
  SET lead_alert_numbers = ARRAY['+917981223192', '+919121883067']
  WHERE lead_alert_numbers = '{}';
ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS alerted_at timestamptz;

-- ------------------------------------------------------------- (4) guards
CREATE OR REPLACE FUNCTION public.protect_profile_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
begin
  -- Runs as the caller (not SECURITY DEFINER), so current_user is the real role.
  if current_user not in ('postgres', 'supabase_admin', 'service_role')
     and not public.is_super_admin() then
    new.is_super_admin := old.is_super_admin;
    -- Batch 76: nobody raises (or drops) their own sales access either.
    new.is_sales := old.is_sales;
    new.id := old.id;
    new.created_at := old.created_at;
  end if;
  return new;
end; $function$;

CREATE OR REPLACE FUNCTION public.protect_profile_insert_privileges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $function$
begin
  if current_user not in ('postgres', 'supabase_admin', 'service_role')
     and not public.is_super_admin() then
    new.is_super_admin := false;
    new.is_sales := false;
  end if;
  return new;
end; $function$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'protect_profile_privileges' AND tgrelid = 'public.profiles'::regclass
  ) THEN
    CREATE TRIGGER protect_profile_privileges
      BEFORE UPDATE ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION public.protect_profile_privileges();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'protect_profile_insert_privileges' AND tgrelid = 'public.profiles'::regclass
  ) THEN
    CREATE TRIGGER protect_profile_insert_privileges
      BEFORE INSERT ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION public.protect_profile_insert_privileges();
  END IF;
END $$;

-- Batch 52 / 56: a migration ends by re-applying the AI-app token guards.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
