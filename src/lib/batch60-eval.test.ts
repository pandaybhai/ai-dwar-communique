import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QUESTIONS, evalOne, evalTable, type EvalRow } from "./test-support/batch60-eval";

/**
 * Batch 60 eval: 16 fixed questions × two shops (website-only Zoori-like, and
 * Zoori with its priced catalogue) through the real reply path, the model
 * scripted (test-support/batch60-eval.ts). main's run is recorded with
 * EVAL_WRITE=main in a checkout of main (main.json); this branch's run is
 * checked here and, with EVAL_WRITE=branch, recorded with the table (table.md).
 */

const DIR = join(__dirname, "test-support", "batch60-eval");

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalog"]),
}));

// The catalogue tools run for real against the shop's rows; only the
// permission broker around them is stubbed (as in the Batch 14/16 replays).
vi.mock("@/lib/ai-tools.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ai-tools.server")>();
  const { allAiTools } = await import("./feature-registry");
  const offered = () =>
    allAiTools()
      .filter((t) => t.name === "catalog_search" || t.name === "send_products")
      .map(({ flag_key: _flag, ...tool }) => tool);
  return {
    ...real,
    brokerTools: async () => offered(),
    invokeTool: async (
      ctx: Parameters<typeof real.invokeTool>[0],
      name: string,
      args: Record<string, unknown>,
    ) => {
      const tool = offered().find((t) => t.name === name);
      if (!tool)
        return {
          ok: false,
          error: "unavailable",
          latencyMs: 1,
          activityLogId: null,
          arguments: args,
          resultSummary: {},
        };
      const out = await real.AI_TOOL_HANDLERS[tool.handler]!({ ...ctx, brokered: true }, args);
      return {
        ...out,
        latencyMs: 1,
        activityLogId: null,
        arguments: args,
        resultSummary: typeof real.summarise === "function" ? real.summarise(out) : {},
      };
    },
  };
});

const rows: EvalRow[] = [];

beforeAll(async () => {
  process.env["LOVABLE_API_KEY"] = "test-key";
  vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 9, 6, 10, 20, 0) });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { runAgentOnInbound } = await import("./ai-agent.server");
  for (const shop of ["link-only", "catalogue"] as const) {
    for (const q of QUESTIONS) {
      rows.push(
        await evalOne(shop, q, runAgentOnInbound as never, (fn) => vi.stubGlobal("fetch", fn)),
      );
      vi.unstubAllGlobals();
    }
  }
  const mode = process.env["EVAL_WRITE"];
  if (mode === "main" || mode === "branch") {
    writeFileSync(join(DIR, `${mode}.json`), `${JSON.stringify(rows, null, 2)}\n`);
  }
  if (mode === "branch" && existsSync(join(DIR, "main.json"))) {
    const main = JSON.parse(readFileSync(join(DIR, "main.json"), "utf8")) as EvalRow[];
    writeFileSync(join(DIR, "table.md"), evalTable(main, rows));
  }
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
});

describe("Batch 60 eval: 16 questions × 2 shops (this branch)", () => {
  it("ran every question for both shops", () => {
    expect(rows).toHaveLength(32);
    expect(rows.every((r) => r.reply.length > 0)).toBe(true);
  });

  it("zero 'I don't have that detail' / 'Let me confirm' lines", () => {
    expect(rows.filter((r) => r.cold).map((r) => `${r.shop}/${r.key}: ${r.reply}`)).toEqual([]);
  });

  it("zero invented prices — the catalogue shop's guessed price and the gold rate never go out", () => {
    expect(rows.flatMap((r) => r.inventedAmounts.map((a) => `${r.shop}/${r.key}: ${a}`))).toEqual(
      [],
    );
    const catalogue = rows.find((r) => r.shop === "catalogue" && r.key === "ring-price")!;
    expect(catalogue.reply).not.toMatch(/35,000/);
    expect(catalogue.reply).toMatch(/₹\d/); // the real prices still show
  });

  it("at most 2 AI calls per reply (never 3); most replies take exactly 1", () => {
    expect(Math.max(...rows.map((r) => r.aiCalls))).toBeLessThanOrEqual(2);
    expect(rows.filter((r) => r.aiCalls === 1).length).toBeGreaterThanOrEqual(28);
    expect(rows.some((r) => r.calls.includes("rewrite"))).toBe(false);
  });

  it("every link sent comes from the shop's instructions or material", () => {
    expect(rows.flatMap((r) => r.foreignLinks.map((l) => `${r.shop}/${r.key}: ${l}`))).toEqual([]);
  });

  it("the live link sentence goes out as written (it was flagged on main)", () => {
    expect(rows.find((r) => r.shop === "link-only" && r.key === "ring-price")!.reply).toBe(
      "Great choice 💍 You can see every design with its latest price right here: https://myzoori.com",
    );
  });

  it("matches the recorded branch.json (re-record with EVAL_WRITE=branch when a change is deliberate)", () => {
    const path = join(DIR, "branch.json");
    if (!existsSync(path) || process.env["EVAL_WRITE"]) return;
    const recorded = JSON.parse(readFileSync(path, "utf8")) as EvalRow[];
    expect(rows.map(({ shop, key, reply, aiCalls }) => ({ shop, key, reply, aiCalls }))).toEqual(
      recorded.map(({ shop, key, reply, aiCalls }) => ({ shop, key, reply, aiCalls })),
    );
  });
});
