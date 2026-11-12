import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 72 — 20261380 on a real (throwaway) Postgres, applied twice after
 * 20260915_demo_leads.sql: a /start lead (source landing_start) may leave the
 * five qualification columns empty; every other source still needs them, and
 * the old CHECKs on enquiry_band / primary_need still hold. Never the live DB.
 */

const dir = import.meta.dirname;
const BASE = join(dir, "../../supabase/aidwar-migrations/20260915_demo_leads.sql");
const MIGRATION = join(dir, "../../supabase/aidwar-migrations/20261380_batch72.sql");

describe("20261380, as text", () => {
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
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261380_batch72.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch72-schema.sql"),
        migrations: [BASE, MIGRATION, MIGRATION],
      });
    }, 120_000);
    afterAll(() => pg?.stop());

    const insert = (cols: string) => `insert into public.demo_leads ${cols} returning source`;

    it("a /start lead with only a number is accepted", () => {
      expect(
        pg.sql(
          insert(
            `(phone, consent, consent_version, source, landing_path) values ('+919876543210', true, 'start-2026-11-12', 'landing_start', '/start')`,
          ),
        ),
      ).toContain("landing_start");
    });

    it("a /demo lead still needs every qualification answer", () => {
      expect(() =>
        pg.sql(
          insert(
            `(phone, consent, consent_version, source, name, business_name) values ('+919876543211', true, 'x', 'landing', 'Asha', 'ZOORI')`,
          ),
        ),
      ).toThrow(/demo_leads_qualified_unless_landing_start/);
      expect(
        pg.sql(
          insert(
            `(business_type, enquiry_band, primary_need, name, business_name, phone, consent, consent_version) values ('retail', '0-20', 'replies', 'Asha', 'ZOORI', '+919876543212', true, 'x')`,
          ),
        ),
      ).toContain("landing");
    });

    it("the old CHECKs still hold, and consent must still be true", () => {
      expect(() =>
        pg.sql(
          insert(
            `(phone, consent, consent_version, source, enquiry_band) values ('+919876543213', true, 'x', 'landing_start', 'lots')`,
          ),
        ),
      ).toThrow(/enquiry_band/);
      expect(() =>
        pg.sql(
          insert(
            `(phone, consent, consent_version, source) values ('+919876543214', false, 'x', 'landing_start')`,
          ),
        ),
      ).toThrow(/consent/);
    });
  },
);
