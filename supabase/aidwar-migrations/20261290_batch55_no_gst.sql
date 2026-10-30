-- Batch 55: bill WITHOUT GST until Meezoy Ventures is GST-registered.
-- Idempotent and additive. NOT applied: apply by hand to the Mumbai project.
-- Applying it twice changes nothing the second time (batch55-sql.test.ts
-- applies it twice to a throwaway Postgres).
--
-- (1) platform_settings.gst_registered boolean NOT NULL DEFAULT false: the one
--     switch. False = no GST is added anywhere (plan fees, credit packs,
--     payment links, Cashfree orders charge the base price exactly) and new
--     invoices are kind 'invoice' with no GST and no GSTIN. True = today's
--     18% GST behaviour, with the real supplier_gstin. Super Admin refuses
--     true while supplier_gstin is empty or the demo value; the CHECK below
--     says the same in the database.
--     The code works without this column: gst_registered reads as false
--     (no GST) until it exists (gstRegisteredFrom, src/lib/gst-mode.ts).
--
-- (2) The demo supplier identity goes: supplier_gstin 36AAACM0000D1Z5 and
--     supplier_pan AAACM0000D become NULL, and "[DEMO GSTIN ...]" is taken
--     out of invoice_footer (the rest of the footer stays). Invoices already
--     issued are NOT changed — Super Admin > Billing > GST lists them and
--     "Re-issue without GST" handles each one the founder picks.
--
-- (3) invoices.kind may be 'invoice' (a plain no-GST invoice): any CHECK on
--     invoices.kind that lists 'tax_invoice' is rebuilt with the same values
--     plus 'invoice'. Until this runs, a no-GST invoice is refused by that
--     check and buildInvoice says "apply 20261290"; payments and credits are
--     not affected, and the nightly backfill raises the invoice afterwards.
--
-- (4) One plan-fee 'invoice' per workspace per period, like
--     plan_fee_invoice_period_uidx (20261026) does for tax invoices.

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS gst_registered boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.platform_settings.gst_registered IS
  'Batch 55: true only once AiDwar is GST-registered and supplier_gstin is the real GSTIN. False = no GST charged, no GSTIN printed.';

-- (2) The demo values.
UPDATE public.platform_settings
   SET supplier_gstin = NULL
 WHERE upper(btrim(supplier_gstin)) = '36AAACM0000D1Z5';

UPDATE public.platform_settings
   SET supplier_pan = NULL
 WHERE upper(btrim(supplier_pan)) = 'AAACM0000D';

UPDATE public.platform_settings
   SET invoice_footer = NULLIF(
         btrim(regexp_replace(
           regexp_replace(invoice_footer, '\s*\[\s*DEMO\s+GSTIN[^\]]*\]\s*', ' ', 'gi'),
           '\s{2,}', ' ', 'g')),
         '')
 WHERE invoice_footer ~* '\[\s*DEMO\s+GSTIN';

-- (1) GST can't be on without a real GSTIN.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.platform_settings'::regclass
       AND conname = 'platform_settings_gst_needs_gstin'
  ) THEN
    ALTER TABLE public.platform_settings
      ADD CONSTRAINT platform_settings_gst_needs_gstin
      CHECK (
        NOT gst_registered
        OR (supplier_gstin IS NOT NULL
            AND btrim(supplier_gstin) <> ''
            AND upper(btrim(supplier_gstin)) <> '36AAACM0000D1Z5')
      );
  END IF;
END
$$;

-- (3) invoices.kind may be 'invoice'.
DO $$
DECLARE
  c record;
  kinds text[];
BEGIN
  FOR c IN
    SELECT conname, pg_get_constraintdef(oid) AS def
      FROM pg_constraint
     WHERE conrelid = 'public.invoices'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ~ '\mkind\M'
       AND pg_get_constraintdef(oid) ~ '''tax_invoice'''
  LOOP
    SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
      INTO kinds
      FROM regexp_matches(c.def, '''([a-z_]+)''', 'g') AS m;
    IF NOT ('invoice' = ANY (kinds)) THEN
      kinds := array_append(kinds, 'invoice');
      EXECUTE format('ALTER TABLE public.invoices DROP CONSTRAINT %I', c.conname);
      EXECUTE format(
        'ALTER TABLE public.invoices ADD CONSTRAINT %I CHECK (kind = ANY (%L::text[]))',
        c.conname,
        kinds
      );
    END IF;
  END LOOP;
END
$$;

-- (4) One no-GST plan-fee invoice per workspace per period.
CREATE UNIQUE INDEX IF NOT EXISTS plan_fee_nogst_invoice_period_uidx
  ON public.invoices (organization_id, period_start)
  WHERE purpose = 'plan_fee'
    AND kind = 'invoice'
    AND status <> 'void'
    AND period_start IS NOT NULL
    AND payment_id IS NULL;

-- Batch 52: keep AI-app (OAuth) tokens read-only on every RLS table.
SELECT public.mcp_block_oauth_writes();
