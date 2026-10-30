import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";
import { mcpDbProof, mcpDbProofHash } from "./mcp-db-proof.server";

/**
 * Batch 56 — 20261300 on a real (throwaway) Postgres after 20261260, applied
 * twice. Each Supabase surface is played as it runs against the database:
 *  - PostgREST: role authenticated, request.jwt.claims / request.method /
 *    request.headers set for the transaction, the pre-request guard, then
 *    the statement (tables, a SECURITY DEFINER function as /rpc does);
 *  - Realtime (postgres_changes and private Broadcast): the claims and role,
 *    no request headers, no guard — the row read under RLS;
 *  - Storage: the claims and role, then storage.objects / buckets.
 * A raw OAuth token (client_id) gets nothing; the same token with the MCP
 * server's proof reads (and still can't write); app sessions, anon and
 * service_role are untouched. Never the live database.
 */

const dir = import.meta.dirname;
const MIGRATIONS = join(dir, "../../supabase/aidwar-migrations");
const BATCH52 = join(MIGRATIONS, "20261260_batch52_mcp.sql");
const MIGRATION = join(MIGRATIONS, "20261300_batch56_mcp_hardening.sql");
const ORG = "00000000-0000-0000-0000-0000000056a1";
const USER = "00000000-0000-0000-0000-0000000056c3";
const CLIENT = "9a8b7c6d-0000-4000-8000-0000000056aa";
const SECRET = "test-service-role-key-for-batch56";

const appClaims = JSON.stringify({ sub: USER, role: "authenticated", aud: "authenticated", session_id: "s1" });
const oauthClaims = JSON.stringify({ sub: USER, role: "authenticated", aud: "authenticated", client_id: CLIENT });
const anonClaims = JSON.stringify({ role: "anon" });
const serviceClaims = JSON.stringify({ role: "service_role" });

/** The rollback block at the end of the migration, without its "-- ". */
function rollbackSql(): string {
  const text = readFileSync(MIGRATION, "utf8");
  const block = text.slice(text.indexOf("-- ROLLBACK BEGIN") + "-- ROLLBACK BEGIN".length, text.indexOf("-- ROLLBACK END"));
  return block
    .split("\n")
    .map((l) => l.replace(/^-- ?/, ""))
    .join("\n");
}

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))("20261300_batch56_mcp_hardening.sql (real Postgres)", () => {
  let pg: ScratchPg;
  let proof = "";
  let hash = "";

  beforeAll(async () => {
    proof = await mcpDbProof(SECRET);
    hash = await mcpDbProofHash(proof);
    pg = startScratchPg({
      schemaFile: join(dir, "test-support/loadtest/schema.sql"),
      migrations: [
        join(dir, "test-support/storage-stubs.sql"),
        join(dir, "test-support/batch52-stubs.sql"),
        join(dir, "test-support/batch56-stubs.sql"),
        BATCH52,
        MIGRATION,
        MIGRATION,
      ],
    });
    pg.sql(`insert into public.organizations (id, name) values ('${ORG}', 'Shop A')`);
    pg.sql(`insert into public.contacts (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000056e1', '${ORG}', '+919800000001', 'Asha')`);
    pg.sql(`insert into public.conversations (id, organization_id, contact_id) values ('00000000-0000-0000-0000-0000000056f1', '${ORG}', '00000000-0000-0000-0000-0000000056e1')`);
    pg.sql(`insert into public.messages (organization_id, conversation_id, direction, body) values ('${ORG}', '00000000-0000-0000-0000-0000000056f1', 'inbound', 'private words')`);
    pg.sql(`insert into public.campaigns (organization_id, name) values ('${ORG}', 'Diwali')`);
    pg.sql(`insert into storage.buckets (id, name) values ('chat-media', 'chat-media') on conflict do nothing`);
    pg.sql(`insert into storage.objects (bucket_id, name) values ('chat-media', '${ORG}/photo.jpg')`);
    pg.sql(`insert into realtime.messages (topic, payload) values ('org:${ORG}', '{"hello":1}')`);
  }, 120_000);
  afterAll(() => pg?.stop());

  const headers = (p: string | null) => (p === null ? "{}" : JSON.stringify({ "x-aidwar-mcp-proof": p, "user-agent": "aidwar-mcp" }));

  /** One request as PostgREST runs it: GUCs, the pre-request guard, the statement. */
  const rest = (claims: string, statement: string, opts: { method?: string; proof?: string | null; rawHeaders?: string } = {}) =>
    pg.sql(
      `begin; set local role authenticated; set local request.jwt.claims = '${claims}'; set local request.method = '${opts.method ?? "GET"}'; ` +
        `set local request.headers = '${opts.rawHeaders ?? headers(opts.proof ?? null)}'; select public.mcp_oauth_request_guard(); ${statement}; commit;`,
    );
  /** As Realtime / Storage read a row for a subscriber: claims and role, no headers, no guard. */
  const direct = (claims: string, statement: string) =>
    pg.sql(`begin; set local role authenticated; set local request.jwt.claims = '${claims}'; ${statement}; commit;`);
  const asService = (statement: string) =>
    pg.sql(`begin; set local role service_role; set local request.jwt.claims = '${serviceClaims}'; ${statement}; commit;`);
  const n = (s: string) => Number(s.split("\n").filter(Boolean).pop());

  it("fails closed before the bootstrap: a client_id token is refused even with the right proof; app sessions are untouched", () => {
    expect(pg.sql("select count(*) from aidwar_private.mcp_db_proof")).toBe("0");
    expect(() => rest(oauthClaims, "select 1", { proof })).toThrow(/only through the AiDwar MCP tools/);
    expect(n(direct(oauthClaims, "select count(*) from public.contacts"))).toBe(0);
    expect(n(rest(appClaims, "select count(*) from public.contacts"))).toBe(1);
    expect(() => rest(appClaims, "select 1", { method: "POST" })).not.toThrow();
  });

  it("only service_role can store the proof's hash; members can't call the setter or see the table", () => {
    expect(() => direct(appClaims, `select public.mcp_set_db_proof_hash('${hash}')`)).toThrow(/permission denied/);
    expect(() => direct(oauthClaims, `select public.mcp_set_db_proof_hash('${hash}')`)).toThrow(/permission denied/);
    expect(() => pg.sql(`begin; set local role anon; select public.mcp_set_db_proof_hash('${hash}'); commit;`)).toThrow(/permission denied/);
    expect(() => direct(appClaims, "select * from aidwar_private.mcp_db_proof")).toThrow(/permission denied/);
    expect(() => asService("select public.mcp_set_db_proof_hash('not-a-hash')")).toThrow(/sha256 hex/);
    expect(asService(`select public.mcp_set_db_proof_hash('${hash}')`)).toBe("set");
    expect(asService(`select public.mcp_set_db_proof_hash('${hash}')`)).toBe("match");
    // Only the hash is stored, never the proof.
    expect(pg.sql("select proof_hash from aidwar_private.mcp_db_proof")).toBe(hash);
    expect(pg.sql("select count(*) from aidwar_private.mcp_db_proof")).toBe("1");
    // The database's sha256 is the server's.
    expect(pg.sql(`select encode(sha256(convert_to('${proof}', 'UTF8')), 'hex')`)).toBe(hash);
  });

  it("PostgREST: a raw OAuth token is refused for every method; with the proof it reads, and still can't write", () => {
    for (const method of ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"])
      expect(() => rest(oauthClaims, "select 1", { method }), method).toThrow(/only through the AiDwar MCP tools/);
    for (const t of ["contacts", "conversations", "messages", "campaigns"]) {
      expect(() => rest(oauthClaims, `select count(*) from public.${t}`), t).toThrow(/only through the AiDwar MCP tools/);
      expect(n(rest(oauthClaims, `select count(*) from public.${t}`, { proof })), t).toBe(1);
    }
    expect(n(rest(oauthClaims, "select count(*) from public.contacts", { method: "HEAD", proof }))).toBe(1);
    for (const method of ["POST", "PATCH", "PUT", "DELETE"])
      expect(() => rest(oauthClaims, "select 1", { method, proof }), method).toThrow(/can only read here/);
    // The write policies hold even with the proof, under the guard's level too.
    expect(() =>
      direct(oauthClaims, `set local request.headers = '${headers(proof)}'; insert into public.segments (organization_id, name) values ('${ORG}', 'From AI')`),
    ).toThrow(/row-level security/);
  });

  it("a wrong, edited, old or badly sent proof is refused", async () => {
    const other = await mcpDbProof("another-service-role-key");
    for (const bad of [other, proof.slice(0, -1) + (proof.endsWith("A") ? "B" : "A"), "", proof + " ", "x".repeat(300)])
      expect(() => rest(oauthClaims, "select 1", { proof: bad })).toThrow(/only through the AiDwar MCP tools/);
    expect(() => rest(oauthClaims, "select 1", { rawHeaders: "not json" })).toThrow(/only through the AiDwar MCP tools/);
    expect(() => rest(oauthClaims, "select 1", { rawHeaders: `["${proof}"]` })).toThrow(/only through the AiDwar MCP tools/);
    // Header names arrive lower-cased from PostgREST; another spelling isn't ours.
    expect(() => rest(oauthClaims, "select 1", { rawHeaders: JSON.stringify({ "X-AIDWAR-MCP-PROOF": proof }) })).toThrow(
      /only through the AiDwar MCP tools/,
    );
    // The key rotated: the new proof replaces the old one, which then stops working.
    expect(asService(`select public.mcp_set_db_proof_hash('${await mcpDbProofHash(other)}')`)).toBe("replaced");
    expect(n(rest(oauthClaims, "select count(*) from public.contacts", { proof: other }))).toBe(1);
    expect(() => rest(oauthClaims, "select 1", { proof })).toThrow(/only through the AiDwar MCP tools/);
    expect(asService(`select public.mcp_set_db_proof_hash('${hash}')`)).toBe("replaced");
  });

  it("RPC: a SECURITY DEFINER function (RLS doesn't apply inside) is refused before it runs", () => {
    expect(() => rest(oauthClaims, `select public.member_contact_count('${ORG}')`)).toThrow(/only through the AiDwar MCP tools/);
    expect(() => rest(oauthClaims, `select public.member_contact_count('${ORG}')`, { method: "POST" })).toThrow(/only through the AiDwar MCP tools/);
    expect(() => rest(oauthClaims, `select public.member_contact_count('${ORG}')`, { method: "POST", proof })).toThrow(/can only read here/);
    expect(rest(appClaims, `select public.member_contact_count('${ORG}')`, { method: "POST" }).split("\n").pop()).toBe("1");
  });

  it("Realtime: a raw OAuth token's postgres_changes and private Broadcast hear nothing, and it can't broadcast", () => {
    for (const t of ["messages", "conversations"]) {
      expect(n(direct(oauthClaims, `select count(*) from public.${t} where organization_id = '${ORG}'`)), t).toBe(0);
      expect(n(direct(appClaims, `select count(*) from public.${t} where organization_id = '${ORG}'`)), t).toBe(1);
    }
    expect(n(direct(oauthClaims, "select count(*) from realtime.messages"))).toBe(0);
    expect(n(direct(appClaims, "select count(*) from realtime.messages"))).toBe(1);
    expect(() => direct(oauthClaims, `insert into realtime.messages (topic, payload) values ('org:${ORG}', '{}')`)).toThrow(/row-level security/);
    direct(appClaims, `insert into realtime.messages (topic, payload) values ('org:${ORG}', '{"from":"app"}')`);
    expect(pg.sql("select count(*) from realtime.messages")).toBe("2");
  });

  it("Storage: a raw OAuth token lists and gets no file and no bucket", () => {
    expect(n(direct(oauthClaims, "select count(*) from storage.objects where bucket_id = 'chat-media'"))).toBe(0);
    expect(n(direct(oauthClaims, `select count(*) from storage.objects where name = '${ORG}/photo.jpg'`))).toBe(0);
    expect(n(direct(oauthClaims, "select count(*) from storage.buckets"))).toBe(0);
    expect(n(direct(appClaims, "select count(*) from storage.objects where bucket_id = 'chat-media'"))).toBe(1);
    expect(n(direct(appClaims, "select count(*) from storage.buckets"))).toBe(1);
  });

  it("app sessions keep every read and write; anon and service_role pass the guard as before", () => {
    for (const method of ["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"]) {
      expect(() => rest(appClaims, "select 1", { method }), method).not.toThrow();
      expect(() => rest(appClaims, "select 1", { method, proof: "anything" }), method).not.toThrow();
      expect(() => rest(anonClaims, "select 1", { method }), method).not.toThrow();
      expect(() => rest(serviceClaims, "select 1", { method }), method).not.toThrow();
    }
    expect(() => rest("not json", "select 1", { method: "POST" })).not.toThrow();
    rest(appClaims, `insert into public.segments (organization_id, name) values ('${ORG}', 'VIP')`, { method: "POST" });
    rest(appClaims, "update public.contacts set name = 'Asha K' where phone = '+919800000001'", { method: "PATCH" });
    expect(rest(appClaims, "select name from public.contacts", {}).split("\n").pop()).toBe("Asha K");
    rest(appClaims, "delete from public.segments where name = 'VIP'", { method: "DELETE" });
    expect(n(asService("select count(*) from public.contacts"))).toBe(1);
  });

  it("adds one restrictive SELECT policy per readable RLS table (and storage, realtime), once", () => {
    const rows = pg
      .sql("select schemaname || '.' || tablename || ':' || cmd || ':' || permissive from pg_policies where policyname = 'aidwar_mcp_oauth_select' order by 1")
      .split("\n");
    for (const t of ["contacts", "campaigns", "conversations", "messages", "segments", "message_templates"])
      expect(rows).toContain(`public.${t}:SELECT:RESTRICTIVE`);
    expect(rows).toContain("storage.objects:SELECT:RESTRICTIVE");
    expect(rows).toContain("storage.buckets:SELECT:RESTRICTIVE");
    expect(rows).toContain("realtime.messages:SELECT:RESTRICTIVE");
    // RLS-off tables are not given a policy (the guard covers them for PostgREST; a NOTICE names them).
    expect(rows.some((r) => r.startsWith("public.short_links:"))).toBe(false);
    expect(pg.sql("select public.mcp_block_oauth_reads()")).toBe("0");
    expect(pg.sql("select public.mcp_block_oauth_writes()")).toBe("0");
    expect(pg.sql("select count(*) from pg_policies where schemaname = 'realtime' and policyname = 'aidwar_mcp_no_oauth_insert'")).toBe("1");
    // A table that gets RLS later is covered by running the two functions again.
    pg.sql("create table if not exists public.later_table (id int primary key, organization_id uuid); alter table public.later_table enable row level security; grant select, insert on public.later_table to authenticated;");
    expect(pg.sql("select public.mcp_block_oauth_writes()")).toBe("1");
    expect(pg.sql("select public.mcp_block_oauth_reads()")).toBe("1");
  });

  it("is cheap: the proof check runs once per statement, and the guard costs well under a millisecond", () => {
    const plan = direct(oauthClaims, "explain (costs off) select * from public.contacts");
    expect(plan).toMatch(/InitPlan/);
    const timed = (claims: string, p: string | null) =>
      Number(
        pg.sql(
          `begin; set local role authenticated; set local request.jwt.claims = '${claims}'; set local request.method = 'GET'; set local request.headers = '${headers(p)}';` +
            ` do $$ declare t0 timestamptz := clock_timestamp(); begin for i in 1..2000 loop perform public.mcp_oauth_request_guard(); end loop;` +
            ` perform set_config('aidwar.t', (extract(epoch from clock_timestamp() - t0) * 1000)::text, true); end $$; select current_setting('aidwar.t'); commit;`,
        ).split("\n").pop(),
      );
    const withProof = timed(oauthClaims, proof) / 2000;
    const appSession = timed(appClaims, null) / 2000;
    expect(withProof).toBeLessThan(1);
    expect(appSession).toBeLessThan(1);
  });

  it("rolls back to Batch 52 exactly, and applies again afterwards", () => {
    const file = join(mkdtempSync(join(tmpdir(), "batch56-rollback-")), "rollback.sql");
    writeFileSync(file, rollbackSql());
    chmodSync(file, 0o644);
    chmodSync(join(file, ".."), 0o755);
    pg.file(file);
    expect(pg.sql("select count(*) from pg_policies where policyname = 'aidwar_mcp_oauth_select'")).toBe("0");
    expect(pg.sql("select count(*) from pg_policies where schemaname = 'realtime' and policyname like 'aidwar_mcp_%'")).toBe("0");
    expect(pg.sql("select to_regprocedure('public.mcp_request_has_proof()') is null and to_regprocedure('public.mcp_set_db_proof_hash(text)') is null and to_regprocedure('public.mcp_block_oauth_reads()') is null")).toBe("t");
    expect(pg.sql("select count(*) from pg_namespace where nspname = 'aidwar_private'")).toBe("0");
    // Batch 52's guard: OAuth may read without a proof, never write; its write policies stay.
    expect(() => rest(oauthClaims, "select 1")).not.toThrow();
    expect(() => rest(oauthClaims, "select 1", { method: "POST" })).toThrow(/can only read here/);
    expect(pg.sql("select count(*) from pg_policies where policyname like 'aidwar_mcp_no_oauth_%' and schemaname = 'public'")).not.toBe("0");
    // Re-applied: fail closed again until the hash is stored.
    pg.file(MIGRATION);
    expect(() => rest(oauthClaims, "select 1", { proof })).toThrow(/only through the AiDwar MCP tools/);
    expect(asService(`select public.mcp_set_db_proof_hash('${hash}')`)).toBe("set");
    expect(n(rest(oauthClaims, "select count(*) from public.contacts", { proof }))).toBe(1);
  });
});

describe("later migrations keep OAuth tokens out of new tables (reads too)", () => {
  it("any migration after 20261300 that turns RLS on runs mcp_block_oauth_writes() and mcp_block_oauth_reads()", () => {
    const later = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql") && f > "20261300_batch56_mcp_hardening.sql")
      .sort();
    for (const f of later) {
      const sql = readFileSync(join(MIGRATIONS, f), "utf8").toLowerCase();
      if (/enable\s+row\s+level\s+security/.test(sql)) {
        expect(sql, `${f} turns RLS on: add "select public.mcp_block_oauth_writes();" at its end`).toContain("mcp_block_oauth_writes()");
        expect(sql, `${f} turns RLS on: add "select public.mcp_block_oauth_reads();" at its end`).toContain("mcp_block_oauth_reads()");
      }
    }
  });

  it("20261300 itself ends with both block functions", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const body = sql.slice(0, sql.indexOf("-- ROLLBACK BEGIN")).trim().split("\n").slice(-2);
    expect(body).toEqual(["SELECT public.mcp_block_oauth_writes();", "SELECT public.mcp_block_oauth_reads();"]);
  });
});
