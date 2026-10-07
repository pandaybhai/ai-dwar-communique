-- Batch 21 item 4 (NOT applied): archive duplicate products — the same
-- product page stored twice, once under https://example.com/... and once
-- under https://www.example.com/... (or http/https, a trailing slash, or a
-- SKU with a "-1" suffix on the same address).
--
-- Live dry run (7 Oct 2026, read-only):
--   81c234b2-569f-40be-ad71-96c046de5d12 (Zoori)  120 rows: 100 null SKU,
--     20 "-1" SKU; all 120 already hidden; the kept www row is visible in
--     every pair; none of the 11 held rings (they have no twin).
--   every other workspace                          0 rows.
--
-- Rule, per workspace and per page address (host without www, lower case;
-- path without trailing slash or #fragment; query kept): keep one row — the
-- visible one, then the www one, then the one whose SKU has no "-N" suffix,
-- then the oldest — and mark every other row archived. Only when the kept
-- row is visible: a pair where nothing is visible (e.g. a product waiting on
-- the shop's price confirmation) is left exactly as it is. Rows a shop
-- platform owns (shopify, meta_catalog) are never touched. No deletes.
--
-- Archived = products.status 'archived' (the column Shopify rows already
-- use) AND is_visible = false. Every customer-facing search, Show products,
-- price check, WhatsApp shop sync and the admin/source counts already read
-- only visible rows; the merchant's catalogue list and its counts leave
-- archived rows out (Batch 21); a website re-read never brings one back.
-- Reversible: SET status = NULL (is_visible as it was: false for all 120).
-- Idempotent: an archived row is never looked at again.

SET lock_timeout = '5s';

DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    WITH p AS (
      SELECT id, organization_id, is_visible, sku, created_at,
        lower(substring(u FROM '^https?://(?:www\.)?([^/?#]+)'))
          || regexp_replace(regexp_replace(regexp_replace(u, '^https?://[^/?#]+', ''), '#.*$', ''), '/+$', '') AS canon,
        u ~* '^https?://www\.' AS is_www
      FROM (
        SELECT *, CASE WHEN external_id ~* '^https?://' THEN external_id ELSE product_url END AS u
        FROM public.products
        WHERE source NOT IN ('shopify', 'meta_catalog')
          AND coalesce(status, '') <> 'archived'
      ) x
      WHERE u ~* '^https?://[^/?#]+'
    ),
    ranked AS (
      SELECT p.*,
        row_number() OVER w AS rn,
        count(*) OVER (PARTITION BY organization_id, canon) AS n,
        first_value(is_visible) OVER w AS kept_visible
      FROM p
      WINDOW w AS (
        PARTITION BY organization_id, canon
        ORDER BY is_visible DESC, is_www DESC, (coalesce(sku, '') ~ '-[0-9]+$') ASC, created_at ASC, id ASC
      )
    ),
    archived AS (
      UPDATE public.products t
         SET status = 'archived', is_visible = false, updated_at = now()
        FROM ranked r
       WHERE t.id = r.id AND r.n > 1 AND r.rn > 1 AND r.kept_visible
      RETURNING t.organization_id, r.is_visible AS was_visible, t.sku
    )
    SELECT organization_id,
           count(*) AS rows_archived,
           count(*) FILTER (WHERE was_visible) AS were_visible,
           count(*) FILTER (WHERE sku IS NULL) AS null_sku
      FROM archived
     GROUP BY organization_id
  LOOP
    RAISE NOTICE 'batch21 archive duplicates: org % archived % (were visible %, null sku %)',
      rec.organization_id, rec.rows_archived, rec.were_visible, rec.null_sku;
  END LOOP;
END $$;
