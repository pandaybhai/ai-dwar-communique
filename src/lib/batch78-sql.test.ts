import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 78 — 20261420 on a real (throwaway) Postgres, applied twice after the
 * demo_leads migrations: the verification table (service role only, one row
 * per code), demo_leads.verified_at and the 7-day purge. Never the live DB.
 */

const dir = import.meta.dirname;
const M = (f: string) => join(dir, "../../supabase/aidwar-migrations", f);
const MIGRATION = M("20261420_batch78.sql");

describe("20261420, as text", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  it("additive; ends with the two OAuth guards; the nightly job keeps its calls and adds the purge", () => {
    expect(
      sql
        .trim()
        .endsWith(
          "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
        ),
    ).toBe(true);
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT|DROP TABLE|DROP COLUMN)\b/im);
    expect(sql).toContain(
      "$cmd$SELECT public.retention_purge(); SELECT public.api_refusals_purge(); SELECT public.lead_verifications_purge();$cmd$",
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.lead_verifications (");
    expect(sql).toContain(
      "lead_id uuid NOT NULL REFERENCES public.demo_leads(id) ON DELETE CASCADE,",
    );
    expect(sql).toContain("ON public.lead_verifications (phone, created_at DESC);");
    expect(sql).toContain(
      "ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS verified_at timestamptz;",
    );
    // Service role only: RLS on, nothing granted to app clients, no policies.
    expect(sql).toContain("ALTER TABLE public.lead_verifications ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("REVOKE ALL ON public.lead_verifications FROM anon, authenticated;");
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261420_batch78.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch76-schema.sql"),
        migrations: [
          M("20260915_demo_leads.sql"),
          M("20261380_batch72.sql"),
          M("20261400_batch76.sql"),
          MIGRATION,
          MIGRATION,
        ],
      });
    }, 120_000);
    afterAll(() => pg?.stop());

    const lead = () =>
      pg
        .sql(
          `insert into public.demo_leads (phone, consent, consent_version, source) values ('+919812345670', true, 'v', 'landing_start') returning id`,
        )
        .trim();
    const code = (leadId: string, c: string, extra = "") =>
      pg.sql(
        `insert into public.lead_verifications (lead_id, code, phone, browser_nonce_hash, expires_at${extra ? ", created_at, used_at" : ""}) values ('${leadId}', '${c}', '+919812345670', 'h', now() + interval '15 minutes'${extra}) returning id`,
      );

    it("adds verified_at (empty) and a code table with one row per code", () => {
      const id = lead();
      expect(
        pg.sql(`select verified_at is null from public.demo_leads where id = '${id}'`),
      ).toContain("t");
      code(id, "V-ABCD");
      expect(() => code(id, "V-ABCD")).toThrow(/duplicate|unique/i);
      expect(
        pg.sql(
          `select attempts, used_at is null from public.lead_verifications where code = 'V-ABCD'`,
        ),
      ).toMatch(/0\s*\|\s*t/);
    });

    it("app clients can't read or write codes", () => {
      expect(() =>
        pg.sql(
          `begin; set local role authenticated; select count(*) from public.lead_verifications; commit;`,
        ),
      ).toThrow(/permission denied/i);
      expect(() =>
        pg.sql(
          `begin; set local role anon; select count(*) from public.lead_verifications; commit;`,
        ),
      ).toThrow(/permission denied/i);
    });

    it("the purge drops used/expired codes older than 7 days and keeps the rest", () => {
      const id = lead();
      code(id, "V-OLD1", ", now() - interval '8 days', now() - interval '8 days'");
      code(id, "V-NEW1");
      pg.sql(
        `insert into public.lead_verifications (lead_id, code, phone, browser_nonce_hash, expires_at, created_at) values ('${id}', 'V-OLD2', '+919812345670', 'h', now() - interval '8 days', now() - interval '8 days')`,
      );
      expect(pg.sql(`select public.lead_verifications_purge()`).trim()).toBe("2");
      expect(
        pg
          .sql(
            `select string_agg(code, ',' order by code) from public.lead_verifications where lead_id = '${id}'`,
          )
          .trim(),
      ).toBe("V-NEW1");
    });

    it("deleting a lead removes its codes", () => {
      const id = lead();
      code(id, "V-GONE");
      pg.sql(`delete from public.demo_leads where id = '${id}'`);
      expect(
        pg.sql(`select count(*) from public.lead_verifications where code = 'V-GONE'`).trim(),
      ).toBe("0");
    });
  },
);
