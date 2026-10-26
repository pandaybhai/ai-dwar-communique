-- Batch 28 item 2 (NOT applied; apply by hand): AI cost leak on knowledge.
-- Idempotent.
--
-- Found: on 1 Oct extract_facts ran 818 times for 69 distinct inputs (~12x
-- each), on 2 Oct 279 runs for 60 — ~Rs 700 of provider cost, unbilled,
-- mostly test workspaces. Batch 17's guards (facts once per page text within
-- one source; the Rs reading cap, 20261033) didn't hold: the reuse only found
-- facts that had been long enough to keep, only inside the same source, and
-- the Rs cap counts metered cost, which a run without a known cost never
-- adds to. Batch 28:
--
--   (a) facts are never asked for again for a page text that already had a
--       successful extract_facts run in the workspace (any source, any
--       address): the run now carries metadata.page_hash and the reader looks
--       for it first (priorFactsRun, knowledge.server.ts). The index below
--       keeps that lookup cheap.
--   (b) a per-workspace daily cap on background AI runs, counted from ai_runs
--       (extract_facts, summarise, auto_tag; any status), stops the facts
--       step and the behaviour suggested after a read for the day and is
--       logged once (activity_log background_ai_cap_hit). Pages are still
--       read and saved. Count per workspace per UTC day; 0 = no cap. Until
--       this is applied the code uses the same default
--       (reading.server.ts BACKGROUND_AI_DAILY_CAP_DEFAULT = 300).
--   (c) is code only (a day-one read stays on the merchant's own page).

SET lock_timeout = '5s';

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS background_ai_daily_cap integer NOT NULL DEFAULT 300
    CHECK (background_ai_daily_cap >= 0);

CREATE INDEX IF NOT EXISTS ai_runs_facts_page_hash_idx
  ON public.ai_runs (organization_id, ((metadata ->> 'page_hash')))
  WHERE task = 'extract_facts' AND status = 'ok';

RESET lock_timeout;

-- Read-only checks once applied:
--   select background_ai_daily_cap from public.platform_settings;               -- 300
--   select indexname from pg_indexes where schemaname = 'public'
--      and indexname = 'ai_runs_facts_page_hash_idx';                          -- 1 row
--   -- (a) working: no page text run twice since the deploy (expect 0 rows)
--   select organization_id, metadata->>'page_hash', count(*)
--     from public.ai_runs
--    where task = 'extract_facts' and status = 'ok' and metadata ? 'page_hash'
--    group by 1, 2 having count(*) > 1;
