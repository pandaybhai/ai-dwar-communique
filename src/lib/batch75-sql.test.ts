import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 75 — 20261390 on a real (throwaway) Postgres, applied twice after the
 * demo_leads migrations: demo_leads.nudged_at, NULL by default. Never the live DB.
 */

const dir = import.meta.dirname;
const M = (f: string) => join(dir, "../../supabase/aidwar-migrations", f);
const MIGRATION = M("20261390_batch75.sql");

describe("20261390, as text", () => {
  it("adds one column if missing, changes no data, ends with the two OAuth guards", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(
      "ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS nudged_at timestamptz;",
    );
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DELETE|DROP)\b/im);
    expect(
      sql
        .trim()
        .endsWith(
          "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
        ),
    ).toBe(true);
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261390_batch75.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch72-schema.sql"),
        migrations: [M("20260915_demo_leads.sql"), M("20261380_batch72.sql"), MIGRATION, MIGRATION],
      });
    }, 120_000);
    afterAll(() => pg?.stop());

    it("a new /start lead has nudged_at NULL; it can be set once", () => {
      const id = pg
        .sql(
          `insert into public.demo_leads (phone, consent, consent_version, source) values ('+919812345670', true, 'v', 'landing_start') returning id`,
        )
        .trim();
      expect(
        pg.sql(`select nudged_at is null from public.demo_leads where id = '${id}'`),
      ).toContain("t");
      expect(
        pg.sql(
          `update public.demo_leads set nudged_at = now() where id = '${id}' and nudged_at is null returning id`,
        ),
      ).toContain(id);
      expect(
        pg
          .sql(
            `update public.demo_leads set nudged_at = now() where id = '${id}' and nudged_at is null returning id`,
          )
          .trim(),
      ).not.toContain(id);
    });
  },
);
