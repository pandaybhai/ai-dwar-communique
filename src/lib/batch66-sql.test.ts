import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 66 — 20261360 on a real (throwaway) Postgres, applied twice:
 * organizations.default_country_code is '91' for every workspace (existing
 * and new), only 1–4 digits without "+" are allowed, no contact changes, and
 * the file ends with the two OAuth guards. Never the live database.
 */

const dir = import.meta.dirname;
const MIGRATION = join(dir, "../../supabase/aidwar-migrations/20261360_batch66.sql");
const ZOORI = "81c234b2-569f-40be-ad71-96c046de5d12";

describe("20261360, as text", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  it("ends with the two OAuth guards and changes no data", () => {
    expect(
      sql
        .trim()
        .endsWith(
          "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
        ),
    ).toBe(true);
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE)\b/im);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS default_country_code text NOT NULL DEFAULT '91'/);
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261360_batch66.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch66-schema.sql"),
        migrations: [],
      });
      pg.sql(`
        insert into public.organizations (id, name) values ('${ZOORI}', 'ZOORI Jewels INDIA');
        insert into public.contacts (organization_id, phone) values ('${ZOORI}', '+9908109123');
      `);
      const sql = readFileSync(MIGRATION, "utf8");
      pg.sql(sql);
      pg.sql(sql); // twice: changes nothing the second time
    }, 120_000);
    afterAll(() => pg?.stop());

    it("every workspace, existing and new, reads 91", () => {
      expect(
        pg.sql(`select default_country_code from public.organizations where id = '${ZOORI}'`),
      ).toBe("91");
      pg.sql(`insert into public.organizations (name) values ('New shop')`);
      expect(
        pg.sql(`select string_agg(distinct default_country_code, ',') from public.organizations`),
      ).toBe("91");
    });

    it("only a calling code of 1–4 digits without + is allowed", () => {
      pg.sql(`update public.organizations set default_country_code = '1' where id = '${ZOORI}'`);
      pg.sql(`update public.organizations set default_country_code = '1268' where id = '${ZOORI}'`);
      for (const bad of ["+91", "091", "12345", "", "9a"])
        expect(() =>
          pg.sql(
            `update public.organizations set default_country_code = '${bad}' where id = '${ZOORI}'`,
          ),
        ).toThrow(/default_country_code_check/);
      pg.sql(`update public.organizations set default_country_code = '91' where id = '${ZOORI}'`);
    });

    it("no contact is touched (the data repair is separate)", () => {
      expect(pg.sql(`select phone from public.contacts`)).toBe("+9908109123");
    });
  },
);
