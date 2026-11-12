import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 76 — 20261400 on a real (throwaway) Postgres, applied twice: the sales
 * flag (nobody can raise their own, on UPDATE or INSERT; a super admin can),
 * the alert numbers seeded once, demo_leads.alerted_at. Never the live DB.
 */

const dir = import.meta.dirname;
const M = (f: string) => join(dir, "../../supabase/aidwar-migrations", f);
const MIGRATION = M("20261400_batch76.sql");
const USER = "11111111-1111-4111-8111-111111111111";
const BOSS = "22222222-2222-4222-8222-222222222222";

describe("20261400, as text", () => {
  it("is additive, seeds only an empty list, ends with the two OAuth guards", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(
      "ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_sales boolean NOT NULL DEFAULT false;",
    );
    expect(sql).toContain(
      "ADD COLUMN IF NOT EXISTS lead_alert_numbers text[] NOT NULL DEFAULT '{}';",
    );
    expect(sql).toContain("SET lead_alert_numbers = ARRAY['+917981223192', '+919121883067']");
    expect(sql).toContain("WHERE lead_alert_numbers = '{}';");
    expect(sql).toContain(
      "ALTER TABLE public.demo_leads ADD COLUMN IF NOT EXISTS alerted_at timestamptz;",
    );
    expect(sql).not.toMatch(/^\s*(DELETE|DROP|INSERT)\b/im);
    expect(sql.match(/^\s*UPDATE\b/gim)).toHaveLength(1);
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
  "20261400_batch76.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch76-schema.sql"),
        migrations: [M("20260915_demo_leads.sql"), M("20261380_batch72.sql"), MIGRATION, MIGRATION],
      });
      pg.sql(
        `insert into public.profiles (id, email) values ('${USER}', 'sales@example.com'); insert into public.profiles (id, email, is_super_admin) values ('${BOSS}', 'boss@example.com', true);`,
      );
    }, 120_000);
    afterAll(() => pg?.stop());

    const as = (who: string, q: string) =>
      pg.sql(
        `begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${who}', true); ${q}; commit;`,
      );

    it("a user can't raise their own is_sales (nor super admin)", () => {
      as(
        USER,
        `update public.profiles set is_sales = true, is_super_admin = true where id = '${USER}'`,
      );
      expect(
        pg.sql(`select is_sales, is_super_admin from public.profiles where id = '${USER}'`),
      ).toMatch(/f.*f/);
    });

    it("a client insert never starts with is_sales set", () => {
      const other = "33333333-3333-4333-8333-333333333333";
      as(
        USER,
        `insert into public.profiles (id, email, is_sales) values ('${other}', 'x@example.com', true)`,
      );
      expect(pg.sql(`select is_sales from public.profiles where id = '${other}'`)).toContain("f");
    });

    it("a super admin (and the server) can set it", () => {
      as(BOSS, `update public.profiles set is_sales = true where id = '${USER}'`);
      expect(pg.sql(`select is_sales from public.profiles where id = '${USER}'`)).toContain("t");
      pg.sql(`update public.profiles set is_sales = false where id = '${USER}'`);
      expect(pg.sql(`select is_sales from public.profiles where id = '${USER}'`)).toContain("f");
    });

    it("alert numbers are seeded once; a changed list is never overwritten by a re-run", () => {
      expect(
        pg.sql(`select array_to_string(lead_alert_numbers, ',') from public.platform_settings`),
      ).toContain("+917981223192,+919121883067");
      pg.sql(`update public.platform_settings set lead_alert_numbers = array['+919000012345']`);
      pg.sql(readFileSync(MIGRATION, "utf8"));
      expect(
        pg
          .sql(`select array_to_string(lead_alert_numbers, ',') from public.platform_settings`)
          .trim(),
      ).toBe("+919000012345");
    });

    it("demo_leads.alerted_at exists and starts empty", () => {
      const id = pg
        .sql(
          `insert into public.demo_leads (phone, consent, consent_version, source) values ('+919812345670', true, 'v', 'landing_start') returning id`,
        )
        .trim();
      expect(
        pg.sql(`select alerted_at is null from public.demo_leads where id = '${id}'`),
      ).toContain("t");
    });
  },
);
