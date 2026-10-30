import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 53 — 20261270 on a real (throwaway) Postgres, applied twice after
 * Batch 52's file: idempotent and additive. The release flag is created OFF,
 * the backfill unlocks exactly the workspaces whose Aiden is on, the stamp
 * only fills an empty column while Aiden is on (and never clears it), a
 * person reads and writes only their own design row, an AI app's OAuth token
 * can't write it, and mcp_workspace_apps lists this workspace's grants only.
 * Never the live database.
 */

const dir = import.meta.dirname;
const MIGRATIONS = join(dir, "../../supabase/aidwar-migrations");
const B52 = join(MIGRATIONS, "20261260_batch52_mcp.sql");
const MIGRATION = join(MIGRATIONS, "20261270_batch53_aiden_workspace.sql");
const ON = "00000000-0000-0000-0000-0000000053a1"; // Aiden replying before the file
const DRAFT = "00000000-0000-0000-0000-0000000053a2"; // Aiden drafting before the file
const OFF = "00000000-0000-0000-0000-0000000053a3"; // Aiden off
const OTHER = "00000000-0000-0000-0000-0000000053a4";
const U1 = "00000000-0000-0000-0000-0000000053c1";
const U2 = "00000000-0000-0000-0000-0000000053c2";
const U3 = "00000000-0000-0000-0000-0000000053c3";
const CLAUDE = "9a8b7c6d-0000-4000-8000-0000000053aa";
const CURSOR = "9a8b7c6d-0000-4000-8000-0000000053bb";

const claims = (sub: string, extra: Record<string, string> = {}) =>
  JSON.stringify({ sub, role: "authenticated", aud: "authenticated", ...extra });

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "20261270_batch53_aiden_workspace.sql (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(dir, "test-support/loadtest/schema.sql"),
        migrations: [
          join(dir, "test-support/storage-stubs.sql"),
          join(dir, "test-support/batch52-stubs.sql"),
          join(dir, "test-support/batch53-stubs.sql"),
          B52,
        ],
      });
      pg.sql(`insert into public.organizations (id, name) values ('${ON}', 'Zoori'), ('${DRAFT}', 'Draft shop'), ('${OFF}', 'Quiet shop'), ('${OTHER}', 'Other shop')`);
      pg.sql(`insert into public.ai_agents (organization_id, mode) values ('${ON}', 'replying'), ('${DRAFT}', 'draft'), ('${OFF}', 'off')`);
      pg.sql(`insert into auth.users (id) values ('${U1}'), ('${U2}'), ('${U3}')`);
      pg.sql(`insert into public.organization_members (organization_id, user_id, role) values ('${ON}', '${U1}', 'owner'), ('${ON}', '${U2}', 'agent'), ('${OTHER}', '${U3}', 'owner')`);
      // Applied twice: idempotent.
      pg.file(MIGRATION);
      pg.file(MIGRATION);
    }, 120_000);
    afterAll(() => pg?.stop());

    const as = (c: string, statement: string, method = "POST") =>
      pg.sql(
        `begin; set local role authenticated; set local request.jwt.claims = '${c}'; set local request.method = '${method}'; ${statement}; commit;`,
      );
    const unlocked = (org: string) =>
      pg.sql(`select aiden_workspace_unlocked_at is not null from public.organizations where id = '${org}'`);

    it("creates the release flag OFF, with its registry row and permission, once", () => {
      expect(pg.sql("select default_enabled from public.feature_flags where key = 'aiden_workspace'")).toBe("f");
      expect(pg.sql("select count(*) from public.feature_registry where key = 'aiden_workspace'")).toBe("1");
      expect(pg.sql("select analytics->'event_types' from public.feature_registry where key = 'aiden_workspace'")).toBe('["design.switched"]');
      expect(pg.sql("select count(*) from public.role_permissions where permission_key = 'aiden_workspace.switch'")).toBe("4");
      // Applying it again never turns a released flag back off.
      pg.sql("update public.feature_flags set default_enabled = true where key = 'aiden_workspace'");
      pg.file(MIGRATION);
      expect(pg.sql("select default_enabled from public.feature_flags where key = 'aiden_workspace'")).toBe("t");
      pg.sql("update public.feature_flags set default_enabled = false where key = 'aiden_workspace'");
    });

    it("puts the AI assistants page on the mcp registry row", () => {
      expect(pg.sql("select name || '|' || nav_path || '|' || nav_permission from public.feature_registry where key = 'mcp'")).toBe(
        "AI assistants|/app/ai-assistants|mcp.use",
      );
      expect(pg.sql("select 'mcp_access_changed' = any(activity_actions) from public.feature_registry where key = 'mcp'")).toBe("t");
    });

    it("backfill: every workspace whose Aiden is on is unlocked, the others are not", () => {
      expect(unlocked(ON)).toBe("t");
      expect(unlocked(DRAFT)).toBe("t");
      expect(unlocked(OFF)).toBe("f");
      expect(unlocked(OTHER)).toBe("f");
    });

    it("the stamp: unlocks on the first Aiden-on, never while off, and stays after Aiden is switched off", () => {
      expect(pg.sql(`select public.aiden_workspace_stamp_unlock('${OFF}') is null`)).toBe("t");
      expect(unlocked(OFF)).toBe("f");
      pg.sql(`update public.ai_agents set mode = 'draft' where organization_id = '${OFF}'`);
      const first = pg.sql(`select public.aiden_workspace_stamp_unlock('${OFF}')`);
      expect(first).not.toBe("");
      // Idempotent: a second call keeps the first time.
      expect(pg.sql(`select public.aiden_workspace_stamp_unlock('${OFF}')`)).toBe(first);
      pg.sql(`update public.ai_agents set mode = 'off' where organization_id = '${OFF}'`);
      expect(pg.sql(`select public.aiden_workspace_stamp_unlock('${OFF}')`)).toBe(first);
      expect(unlocked(OFF)).toBe("t");
    });

    it("the stamp and the apps list are service role only", () => {
      for (const fn of ["aiden_workspace_stamp_unlock(uuid)", "mcp_workspace_apps(uuid, uuid)"]) {
        expect(pg.sql(`select has_function_privilege('authenticated', 'public.${fn}', 'execute')`)).toBe("f");
        expect(pg.sql(`select has_function_privilege('service_role', 'public.${fn}', 'execute')`)).toBe("t");
      }
    });

    it("a person reads and writes only their own design row", () => {
      as(claims(U1), `insert into public.user_design_preferences (user_id, design) values ('${U1}', 'classic')`);
      expect(() => as(claims(U1), `insert into public.user_design_preferences (user_id, design) values ('${U2}', 'classic')`)).toThrow();
      as(claims(U1), `update public.user_design_preferences set design = 'aiden_workspace' where user_id = '${U1}'`);
      pg.sql(`insert into public.user_design_preferences (user_id, design) values ('${U2}', 'classic')`);
      // U1 can't see or change U2's row.
      expect(as(claims(U1), "select count(*) from public.user_design_preferences", "GET")).toContain("1");
      as(claims(U1), `update public.user_design_preferences set design = 'aiden_workspace' where user_id = '${U2}'`);
      expect(pg.sql(`select design from public.user_design_preferences where user_id = '${U2}'`)).toBe("classic");
      expect(pg.sql(`select design from public.user_design_preferences where user_id = '${U1}'`)).toBe("aiden_workspace");
      expect(() => pg.sql(`insert into public.user_design_preferences (user_id, design) values ('${U3}', 'sidebar')`)).toThrow();
    });

    it("the new table gets the no-OAuth-write policies (an AI app's token can't write it)", () => {
      const rows = pg
        .sql("select cmd || ':' || permissive from pg_policies where tablename = 'user_design_preferences' and policyname like 'aidwar_mcp_no_oauth_%' order by 1")
        .split("\n");
      expect(rows).toEqual(["INSERT:RESTRICTIVE", "UPDATE:RESTRICTIVE"]);
      expect(() =>
        as(claims(U3, { client_id: CLAUDE }), `insert into public.user_design_preferences (user_id, design) values ('${U3}', 'classic')`),
      ).toThrow();
    });

    it("mcp_workspace_apps: this workspace's members' live grants, last used from their sessions", () => {
      pg.sql(`insert into auth.oauth_clients (id, client_name, client_uri) values ('${CLAUDE}', 'Claude', 'https://claude.ai'), ('${CURSOR}', 'Cursor', null)`);
      pg.sql(`insert into auth.oauth_consents (user_id, client_id, granted_at) values
        ('${U1}', '${CLAUDE}', now() - interval '3 days'),
        ('${U2}', '${CURSOR}', now() - interval '1 day'),
        ('${U3}', '${CLAUDE}', now())`);
      pg.sql(`insert into auth.oauth_consents (user_id, client_id, revoked_at) values ('${U2}', '${CLAUDE}', now())`);
      pg.sql(`insert into auth.sessions (user_id, updated_at, oauth_client_id) values ('${U1}', '2026-10-29 10:00+00', '${CLAUDE}')`);
      const all = pg.sql(`select client_name || ':' || user_id || ':' || coalesce(to_char(last_used_at at time zone 'UTC', 'YYYY-MM-DD'), '-') from public.mcp_workspace_apps('${ON}') order by 1`);
      expect(all.split("\n")).toEqual([`Claude:${U1}:2026-10-29`, `Cursor:${U2}:-`]);
      const own = pg.sql(`select client_name from public.mcp_workspace_apps('${ON}', '${U2}')`);
      expect(own).toBe("Cursor");
    });

    it("mcp_workspace_apps answers nothing (never an error) without the OAuth tables", () => {
      pg.sql("alter table auth.oauth_consents rename to oauth_consents_off");
      expect(pg.sql(`select count(*) from public.mcp_workspace_apps('${ON}')`)).toBe("0");
      pg.sql("alter table auth.oauth_consents_off rename to oauth_consents");
      pg.sql("alter table auth.sessions rename column oauth_client_id to client_off");
      expect(pg.sql(`select count(*) from public.mcp_workspace_apps('${ON}')`)).toBe("2");
      pg.sql("alter table auth.sessions rename column client_off to oauth_client_id");
    });
  },
);

describe("20261270 is additive", () => {
  const sql = readFileSync(MIGRATION, "utf8");
  it("drops nothing, creates no trigger, ends with the Batch 52 rule", () => {
    const body = sql.replace(/--.*$/gm, "");
    expect(body).not.toMatch(/\bdrop\s+(table|column|function)\b/i);
    expect(body).not.toMatch(/create\s+(or\s+replace\s+)?trigger/i);
    expect(body.trim().toLowerCase().endsWith("select public.mcp_block_oauth_writes();")).toBe(true);
    expect(body).toMatch(/'aiden_workspace',[\s\S]*?false\s*\)/);
  });
});
