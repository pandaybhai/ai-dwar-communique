import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 67 — 20261370 on a real (throwaway) Postgres, applied twice:
 * api_refusals with its indexes, RLS (a member reads only their workspace's
 * rows; members can't write), the 90-day purge, and the closing
 * mcp_block_oauth_*() calls. Never the live database.
 */

const dir = import.meta.dirname;
const MIGRATION = join(dir, "../../supabase/aidwar-migrations/20261370_batch67.sql");
const ZOORI = "81c234b2-569f-40be-ad71-96c046de5d12";
const OTHER = "00000000-0000-4000-8000-0000000067b2";
const MEMBER = "00000000-0000-4000-8000-00000000a067";

describe("20261370, as text", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  it("ends with the two OAuth guards, changes no data and leaves retention_purge() alone", () => {
    expect(
      sql
        .trim()
        .endsWith(
          "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
        ),
    ).toBe(true);
    expect(sql).not.toMatch(/^\s*(UPDATE|INSERT)\b/im);
    expect(sql).not.toMatch(/FUNCTION public\.retention_purge\(/);
    expect(sql).toContain("SELECT public.retention_purge(); SELECT public.api_refusals_purge();");
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261370_batch67.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/batch67-schema.sql"),
        migrations: [MIGRATION, MIGRATION],
      });
      pg.sql(`
        insert into public.organizations (id, name) values ('${ZOORI}', 'ZOORI'), ('${OTHER}', 'Other');
        insert into public.organization_members values ('${ZOORI}', '${MEMBER}');
        insert into public.api_refusals (organization_id, endpoint, http_status, error_code, reason, template_name, created_at) values
          ('${ZOORI}', 'template', 400, 'invalid_phone', 'x', 'invoice_document', now()),
          ('${ZOORI}', 'template', 400, 'template_not_approved', 'x', 'invoice_document', now() - interval '91 days'),
          ('${OTHER}', 'session', 409, 'window_closed', 'x', null, now());
      `);
    }, 120_000);
    afterAll(() => pg?.stop());

    it("a member reads only their workspace's refusals, and can't write any", () => {
      const asMember = (q: string) =>
        pg.sql(
          `begin; set local role authenticated; select set_config('request.jwt.claim.sub', '${MEMBER}', true); ${q}; commit;`,
        );
      expect(
        asMember(`select string_agg(error_code, ',' order by error_code) from public.api_refusals`),
      ).toContain("invalid_phone,template_not_approved");
      expect(
        asMember(`select count(*) from public.api_refusals where organization_id = '${OTHER}'`),
      ).toContain("0");
      expect(() =>
        asMember(
          `insert into public.api_refusals (organization_id, endpoint, http_status, error_code, reason) values ('${ZOORI}', 'template', 400, 'x', 'x')`,
        ),
      ).toThrow(/permission denied|row-level security/);
    });

    it("the same key and code is one row (the dedupe index)", () => {
      pg.sql(
        `insert into public.api_refusals (organization_id, endpoint, http_status, error_code, reason, dedupe_key) values ('${ZOORI}', 'template', 400, 'invalid_phone', 'x', 'template:inv-1:invalid_phone')`,
      );
      expect(() =>
        pg.sql(
          `insert into public.api_refusals (organization_id, endpoint, http_status, error_code, reason, dedupe_key) values ('${ZOORI}', 'template', 400, 'invalid_phone', 'x', 'template:inv-1:invalid_phone')`,
        ),
      ).toThrow(/api_refusals_org_dedupe_key/);
    });

    it("the purge removes rows older than 90 days, nothing newer", () => {
      expect(pg.sql(`select public.api_refusals_purge()`)).toBe("1");
      expect(
        pg.sql(
          `select count(*) from public.api_refusals where created_at < now() - interval '90 days'`,
        ),
      ).toBe("0");
      expect(pg.sql(`select count(*) from public.api_refusals`)).toBe("3");
    });
  },
);
