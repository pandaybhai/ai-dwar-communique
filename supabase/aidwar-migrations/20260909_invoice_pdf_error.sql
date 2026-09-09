-- A real column for the PDF failure reason, instead of hiding it in sent jsonb.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS pdf_error text;

UPDATE public.invoices
SET pdf_error = sent->>'pdf_error'
WHERE pdf_error IS NULL AND sent ? 'pdf_error';
