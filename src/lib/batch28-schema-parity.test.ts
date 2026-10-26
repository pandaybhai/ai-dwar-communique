import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";

/**
 * Batch 28 item 9 — after-deploy schema check. scripts/schema-parity.sql is
 * generated from supabase/aidwar-migrations by scripts/schema-parity.mjs: one
 * read-only query listing every function, table, column, index, trigger and
 * cron job those files create that is missing on the database it runs
 * against. (8 Oct: 20261016 had never been applied on live, and nothing said so.)
 */

type Expected = {
  kind: string;
  schema: string;
  name: string;
  sub: string | null;
  args: string[] | null;
  file: string;
};
type Generator = { generateSql: (e?: Expected[]) => string; collectExpected: () => Expected[] };

const ROOT = join(import.meta.dirname, "../..");
const COMMITTED = join(ROOT, "scripts/schema-parity.sql");
const load = async (): Promise<Generator> =>
  (await import(/* @vite-ignore */ join(ROOT, "scripts/schema-parity.mjs"))) as Generator;

describe("item 9 — the generated query", () => {
  it("is up to date with the migrations (regenerate: node scripts/schema-parity.mjs)", async () => {
    const { generateSql } = await load();
    expect(readFileSync(COMMITTED, "utf8")).toBe(generateSql());
  });

  it("expects what the migrations create — including the ones live was missing", async () => {
    const all = (await load()).collectExpected();
    const has = (kind: string, name: string, sub: string | null = null) =>
      all.some((e) => e.kind === kind && e.name === name && (sub === null || e.sub === sub));
    expect(has("function", "campaign_recipient_status")).toBe(true); // 20261016, missing on live until 8 Oct
    expect(has("function", "campaign_ledger_charge")).toBe(true);
    expect(has("column", "conversations", "handoff_alert_at")).toBe(true); // 20261024
    expect(has("column", "conversations", "handoff_alert_result")).toBe(true); // 20261080
    expect(has("function", "ai_cost_totals")).toBe(true); // 20261082
    expect(has("function", "ai_run_is_customer_answer")).toBe(true); // 20261084
    expect(has("index", "billing_notifications_invoice_sent_uidx")).toBe(true); // 20261083
    expect(has("cron_job", "aidwar-campaign-worker")).toBe(true); // 20261053
    expect(
      all.find((e) => e.kind === "function" && e.name === "campaign_recipient_status")!.args,
    ).toEqual(["uuid", "uuid", "text", "text"]);
  });

  it("never expects what a later file drops", async () => {
    const all = (await load()).collectExpected();
    // 20261016 drops these duplicate indexes (inside a DO block).
    expect(
      all.some((e) => e.name === "messages_meta_id_idx" || e.name === "messages_cost_idx"),
    ).toBe(false);
  });

  it("is one read-only statement", () => {
    const sql = readFileSync(COMMITTED, "utf8")
      .replace(/--.*$/gm, "")
      .replace(/'(?:[^']|'')*'/g, "''");
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(1);
    expect(statements[0]!.startsWith("WITH expected")).toBe(true);
    expect(sql).not.toMatch(/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/i);
  });
});

describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "item 9 — it runs (real Postgres, no pg_cron)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(import.meta.dirname, "test-support/loadtest/schema.sql"),
        migrations: [join(import.meta.dirname, "test-support/wallet-stubs.sql")],
      });
    }, 120_000);
    afterAll(() => pg?.stop());

    it("lists what this database lacks and nothing it has", () => {
      const rows = pg
        .file(COMMITTED)
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("|"));
      expect(rows.length).toBeGreaterThan(0);
      const names = rows.map((r) => `${r[0]} ${r[1]}`);
      // The load-test schema has these; a test stand-in lacks most migrations' objects.
      expect(names).not.toContain("table public.organizations");
      expect(names).not.toContain("table public.campaigns");
      expect(names).toContain(
        "function public.ai_cost_totals(timestamp with time zone, timestamp with time zone, uuid, boolean)",
      );
      const cron = rows.filter((r) => r[0] === "cron_job");
      expect(cron.length).toBeGreaterThan(0);
      expect(cron.every((r) => r[2] === "pg_cron not installed (cron.job missing)")).toBe(true);
    });

    it("an object created afterwards drops off the list", () => {
      const before = pg.file(COMMITTED);
      expect(before).toContain("public.conversations.handoff_alert_result");
      pg.sql(
        "alter table public.conversations add column if not exists handoff_alert_result jsonb",
      );
      expect(pg.file(COMMITTED)).not.toContain("public.conversations.handoff_alert_result");
    });
  },
);
