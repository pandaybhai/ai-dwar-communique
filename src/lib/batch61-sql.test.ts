import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 61 — 20261330 on a real (throwaway) Postgres, applied twice on top of
 * the analytics functions exactly as 20260818 defines them: it adds
 * organizations.api_cc_numbers (default empty, at most 3 "+digits" numbers,
 * written only by the server), re-creates analytics_overview /
 * analytics_timeseries with the same signatures, return types, security and
 * grants and ONE added filter line (cc copies are not counted, NULL metadata
 * still is), and ends with mcp_block_oauth_writes() + mcp_block_oauth_reads().
 * Never the live database.
 */

const dir = import.meta.dirname;
const MIGRATIONS = join(dir, "../../supabase/aidwar-migrations");
const MIGRATION = join(MIGRATIONS, "20261330_batch61.sql");
const ORIGINAL = readFileSync(join(MIGRATIONS, "20260818_multi_number.sql"), "utf8");
const ORG = "00000000-0000-0000-0000-0000000061a1";
const FILTER = "      AND coalesce(m.metadata->>'copy','') <> 'true'";

/** One function's CREATE … through its GRANT, as a migration file has it. */
function functionBlock(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const grant = sql.indexOf(
    `GRANT EXECUTE ON FUNCTION public.${name}(uuid, date, date, uuid)`,
    start,
  );
  return sql.slice(start, sql.indexOf(";", grant) + 1);
}

describe("20261330: the analytics functions differ from the repo by one line each", () => {
  const mine = readFileSync(MIGRATION, "utf8");
  for (const name of ["analytics_overview", "analytics_timeseries"]) {
    it(name, () => {
      const before = functionBlock(ORIGINAL, name).split("\n");
      const after = functionBlock(mine, name).split("\n");
      expect(after.length).toBe(before.length + 1);
      const added = after.findIndex((line, i) => line !== before[i]);
      expect(after[added]).toBe(FILTER);
      expect([...after.slice(0, added), ...after.slice(added + 1)]).toEqual(before);
    });
  }
  it("puts them under '-- analytics: exclude cc copies'", () => {
    const at = mine.indexOf("-- analytics: exclude cc copies");
    expect(at).toBeGreaterThan(0);
    expect(mine.indexOf("FUNCTION public.analytics_overview(")).toBeGreaterThan(at);
    expect(mine.indexOf("FUNCTION public.analytics_timeseries(")).toBeGreaterThan(at);
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261330_batch61.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      const tmp = mkdtempSync(join(tmpdir(), "batch61-"));
      const original = join(tmp, "analytics-20260818.sql");
      writeFileSync(
        original,
        `${functionBlock(ORIGINAL, "analytics_overview")}\n\n${functionBlock(ORIGINAL, "analytics_timeseries")}\n`,
      );
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch61-schema.sql"),
        migrations: [original, MIGRATION, MIGRATION],
      });
      pg.sql(`insert into public.organizations (id, name) values ('${ORG}', 'Shop A')`);
    }, 120_000);
    afterAll(() => pg?.stop());

    it("adds api_cc_numbers, empty by default", () => {
      expect(
        pg.sql(`select api_cc_numbers::text from public.organizations where id = '${ORG}'`),
      ).toBe("{}");
    });

    it("takes up to 3 numbers with country code, nothing else", () => {
      const set = (v: string) =>
        pg.sql(`update public.organizations set api_cc_numbers = ${v} where id = '${ORG}'`);
      set("array['+918121310333','+919121883067','+919800000001']");
      expect(
        pg.sql(`select cardinality(api_cc_numbers) from public.organizations where id = '${ORG}'`),
      ).toBe("3");
      for (const bad of [
        "array['+918121310333','+919121883067','+919800000001','+919800000002']",
        "array['918121310333']",
        "array['+91 81213 10333']",
        "array['+1234']",
        "array[null]::text[]",
      ])
        expect(() => set(bad), bad).toThrow(/organizations_api_cc_numbers_check/);
      set("'{}'");
    });

    it("is written only by the server: a signed-in member's update keeps the old value", () => {
      pg.sql(
        `update public.organizations set api_cc_numbers = array['+918121310333'] where id = '${ORG}'`,
      );
      pg.sql(
        `set role authenticated; update public.organizations set api_cc_numbers = array['+919999999999'], name = 'Shop A2' where id = '${ORG}'; reset role;`,
      );
      expect(
        pg.sql(
          `select name || ' ' || api_cc_numbers::text from public.organizations where id = '${ORG}'`,
        ),
      ).toBe("Shop A2 {+918121310333}");
      pg.sql(
        `set role authenticated; insert into public.organizations (name, api_cc_numbers) values ('New', array['+919999999999']); reset role;`,
      );
      expect(
        pg.sql(`select api_cc_numbers::text from public.organizations where name = 'New'`),
      ).toBe("{}");
      pg.sql(`update public.organizations set api_cc_numbers = '{}' where id = '${ORG}'`);
    });

    it("analytics no longer counts cc copies; NULL metadata and copy:false still count", () => {
      const day = "2026-11-02";
      const add = (direction: string, status: string, metadata: string) =>
        pg.sql(
          `insert into public.messages (organization_id, direction, status, metadata, created_at) values ('${ORG}', '${direction}', '${status}', ${metadata}, '${day} 10:00:00+00')`,
        );
      add("outbound", "delivered", "null");
      add("outbound", "read", `'{"source":"api"}'`);
      add("outbound", "delivered", `'{"source":"api","copy":false}'`);
      add("outbound", "delivered", `'{"source":"api","copy":true,"cc_of":"m1"}'`);
      add("outbound", "failed", `'{"source":"api","copy":true,"cc_of":"m1"}'`);
      add("inbound", "received", "null");
      const overview = JSON.parse(
        pg.sql(`select public.analytics_overview('${ORG}', '${day}', '${day}')::text`),
      ) as { current: Record<string, number> };
      expect(overview.current).toMatchObject({
        sent: 3,
        delivered: 3,
        read: 1,
        failed: 0,
        replies: 1,
      });
      expect(
        pg.sql(
          `select sent || ',' || delivered || ',' || read || ',' || failed || ',' || replies from public.analytics_timeseries('${ORG}', '${day}', '${day}')`,
        ),
      ).toBe("3,3,1,0,1");
    });

    it("keeps the signatures, return types, SECURITY DEFINER and grants", () => {
      for (const name of ["analytics_overview", "analytics_timeseries"]) {
        expect(
          pg.sql(
            `select count(*) from pg_proc where proname = '${name}' and pronamespace = 'public'::regnamespace`,
          ),
        ).toBe("1");
        expect(
          pg.sql(
            `select pg_get_function_identity_arguments(oid) || ' | ' || prosecdef from pg_proc where proname = '${name}'`,
          ),
        ).toBe("p_organization_id uuid, p_from date, p_to date, p_whatsapp_account_id uuid | true");
        const fn = `public.${name}(uuid, date, date, uuid)`;
        expect(
          pg.sql(
            `select has_function_privilege('authenticated', '${fn}', 'execute') || ',' || has_function_privilege('service_role', '${fn}', 'execute') || ',' || has_function_privilege('anon', '${fn}', 'execute')`,
          ),
        ).toBe("true,true,false");
      }
      expect(
        pg.sql(
          `select pg_get_function_result('public.analytics_overview(uuid, date, date, uuid)'::regprocedure)`,
        ),
      ).toBe("jsonb");
      expect(
        pg.sql(
          `select pg_get_function_result('public.analytics_timeseries(uuid, date, date, uuid)'::regprocedure)`,
        ),
      ).toMatch(/^TABLE\(day date, sent bigint, delivered bigint, read bigint, failed bigint/);
    });

    it("is additive and ends with mcp_block_oauth_writes() and mcp_block_oauth_reads()", () => {
      const sql = readFileSync(MIGRATION, "utf8");
      const code = sql.replace(/--.*$/gm, "");
      expect(code).not.toMatch(/\bdrop\s+(table|column|index|function|trigger)\b/i);
      expect(code).not.toMatch(/81c234b2|8121310333|9121883067/);
      expect(
        code
          .trim()
          .endsWith(
            "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
          ),
      ).toBe(true);
    });
  },
);
