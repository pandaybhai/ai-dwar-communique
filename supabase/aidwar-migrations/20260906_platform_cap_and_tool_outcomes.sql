-- 1. "Not found" is not a failure.
--    Lookups that ran fine and found nothing were recorded as ok = false, which
--    fed the tool_failed escalation signal and overstated historical escalation.
UPDATE public.ai_tool_calls
SET ok = true
WHERE ok = false
  AND (
    error ILIKE 'No matching order%'
    OR error ILIKE 'No contact with that number%'
    OR error ILIKE 'I couldn''t find%'
  );

-- 4. Platform-wide monthly spend ceiling across every organisation.
ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS ai_monthly_cap_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_cap_currency text NOT NULL DEFAULT 'INR';

ALTER TABLE public.platform_settings
  DROP CONSTRAINT IF EXISTS platform_settings_ai_monthly_cap_amount_check;
ALTER TABLE public.platform_settings
  ADD CONSTRAINT platform_settings_ai_monthly_cap_amount_check
  CHECK (ai_monthly_cap_amount >= 0);

-- Total billed spend this calendar month, all organisations, Asia/Kolkata.
CREATE OR REPLACE FUNCTION public.platform_ai_month_spend()
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(billed_amount), 0)
  FROM public.ai_runs
  WHERE billed_amount IS NOT NULL
    AND created_at >= date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata'))
        AT TIME ZONE 'Asia/Kolkata';
$$;

REVOKE ALL ON FUNCTION public.platform_ai_month_spend() FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_ai_month_spend() TO service_role;
