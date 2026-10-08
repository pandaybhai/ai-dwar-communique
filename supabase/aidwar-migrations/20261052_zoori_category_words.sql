-- Batch 20 (NOT applied): Zoori's own category words and website reader
-- rules, moved out of shared code.
--
-- Until Batch 20, Aiden's product search and the flows "Show products" step
-- carried a fixed jewellery word list (anguthi/band -> rings, jhumka/stud/bali
-- -> earrings, set/haar -> necklaces, mangalsutra -> tanmaniya, ...) and the
-- website reader turned Zoori's item codes (ZLRG, ZERN, ZTNM, ...) and shelf
-- words (ring, bangle, chain, ...) into categories for every workspace.
-- Shared code now has no product words: a shelf is one of the workspace's
-- own categories, plus the words its own settings give for one. This saves
-- exactly the former words for the one workspace they were written for, so
-- Zoori's search and re-reads behave as before:
--
--   organizations.branding.category_words   { category: [words] }
--     (editable by the merchant: Products -> "Words your customers use")
--   knowledge_sources.config.category_rules [ { match, category } ]
--     (Zoori's website source; "ZPND*" = a word starting ZPND, "stud" =
--      the whole word, plural included; first match in this order wins)
--
-- Same values as src/lib/test-support/zoori-replay.ts (CATEGORY_WORDS,
-- READER_RULES), which the replays run with. One difference by design: the
-- reader's old code rule also matched Z<letter>LRG; only ZLRG and ZGRG
-- exist in Zoori's catalogue.
--
-- Never overwrites: each value is set only when its key is absent, so the
-- merchant's own later edits are kept. Idempotent. Org 81c234b2 (Zoori).

SET lock_timeout = '5s';

UPDATE public.organizations
SET branding = coalesce(branding, '{}'::jsonb)
  || jsonb_build_object('category_words', '{"tanmaniya": ["mangalsutra", "mangal sutra", "tanmania"], "pendants": ["pendent", "locket"], "earrings": ["ear ring", "jhumka", "jhumki", "stud", "bali"], "bracelets": ["kada", "kadha"], "necklaces": ["haar", "set"], "rings": ["anguthi", "band"]}'::jsonb)
WHERE id = '81c234b2-569f-40be-ad71-96c046de5d12'
  AND NOT (coalesce(branding, '{}'::jsonb) ? 'category_words');

UPDATE public.knowledge_sources
SET config = coalesce(config, '{}'::jsonb)
  || jsonb_build_object('category_rules', '[{"match": "ZLRG*", "category": "rings"}, {"match": "ZGRG*", "category": "rings"}, {"match": "ZPND*", "category": "pendants"}, {"match": "ZBSL*", "category": "bracelets"}, {"match": "ZTNM*", "category": "tanmaniya"}, {"match": "ZERG*", "category": "earrings"}, {"match": "ZERN*", "category": "earrings"}, {"match": "ZNCK*", "category": "necklaces"}, {"match": "ZNEK*", "category": "necklaces"}, {"match": "tanmaniya*", "category": "tanmaniya"}, {"match": "tanmania*", "category": "tanmaniya"}, {"match": "mangalsutra*", "category": "tanmaniya"}, {"match": "ear ring*", "category": "earrings"}, {"match": "necklace*", "category": "necklaces"}, {"match": "pendant*", "category": "pendants"}, {"match": "pendent*", "category": "pendants"}, {"match": "bracelet*", "category": "bracelets"}, {"match": "bangle*", "category": "bracelets"}, {"match": "chain*", "category": "chains"}, {"match": "ring*", "category": "rings"}, {"match": "stud", "category": "earrings"}, {"match": "drops", "category": "earrings"}, {"match": "dangler", "category": "earrings"}, {"match": "jhumk*", "category": "earrings"}, {"match": "hoop", "category": "earrings"}]'::jsonb)
WHERE organization_id = '81c234b2-569f-40be-ad71-96c046de5d12'
  AND type = 'website'
  AND NOT (coalesce(config, '{}'::jsonb) ? 'category_rules');
