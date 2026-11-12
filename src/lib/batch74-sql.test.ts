import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 74 — 20261390 on a real (throwaway) Postgres, applied twice after the
 * demo_leads migrations: the verification table (service role only, one use
 * per code, 7-day purge), the two demo_leads columns and the profiles flag.
 * Never the live DB.
 */

const dir = import.meta.dirname;
const M = (f: string) => join(dir, "../../supabase/aidwar-migrations", f);
const MIGRATION = M("20261390_batch74.sql");

describe("20261390, as text", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  it("ends with the two OAuth guards, changes no data, keeps the nightly job's calls", () => {
    expect(
      sql
        .trim()
        .endsWith(
          "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
        ),
    ).toBe(true);
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT)\b/im);
    expect(sql).toContain(
      "$cmd$SELECT public.retention_purge(); SELECT public.api_refusals_purge(); SELECT public.lead_verifications_purge();$cmd$",
    );
    // Service role only: RLS on, nothing granted to app clients.
    expect(sql).toContain("ALTER TABLE public.lead_verifications ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("REVOKE ALL ON public.lead_verifications FROM anon, authenticated;");
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261390_batch74.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch74-schema.sql"),
        migrations: [M("20260915_demo_leads.sql"), M("20261380_batch72.sql"), MIGRATION, MIGRATION],
      });
    }, 120_000);
    afterAll(() => pg?.stop());

    const lead = () =>
      pg
        .sql(
          `insert into public.demo_leads (phone, consent, consent_version, source) values ('+919876543210', true, 'v', 'landing_start') returning id`,
        )
        .trim();

    it("adds verified_at / nudged_at and the placeholder flag (default false)", () => {
      const id = lead();
      expect(
        pg.sql(
          `select verified_at is null, nudged_at is null from public.demo_leads where id = '${id}'`,
        ),
      ).toMatch(/t\|t|t \| t|t\s+t/);
      pg.sql(`insert into public.profiles (id, email) values (gen_random_uuid(), 'a@b.co')`);
      expect(pg.sql(`select bool_or(email_is_placeholder) from public.profiles`)).toContain("f");
    });

    it("a code is unique, its purpose is verify or login, and it goes with its lead", () => {
      const id = lead();
      const ins = (code: string, purpose = "verify") =>
        pg.sql(
          `insert into public.lead_verifications (lead_id, purpose, code, phone, browser_nonce_hash, expires_at) values ('${id}', '${purpose}', '${code}', '+919876543210', 'h', now() + interval '15 minutes') returning attempts`,
        );
      expect(ins("V-AB23")).toContain("0");
      expect(() => ins("V-AB23")).toThrow(/duplicate|unique/i);
      expect(() => ins("V-ZZ99", "signup")).toThrow(/check/i);
      pg.sql(`delete from public.demo_leads where id = '${id}'`);
      expect(
        pg.sql(`select count(*) from public.lead_verifications where code = 'V-AB23'`),
      ).toContain("0");
    });

    it("the purge removes only used/expired codes older than 7 days", () => {
      pg.sql(`delete from public.lead_verifications`);
      const row = (code: string, age: string, used: boolean, expiresIn: string) =>
        pg.sql(
          `insert into public.lead_verifications (purpose, code, phone, browser_nonce_hash, expires_at, used_at, created_at) values ('login', '${code}', '+919876543210', 'h', now() + interval '${expiresIn}', ${used ? "now()" : "null"}, now() - interval '${age}')`,
        );
      row("L-OLD1", "8 days", true, "-8 days");
      row("L-OLD2", "8 days", false, "-8 days");
      row("L-NEW1", "1 hour", true, "-1 hour");
      row("L-LIVE", "1 minute", false, "14 minutes");
      expect(pg.sql(`select public.lead_verifications_purge()`)).toContain("2");
      expect(
        pg.sql(`select string_agg(code, ',' order by code) from public.lead_verifications`),
      ).toContain("L-LIVE,L-NEW1");
    });
  },
);
