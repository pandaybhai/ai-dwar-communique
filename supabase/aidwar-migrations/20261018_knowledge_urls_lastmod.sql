-- Batch 13B (NOT applied): each website address keeps the date its sitemap
-- gives it (<lastmod>), so "Re-read whole site" re-reads only pages whose
-- date moved since they were last read. The scheduled weekly refresh is
-- unchanged and still re-reads every page.
--
-- Until this is applied the reader keeps working exactly as before: saving a
-- date is skipped and "Re-read whole site" re-reads every page (unchanged text
-- is still never re-embedded).
--
-- Idempotent; no data changed.

ALTER TABLE public.knowledge_urls
  ADD COLUMN IF NOT EXISTS lastmod timestamptz;
