-- Batch 17 (5): a per-workspace daily cap on website-reading AI spend.
-- Idempotent. Apply by hand to the Mumbai project (hcsacmqzspnfqoftoifu); do not auto-apply.
--
-- Found (7 Oct health check, re-verified live): "Growth plan" ran extract_facts
-- 773 times for 57 distinct page texts on 1 Oct (₹534); "Meezoy ventures" 272
-- times for 53 on 2 Oct (₹135). Neither has a WhatsApp number and both have
-- Aiden off. The code now turns a page into facts at most once per text, and
-- stops the facts step for the day once a workspace's reading AI spend
-- (ai_usage: knowledge_facts + knowledge_image + embedding, today) reaches
-- this cap — logged as reading_ai_cap_hit. Pages are still read and saved.
--
-- ₹ per workspace per day; 0 = no cap. Until this is applied the code uses
-- the same default (reading.server.ts READING_AI_DAILY_CAP_DEFAULT).

SET lock_timeout = '5s';

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS reading_ai_daily_cap numeric NOT NULL DEFAULT 100
    CHECK (reading_ai_daily_cap >= 0);

RESET lock_timeout;
