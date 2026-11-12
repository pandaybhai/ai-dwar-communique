-- Batch 72 (NOT applied): leads from the /start ad landing page.
--
-- /start asks only for a WhatsApp number (and a name, which the sticky bar
-- leaves to sign-up). public.demo_leads (20260915) requires the /demo form's
-- qualification answers, so a /start lead could not be saved without making
-- answers up. This lets exactly those five columns be NULL for rows whose
-- source is 'landing_start' — every other row (the /demo form, source
-- 'landing') must still carry all five, as before. The existing CHECKs on
-- enquiry_band / primary_need are untouched (a NULL passes a CHECK).
--
-- Additive and idempotent: drops NOT NULL on five columns and adds one CHECK
-- that puts the old rule back for every source but 'landing_start'. Existing
-- rows already satisfy it (they all have the five values). No data changes.

ALTER TABLE public.demo_leads ALTER COLUMN business_type DROP NOT NULL;
ALTER TABLE public.demo_leads ALTER COLUMN enquiry_band DROP NOT NULL;
ALTER TABLE public.demo_leads ALTER COLUMN primary_need DROP NOT NULL;
ALTER TABLE public.demo_leads ALTER COLUMN name DROP NOT NULL;
ALTER TABLE public.demo_leads ALTER COLUMN business_name DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'demo_leads_qualified_unless_landing_start'
       AND conrelid = 'public.demo_leads'::regclass
  ) THEN
    ALTER TABLE public.demo_leads
      ADD CONSTRAINT demo_leads_qualified_unless_landing_start CHECK (
        source = 'landing_start'
        OR (
          business_type IS NOT NULL
          AND enquiry_band IS NOT NULL
          AND primary_need IS NOT NULL
          AND name IS NOT NULL
          AND business_name IS NOT NULL
        )
      );
  END IF;
END
$$;

-- Batch 52/56: keep AI-app (OAuth) tokens away from every RLS table.
SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
