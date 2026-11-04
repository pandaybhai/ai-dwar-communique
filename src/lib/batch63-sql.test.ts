import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 63 — 20261350 on a real (throwaway) Postgres, applied twice: the
 * override `source` column (default 'plan', only plan/manual), contacts
 * .wa_unreachable (NULL), the partial Sent-report index, and the closing
 * mcp_block_oauth_*() calls. The separate backfill script's Step 1 is
 * read-only and lists exactly the hand-set rows; Step 2 stays commented out.
 * Never the live database.
 */

const dir = import.meta.dirname;
const MIGRATION = join(dir, "../../supabase/aidwar-migrations/20261350_batch63.sql");
const BACKFILL = join(dir, "../../scripts/batch63-override-backfill.sql");
const ZOORI = "81c234b2-569f-40be-ad71-96c046de5d12";
const OTHER = "00000000-0000-4000-8000-0000000063b2";

describe("20261350 / the backfill, as text", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  const backfill = readFileSync(BACKFILL, "utf8");
  it("ends with the two OAuth guards and writes no workspace's data", () => {
    expect(
      sql
        .trim()
        .endsWith(
          "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
        ),
    ).toBe(true);
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/im);
  });
  it("the backfill is a separate file whose only write is commented out", () => {
    expect(sql).not.toContain("batch63-override-backfill.sql\n--");
    const live = backfill
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(live).not.toMatch(/\bUPDATE\b|\bINSERT\b|\bDELETE\b/i);
    expect(backfill).toMatch(/-- UPDATE public\.organization_feature_overrides o/);
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261350_batch63.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch63-schema.sql"),
        migrations: [MIGRATION, MIGRATION],
      });
      pg.sql(`
      insert into public.organizations (id, name) values ('${ZOORI}', 'ZOORI Jewels INDIA'), ('${OTHER}', 'Other');
      insert into public.organization_feature_overrides (organization_id, flag_key, enabled) values
        ('${ZOORI}', 'shopify', false), ('${ZOORI}', 'catalogs', false), ('${ZOORI}', 'new_design', true),
        ('${ZOORI}', 'mcp_access', true), ('${ZOORI}', 'flows', true), ('${OTHER}', 'shopify', true);
      insert into public.organization_billing_settings (organization_id, limits_override) values
        ('${ZOORI}', '{"_manual_flags": {"shopify": false, "catalog": false}}');
      insert into public.activity_log (organization_id, action, details) values
        ('${ZOORI}', 'mcp_access_changed', '{"enabled": true}');
      insert into public.contacts (organization_id, phone) values ('${ZOORI}', '+919876543210');
    `);
    }, 120_000);
    afterAll(() => pg?.stop());

    it("every existing row reads 'plan' (nothing set for any workspace); only plan/manual allowed", () => {
      expect(
        pg.sql(
          `select string_agg(distinct source, ',') from public.organization_feature_overrides`,
        ),
      ).toBe("plan");
      expect(() =>
        pg.sql(
          `update public.organization_feature_overrides set source = 'admin' where flag_key = 'flows'`,
        ),
      ).toThrow(/source_check/);
      pg.sql(
        `update public.organization_feature_overrides set source = 'manual' where organization_id = '${OTHER}'`,
      );
      pg.sql(
        `update public.organization_feature_overrides set source = 'plan' where organization_id = '${OTHER}'`,
      );
    });

    it("contacts.wa_unreachable is there and NULL", () => {
      expect(pg.sql(`select count(*) from public.contacts where wa_unreachable is null`)).toBe("1");
      pg.sql(
        `update public.contacts set wa_unreachable = '{"since":"2026-11-02T05:00:00Z","code":"131026"}' where phone = '+919876543210'`,
      );
      expect(pg.sql(`select wa_unreachable->>'code' from public.contacts`)).toBe("131026");
    });

    it("the Sent report's partial index exists once", () => {
      expect(
        pg.sql(`select indexdef from pg_indexes where indexname = 'messages_template_sends_idx'`),
      ).toBe(
        "CREATE INDEX messages_template_sends_idx ON public.messages USING btree (organization_id, template_name, created_at DESC) WHERE ((direction = 'outbound'::text) AND (type = 'template'::text))",
      );
    });

    it("the backfill's Step 1 lists only Zoori's hand-set rows, and changes nothing", () => {
      const listed = pg
        .file(BACKFILL)
        .trim()
        .split("\n")
        .map((l) => l.split("|").slice(2, 6).join("|"));
      expect(listed).toEqual([
        "catalogs|f|plan|limits_override._manual_flags",
        "mcp_access|t|plan|activity_log.mcp_access_changed",
        "shopify|f|plan|limits_override._manual_flags",
      ]);
      expect(
        pg.sql(
          `select count(*) from public.organization_feature_overrides where source = 'manual'`,
        ),
      ).toBe("0");
    });
  },
);
