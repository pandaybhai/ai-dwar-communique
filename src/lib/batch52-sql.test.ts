import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 52 — 20261260 on a real (throwaway) Postgres, applied twice: it is
 * idempotent and additive. A request is played as PostgREST plays it: role
 * authenticated, request.jwt.claims and request.method set for the
 * transaction. An app session (no client_id) keeps every write it had; an
 * OAuth token (an AI app, client_id set) can read but not write a row, and
 * the pre-request guard refuses its every non-read request. Never the live
 * database.
 */

const dir = import.meta.dirname;
const MIGRATIONS = join(dir, "../../supabase/aidwar-migrations");
const MIGRATION = join(MIGRATIONS, "20261260_batch52_mcp.sql");
const ORG = "00000000-0000-0000-0000-0000000052a1";
const USER = "00000000-0000-0000-0000-0000000052c3";
const CLIENT = "9a8b7c6d-0000-4000-8000-0000000052aa";

const appClaims = JSON.stringify({ sub: USER, role: "authenticated", aud: "authenticated", session_id: "s1" });
const oauthClaims = JSON.stringify({ sub: USER, role: "authenticated", aud: "authenticated", client_id: CLIENT });

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261260_batch52_mcp.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/loadtest/schema.sql"),
        migrations: [
          join(dir, "test-support/storage-stubs.sql"),
          join(dir, "test-support/batch52-stubs.sql"),
          MIGRATION,
          MIGRATION,
        ],
      });
      pg.sql(`insert into public.organizations (id, name) values ('${ORG}', 'Shop A')`);
    }, 120_000);
    afterAll(() => pg?.stop());

    /** One statement as PostgREST runs it for a token with these claims. */
    const as = (claims: string, statement: string, method = "POST") =>
      pg.sql(
        `begin; set local role authenticated; set local request.jwt.claims = '${claims}'; set local request.method = '${method}'; ${statement}; commit;`,
      );
    const count = (sql: string) => Number(pg.sql(sql));

    it("adds one restrictive policy per write command on each RLS table authenticated can write — and only once", () => {
      const rows = pg
        .sql(
          "select tablename || ':' || cmd || ':' || permissive from pg_policies where policyname like 'aidwar_mcp_no_oauth_%' and schemaname = 'public' order by 1",
        )
        .split("\n");
      for (const t of ["campaigns", "contacts", "conversations", "segments"]) {
        expect(rows).toContain(`${t}:INSERT:RESTRICTIVE`);
        expect(rows).toContain(`${t}:UPDATE:RESTRICTIVE`);
        expect(rows).toContain(`${t}:DELETE:RESTRICTIVE`);
      }
      // Read-only to members (message_templates) and RLS-off tables get none.
      expect(rows.some((r) => r.startsWith("message_templates:"))).toBe(false);
      expect(rows.some((r) => r.startsWith("short_links:"))).toBe(false);
      expect(rows).toHaveLength(12);
      // Applied twice above; running the function again adds nothing.
      expect(pg.sql("select public.mcp_block_oauth_writes()")).toBe("0");
      expect(
        count("select count(*) from pg_policies where schemaname = 'storage' and policyname like 'aidwar_mcp_no_oauth_%'"),
      ).toBe(3);
    });

    it("an app session (no client_id) keeps every write: insert, update and delete", () => {
      as(appClaims, `insert into public.contacts (id, organization_id, phone) values ('00000000-0000-0000-0000-0000000052e1', '${ORG}', '+911')`);
      as(appClaims, `insert into public.segments (organization_id, name) values ('${ORG}', 'VIP')`);
      as(appClaims, `insert into public.campaigns (organization_id, name) values ('${ORG}', 'Diwali')`);
      as(appClaims, `update public.contacts set name = 'Asha' where phone = '+911'`);
      expect(pg.sql("select name from public.contacts where phone = '+911'")).toBe("Asha");
      as(appClaims, `delete from public.segments where name = 'VIP'`);
      expect(count("select count(*) from public.segments")).toBe(0);
      as(appClaims, `insert into public.short_links (organization_id, token, target_url) values ('${ORG}', 'a1', 'https://x.example')`);
      expect(count("select count(*) from public.short_links")).toBe(1);
    });

    it("an OAuth token (client_id) reads, but can't insert, update or delete a row", () => {
      expect(as(oauthClaims, "select name from public.contacts where phone = '+911'", "GET")).toBe("Asha");
      expect(() =>
        as(oauthClaims, `insert into public.segments (organization_id, name) values ('${ORG}', 'From AI')`, "GET"),
      ).toThrow(/row-level security/);
      // Updates and deletes see no row to touch.
      as(oauthClaims, "update public.contacts set name = 'Hacked' where phone = '+911'", "GET");
      as(oauthClaims, "delete from public.contacts where phone = '+911'", "GET");
      expect(pg.sql("select name from public.contacts where phone = '+911'")).toBe("Asha");
      expect(() =>
        as(oauthClaims, "update public.campaigns set status = 'sending'", "GET"),
      ).not.toThrow();
      expect(pg.sql("select status from public.campaigns where name = 'Diwali'")).toBe("draft");
      expect(count("select count(*) from public.segments")).toBe(0);
    });

    it("the pre-request guard: OAuth tokens may only GET/HEAD; app sessions, anon and bad claims pass", () => {
      const guard = (claims: string | null, method: string) =>
        pg.sql(
          `begin; set local role authenticated; ${claims === null ? "" : `set local request.jwt.claims = '${claims}';`} set local request.method = '${method}'; select public.mcp_oauth_request_guard(); commit;`,
        );
      for (const m of ["POST", "PATCH", "PUT", "DELETE"]) {
        expect(() => guard(oauthClaims, m)).toThrow(/only read here/);
        expect(() => guard(appClaims, m)).not.toThrow();
      }
      expect(() => guard(oauthClaims, "GET")).not.toThrow();
      expect(() => guard(oauthClaims, "HEAD")).not.toThrow();
      expect(() => guard(null, "POST")).not.toThrow();
      expect(() => guard("not json", "POST")).not.toThrow();
      expect(() => guard(JSON.stringify({ role: "anon" }), "POST")).not.toThrow();
      // Attached to PostgREST's login role, once.
      expect(
        pg.sql(
          "select cfg from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) cfg where r.rolname = 'authenticator' and cfg like 'pgrst.db_pre_request=%'",
        ),
      ).toBe("pgrst.db_pre_request=public.mcp_oauth_request_guard");
    });

    it("leaves another pre-request function in place", () => {
      pg.sql("alter role authenticator set pgrst.db_pre_request = 'public.someone_elses_check'");
      pg.file(MIGRATION);
      expect(
        pg.sql(
          "select cfg from pg_db_role_setting s join pg_roles r on r.oid = s.setrole, unnest(s.setconfig) cfg where r.rolname = 'authenticator' and cfg like 'pgrst.db_pre_request=%'",
        ),
      ).toBe("pgrst.db_pre_request=public.someone_elses_check");
      pg.sql("alter role authenticator set pgrst.db_pre_request = 'public.mcp_oauth_request_guard'");
    });

    it("mcp_access is on by default; feature 'mcp' with mcp.use for every role", () => {
      expect(pg.sql("select default_enabled from public.feature_flags where key = 'mcp_access'")).toBe("t");
      expect(pg.sql("select flag_key || ':' || array_to_string(activity_actions, ',') from public.feature_registry where key = 'mcp'")).toBe(
        "mcp_access:mcp_segment_created,mcp_campaign_drafted,mcp_campaign_sent,mcp_flow_drafted,mcp_flow_activated",
      );
      expect(pg.sql("select category || ':' || min_role from public.permissions where key = 'mcp.use'")).toBe("mcp:agent");
      expect(pg.sql("select string_agg(role, ',' order by role) from public.role_permissions where permission_key = 'mcp.use'")).toBe(
        "admin,agent,marketer,owner",
      );
      // The category check now knows 'mcp' and still every category it had.
      const def = pg.sql("select pg_get_constraintdef(oid) from pg_constraint where conname = 'permissions_category_check'");
      expect(def).toContain("'mcp'");
      expect(def).toContain("'campaigns'");
    });
  },
);

describe("later migrations keep OAuth tokens out of new tables", () => {
  it("any migration after 20261260 that turns RLS on also runs mcp_block_oauth_writes()", () => {
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && f > "20261260_batch52_mcp.sql")
      .sort();
    for (const f of later) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8").toLowerCase();
      if (/enable\s+row\s+level\s+security/.test(sql)) {
        expect(sql, `${f} turns RLS on: add "select public.mcp_block_oauth_writes();" at its end`).toContain(
          "mcp_block_oauth_writes()",
        );
      }
    }
  });
});
