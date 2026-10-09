import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";
import { fakeDb } from "./test-support/fake-db";
import { aiCostTotals, aiUsageByOrgMonth, resetAiCostTotalsCache } from "./billing-ai-economics.server";
import { platformCapState } from "./ai-run.server";

/**
 * Batch 28 item 3 — /admin/ai showed provider cost Rs 22.01 and "Runs · 30
 * days 1000" while the real 30-day cost was ~Rs 830: rows read with
 * PostgREST's 1,000-row cap and summed in JS. One SQL aggregate
 * (ai_cost_totals, service role only) now feeds /admin/ai, the /admin/billing
 * AI margin and the platform monthly ceiling, so the three agree.
 */

const dir = join(import.meta.dirname, "../../supabase/aidwar-migrations");
const MIGRATION = join(dir, "20261082_batch28_ai_cost_totals.sql");
const SCHEMA = join(import.meta.dirname, "test-support/loadtest/schema.sql");
const STUBS = join(import.meta.dirname, "test-support/wallet-stubs.sql");
const runSql = pgAvailable() || Boolean(process.env["CI"]);

afterEach(() => {
  resetAiCostTotalsCache();
  vi.restoreAllMocks();
});

describe.runIf(runSql)("item 3 — ai_cost_totals (real Postgres)", () => {
  let pg: ScratchPg;
  beforeAll(() => {
    pg = startScratchPg({ schemaFile: SCHEMA, migrations: [STUBS, MIGRATION] });
  }, 120_000);
  afterAll(() => pg?.stop());

  it("sums every run in the window — 2,500 runs, not the first 1,000", () => {
    const org = pg.sql(`insert into organizations (name) values ('Big') returning id`);
    pg.sql(`insert into ai_runs (organization_id, status, cost_amount, billed_amount, tier, created_at)
            select '${org}', case when g % 10 = 0 then 'error' else 'ok' end, 0.33, 0.99,
                   case when g % 4 = 0 then 'careful' else 'everyday' end, now() - interval '1 day'
              from generate_series(1, 2500) g`);
    pg.sql(`insert into ai_runs (organization_id, status, cost_amount, billed_amount, created_at)
            values ('${org}', 'ok', 50, 150, now() - interval '40 days')`); // outside 30 days
    const t = JSON.parse(pg.sql(`select public.ai_cost_totals(now() - interval '30 days', null, '${org}')`));
    expect(t).toMatchObject({ runs: 2500, ok_runs: 2250, charged: null, by_org_month: [] });
    expect(Number(t.provider_cost)).toBeCloseTo(825, 6);
    expect(Number(t.billed)).toBeCloseTo(2475, 6);
    expect(t.everyday + t.careful).toBe(2250);
  });

  it("the breakdown adds up to the totals, per workspace and IST month, with what the wallet charged", () => {
    const a = pg.sql(`insert into organizations (name) values ('A') returning id`);
    const b = pg.sql(`insert into organizations (name) values ('B') returning id`);
    const run = pg.sql(`insert into ai_runs (organization_id, status, cost_amount, billed_amount, created_at)
                        values ('${a}', 'ok', 1, 3, '2026-09-30T19:00:00Z') returning id`); // 1 Oct IST
    pg.sql(`insert into ai_runs (organization_id, status, cost_amount, billed_amount, created_at) values ('${b}', 'ok', 2, 6, '2026-10-05T05:00:00Z')`);
    pg.sql(`insert into wallet_ledger (organization_id, entry_type, amount, reference_type, reference_id) values ('${a}', 'debit_ai', -3, 'ai_run', '${run}')`);
    const t = JSON.parse(
      pg.sql(`select public.ai_cost_totals('2026-09-30T18:30:00Z', '2026-10-31T18:30:00Z', null, true)`),
    );
    const mine = (t.by_org_month as Array<Record<string, unknown>>).filter((g) => g["organization_id"] === a || g["organization_id"] === b);
    expect(mine.map((g) => [g["month"], Number(g["provider_cost"]), Number(g["charged"])]).sort()).toEqual([
      ["2026-10", 1, 3],
      ["2026-10", 2, 0],
    ]);
    const sum = (t.by_org_month as Array<Record<string, number>>).reduce((s, g) => s + Number(g["provider_cost"]), 0);
    expect(sum).toBeCloseTo(Number(t.provider_cost), 6);
  });

  it("service role only: anon and authenticated can't execute it", () => {
    const sig = "public.ai_cost_totals(timestamptz, timestamptz, uuid, boolean)";
    expect(pg.sql(`select has_function_privilege('anon', '${sig}', 'execute')`)).toBe("f");
    expect(pg.sql(`select has_function_privilege('authenticated', '${sig}', 'execute')`)).toBe("f");
    expect(pg.sql(`select has_function_privilege('service_role', '${sig}', 'execute')`)).toBe("t");
  });

  it("applies twice without error (idempotent)", () => {
    pg.sql(readFileSync(MIGRATION, "utf8"));
  });
});

describe("item 3 — the three readers use the same function", () => {
  const totalsRow = {
    runs: 2500, ok_runs: 2250, provider_cost: 830.12, billed: 2490.36, charged: 40, everyday: 2000, careful: 250,
    by_org_month: [{ organization_id: "o1", month: "2026-10", runs: 2500, ok_runs: 2250, provider_cost: 830.12, billed: 2490.36, charged: 40, everyday: 2000, careful: 250 }],
  };

  it("the platform ceiling's spent = ai_cost_totals' billed for this IST month", async () => {
    const db = fakeDb(
      (op) => (op.table === "platform_settings" ? { data: { ai_monthly_cap_amount: 10_000, ai_cap_currency: "INR" }, error: null } : undefined),
      (call) => (call.name === "ai_cost_totals" ? { data: totalsRow, error: null } : undefined),
    );
    const state = await platformCapState(db.supabase);
    expect(state.spent).toBeCloseTo(2490.36);
    expect(db.rpcs.map((c) => c.name)).toEqual(["ai_cost_totals"]);
    const p = db.rpcs[0]!.args;
    expect(p["p_to"]).toBeNull();
    expect(Date.parse(String(p["p_from"])) % 86_400_000).toBe(18.5 * 3_600_000); // midnight IST
  });

  it("/admin/billing's AI margin: provider cost and charged from ai_cost_totals, answers stay the frozen ones", async () => {
    const db = fakeDb(
      (op) => (op.table === "ai_usage_months"
        ? { data: [{ organization_id: "o1", month: "2026-10-01", allowance: 500, answers: 120, over_answers: 0, billed_amount: 1, provider_cost: 22.01 }], error: null }
        : undefined),
      (call) => (call.name === "ai_cost_totals" ? { data: totalsRow, error: null } : undefined),
    );
    const out = (await aiUsageByOrgMonth(db.supabase, "2026-10", "2026-10")).get("o1|2026-10")!;
    expect(out).toMatchObject({ answers: 120, provider_cost: 830.12, billed: 40, margin: 40 - 830.12, everyday_pct: 89, careful_pct: 11 });
    expect(db.ops.some((o) => o.table === "ai_runs")).toBe(false); // no raw rows read any more
  });

  it("/admin/ai reads the totals from the function, never from rows", () => {
    const route = readFileSync(join(import.meta.dirname, "../routes/api/admin/ai.ts"), "utf8");
    expect(route).toMatch(/aiCostTotals\(supabase, \{ fromIso: new Date\(Date\.now\(\) - 30 \* 864e5\)\.toISOString\(\) \}\)/);
    expect(route).not.toMatch(/\.from\("ai_runs"\)\s*\.select\("cost_amount, billed_amount/);
    expect(route).toMatch(/platformMonthSpend\(supabase\)/);
  });
});

describe("item 3 — before 20261082 is applied (PGRST202)", () => {
  const missing = { data: null, error: { code: "PGRST202", message: "Could not find the function public.ai_cost_totals" } };

  it("totals say unavailable with the reason — never a smaller number", async () => {
    const db = fakeDb(() => undefined, (call) => (call.name === "ai_cost_totals" ? missing : undefined));
    expect(await aiCostTotals(db.supabase, { fromIso: "2026-10-01T00:00:00Z" })).toEqual({ ok: false, error: missing.error.message, code: "PGRST202" });
    const ui = readFileSync(join(import.meta.dirname, "../routes/admin/ai.tsx"), "utf8");
    expect(ui).toMatch(/data\.totals \? money\(data\.totals\.cost\) : "Unavailable"/);
  });

  it("the ceiling falls back to platform_ai_month_spend, and asks for the missing function at most every 10 minutes", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fakeDb(
      (op) => (op.table === "platform_settings" ? { data: { ai_monthly_cap_amount: 100, ai_cap_currency: "INR" }, error: null } : undefined),
      (call) => (call.name === "ai_cost_totals" ? missing : call.name === "platform_ai_month_spend" ? { data: 42, error: null } : undefined),
    );
    expect((await platformCapState(db.supabase)).spent).toBe(42);
    expect((await platformCapState(db.supabase)).spent).toBe(42);
    expect(db.rpcs.map((c) => c.name)).toEqual(["ai_cost_totals", "platform_ai_month_spend", "platform_ai_month_spend"]);
  });

  it("/admin/billing keeps the frozen month totals", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = fakeDb(
      (op) => (op.table === "ai_usage_months"
        ? { data: [{ organization_id: "o1", month: "2026-10-01", allowance: 500, answers: 3, over_answers: 0, billed_amount: 2, provider_cost: 0.5 }], error: null }
        : op.table === "ai_runs" ? { data: [], error: null } : undefined),
      (call) => (call.name === "ai_cost_totals" ? missing : undefined),
    );
    expect((await aiUsageByOrgMonth(db.supabase, "2026-10", "2026-10")).get("o1|2026-10")).toMatchObject({ provider_cost: 0.5, billed: 2 });
  });
});
