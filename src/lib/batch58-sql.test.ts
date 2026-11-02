import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 58 on a real (throwaway) Postgres, never the live database:
 *  - 20261310 applies after 20261260 and 20261300, twice, and ends with the
 *    two OAuth guards;
 *  - scripts/batch58-reply-recount.sql is a single read-only SELECT that
 *    lists exactly the campaigns whose reply counts change under the new rule
 *    (the "test" / "demoo" shape: replied with nothing delivered).
 */

const dir = import.meta.dirname;
const MIGRATIONS = join(dir, "../../supabase/aidwar-migrations");
const MIGRATION = join(MIGRATIONS, "20261310_batch58.sql");
const RECOUNT = join(dir, "../../scripts/batch58-reply-recount.sql");
const ORG = "00000000-0000-0000-0000-0000000058a1";

describe("20261310_batch58.sql: additive, ends with the OAuth guards", () => {
  it("no DDL at all; its body ends with mcp_block_oauth_writes() then mcp_block_oauth_reads()", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const statements = sql
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("--"));
    expect(statements).toEqual(["SELECT public.mcp_block_oauth_writes();", "SELECT public.mcp_block_oauth_reads();"]);
  });

  it("the recount report only reads", () => {
    const sql = readFileSync(RECOUNT, "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .toLowerCase();
    expect(sql).not.toMatch(/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/);
    expect(sql.trim().startsWith("with")).toBe(true);
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))("Batch 58 SQL on a real Postgres", () => {
  let pg: ScratchPg;

  beforeAll(() => {
    pg = startScratchPg({
      schemaFile: join(dir, "test-support/loadtest/schema.sql"),
      migrations: [
        join(dir, "test-support/storage-stubs.sql"),
        join(dir, "test-support/batch52-stubs.sql"),
        join(dir, "test-support/batch56-stubs.sql"),
        join(MIGRATIONS, "20261260_batch52_mcp.sql"),
        join(MIGRATIONS, "20261300_batch56_mcp_hardening.sql"),
        MIGRATION,
        MIGRATION,
      ],
    });
    const contact = (n: number) => `00000000-0000-0000-0000-00000058c00${n}`;
    const conv = "00000000-0000-0000-0000-0000000058d1";
    pg.sql(`insert into public.organizations (id, name) values ('${ORG}', 'Meezoy')`);
    for (const n of [1, 2, 3, 4]) {
      pg.sql(`insert into public.contacts (id, organization_id, phone, name) values ('${contact(n)}', '${ORG}', '+91980000000${n}', 'C${n}')`);
    }
    pg.sql(`insert into public.conversations (id, organization_id, contact_id) values ('${conv}', '${ORG}', '${contact(1)}')`);
    const campaign = (id: string, name: string, delivered: number, replied: number) =>
      pg.sql(
        `insert into public.campaigns (id, organization_id, name, delivered_count, replied_count, created_at)
         values ('${id}', '${ORG}', '${name}', ${delivered}, ${replied}, '2026-08-16T09:00:00Z')`,
      );
    const message = (id: string, at: string) =>
      pg.sql(
        `insert into public.messages (id, organization_id, conversation_id, direction, body, created_at)
         values ('${id}', '${ORG}', '${conv}', 'outbound', 'x', '${at}')`,
      );
    const recipient = (campaignId: string, n: number, status: string, messageId: string | null, repliedAt: string | null) =>
      pg.sql(
        `insert into public.campaign_recipients (campaign_id, organization_id, contact_id, phone, status, message_id, replied_at)
         values ('${campaignId}', '${ORG}', '${contact(n)}', '+91980000000${n}', '${status}', ${messageId ? `'${messageId}'` : "null"}, ${repliedAt ? `'${repliedAt}'` : "null"})`,
      );
    // "test": delivered 0, replied 1 — the recipient never got past 'sent'.
    campaign("00000000-0000-0000-0000-0000000058e1", "test", 0, 1);
    message("00000000-0000-0000-0000-0000000058f1", "2026-08-16T10:00:00Z");
    recipient("00000000-0000-0000-0000-0000000058e1", 1, "sent", "00000000-0000-0000-0000-0000000058f1", "2026-08-16T10:05:00Z");
    // "demoo": the reply came before the campaign message was sent.
    campaign("00000000-0000-0000-0000-0000000058e2", "demoo", 0, 1);
    message("00000000-0000-0000-0000-0000000058f2", "2026-08-16T11:00:00Z");
    recipient("00000000-0000-0000-0000-0000000058e2", 2, "read", "00000000-0000-0000-0000-0000000058f2", "2026-08-16T10:59:00Z");
    // "good": delivered, replied after the send — unchanged, not listed.
    campaign("00000000-0000-0000-0000-0000000058e3", "good", 1, 1);
    message("00000000-0000-0000-0000-0000000058f3", "2026-08-16T12:00:00Z");
    recipient("00000000-0000-0000-0000-0000000058e3", 3, "delivered", "00000000-0000-0000-0000-0000000058f3", "2026-08-16T12:30:00Z");
    // "late": replied 9 days after the send.
    campaign("00000000-0000-0000-0000-0000000058e4", "late", 1, 1);
    message("00000000-0000-0000-0000-0000000058f4", "2026-08-16T12:00:00Z");
    recipient("00000000-0000-0000-0000-0000000058e4", 4, "delivered", "00000000-0000-0000-0000-0000000058f4", "2026-08-25T12:00:00Z");
  }, 120_000);
  afterAll(() => pg?.stop());

  it("applied twice without error, and the guards still answer", () => {
    expect(pg.sql("select public.mcp_block_oauth_writes()")).toMatch(/^\d+$/);
    expect(pg.sql("select public.mcp_block_oauth_reads()")).toMatch(/^\d+$/);
  });

  it("the recount lists exactly the campaigns whose reply count would change, with the reason", () => {
    const out = pg
      .file(RECOUNT)
      .trim()
      .split("\n")
      .map((l) => l.split("|"));
    // workspace, campaign, delivered_count, read_count, replied_count, replied_rows_now, replied_new_rule, dropped…
    const byName = new Map(out.map((cols) => [cols[3], cols]));
    expect([...byName.keys()].sort()).toEqual(["demoo", "late", "test"]);
    const pick = (name: string) => {
      const c = byName.get(name)!;
      return { replied: Number(c[7]), rule: Number(c[9]), notDelivered: Number(c[10]), beforeSend: Number(c[11]), late: Number(c[12]) };
    };
    expect(pick("test")).toEqual({ replied: 1, rule: 0, notDelivered: 1, beforeSend: 0, late: 0 });
    expect(pick("demoo")).toEqual({ replied: 1, rule: 0, notDelivered: 0, beforeSend: 1, late: 0 });
    expect(pick("late")).toEqual({ replied: 1, rule: 0, notDelivered: 0, beforeSend: 0, late: 1 });
  });

  it("the report wrote nothing", () => {
    expect(pg.sql("select sum(replied_count) from public.campaigns")).toBe("4");
    expect(pg.sql("select count(*) from public.campaign_recipients where replied_at is not null")).toBe("4");
  });
});
