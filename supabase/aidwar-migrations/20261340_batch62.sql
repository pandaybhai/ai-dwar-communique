-- Batch 62: the API invoice copy (cc) limit goes from 3 to 10.
-- Idempotent and additive. NOT applied: apply by hand to the Mumbai project,
-- after 20261330_batch61.sql. Applying it twice changes nothing the second
-- time (batch62-cc-limit.test.ts applies it twice to a throwaway Postgres).
-- Nothing is set for any workspace.
--
-- organizations_api_cc_numbers_check is dropped and re-added with the same
-- shape and a limit of 10: at most 10 numbers, no NULL entry, each "+" and
-- 8–15 digits (the app checks the same in src/lib/public-api-cc.ts, MAX_CC).
-- Every row 20261330's check allowed (≤ 3 numbers) still passes, so the
-- re-add never fails on existing data. The guard trigger
-- (trg_guard_api_cc_numbers / guard_api_cc_numbers) is unchanged: writes
-- stay server-only.
--
-- The code works without this file: until it is applied the database still
-- refuses more than 3 numbers, so Settings → API & webhooks shows "We couldn't
-- save the copy numbers" for a 4th–10th default number, and a request's own
-- `cc` (which is never stored) already takes up to 10.

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_api_cc_numbers_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_api_cc_numbers_check
  CHECK (
    cardinality(api_cc_numbers) <= 10
    AND array_position(api_cc_numbers, NULL) IS NULL
    AND array_to_string(api_cc_numbers, ',') ~ '^(\+[0-9]{8,15}(,\+[0-9]{8,15}){0,9})?$'
  );

COMMENT ON COLUMN public.organizations.api_cc_numbers IS
  'Batch 61/62: up to 10 numbers (E.164) that get a copy of every Public API template send without its own cc. Written only by the server (/api/developer/copies).';

SELECT public.mcp_block_oauth_writes();
SELECT public.mcp_block_oauth_reads();
