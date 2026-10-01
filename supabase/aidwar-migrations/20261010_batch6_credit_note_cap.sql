-- Batch 6 (GST). NOT APPLIED — review, then apply by hand. Idempotent: safe to
-- run more than once.
--
-- Credit notes may never add up to more than the invoice they credit.
-- issueCreditNote (src/lib/credit-notes.server.ts) already checks this in the
-- app, but the check reads the earlier notes and then inserts, so two
-- submissions at the same moment (a double click on "Issue credit note") can
-- both pass and credit — and refund to the wallet — twice. This trigger takes
-- a row lock on the invoice, so concurrent inserts for the same invoice are
-- serialised, and refuses any issued note that would take the issued total
-- past invoices.total.
--
-- Before this is applied the app's own check still runs, exactly as today.
-- After it is applied, a refused insert surfaces through the app's existing
-- "We couldn't record the credit note." error (the CN number drawn for it is
-- left unused, as with any other failed insert).

CREATE OR REPLACE FUNCTION public.credit_notes_within_invoice()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total numeric(12,2);
  v_credited numeric(12,2);
BEGIN
  IF NEW.status <> 'issued' THEN
    RETURN NEW;
  END IF;

  SELECT total INTO v_total
    FROM public.invoices
   WHERE id = NEW.invoice_id
   FOR UPDATE;

  IF v_total IS NULL THEN
    RAISE EXCEPTION 'credit note % has no invoice', NEW.number USING ERRCODE = '23503';
  END IF;

  SELECT COALESCE(SUM(amount), 0) INTO v_credited
    FROM public.credit_notes
   WHERE invoice_id = NEW.invoice_id
     AND status = 'issued'
     AND id <> NEW.id;

  IF v_credited + NEW.amount > v_total THEN
    RAISE EXCEPTION 'credit notes (% + %) would exceed invoice total %',
      v_credited, NEW.amount, v_total
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.credit_notes_within_invoice() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS credit_notes_within_invoice ON public.credit_notes;
CREATE TRIGGER credit_notes_within_invoice
  BEFORE INSERT OR UPDATE OF amount, status, invoice_id ON public.credit_notes
  FOR EACH ROW EXECUTE FUNCTION public.credit_notes_within_invoice();
