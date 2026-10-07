import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryDb } from "./test-support/memory-db";
import { ORG_ROW, PRODUCTS } from "./test-support/zoori-replay";

/**
 * Batch 14.1 — the flows "Show products" step must send exactly what it sent
 * on main. The gender rule (untagged products kept) and the rings/earrings
 * split apply only to brokered calls (Aiden); this step calls the catalogue
 * handler directly. The live-flows replay has no "Show products" step, so
 * this pins the step itself: 72 queries over Zoori's catalogue slice —
 * shelves (incl. "gents rings", "ladies rings", "rings" vs "earrings"),
 * budgets and limits — every WhatsApp payload compared byte for byte with
 * aiden-replay/flows-show-products.json, recorded on main @ 12f8a3a with
 * REPLAY_WRITE=flows.
 */

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["flows_v2", "catalogs"]),
}));

const FILE = join(__dirname, "test-support", "aiden-replay", "flows-show-products.json");

const CATEGORIES = [
  "rings",
  "gents rings",
  "ladies rings",
  "Rings",
  "earrings",
  "jhumka",
  "Pendants",
  "tanmaniya",
  "",
  "Nose pins",
  "for him",
  "anguthi",
];
const BUDGETS: Array<{ minPrice: number | null; maxPrice: number | null }> = [
  { minPrice: null, maxPrice: null },
  { minPrice: null, maxPrice: 20000 },
  { minPrice: null, maxPrice: 50000 },
  { minPrice: 30000, maxPrice: null },
  { minPrice: 20000, maxPrice: 50000 },
  { minPrice: null, maxPrice: 5000 },
];

/**
 * The only queries allowed to differ from main, each with its reason.
 *
 * Batch 20 (an unknown category is never silently dropped): "Nose pins" is
 * not a category in Zoori's catalogue. On main, with a budget, its words were
 * dropped and every product in the budget went out in its place (rings,
 * tanmaniya) — under 5,000 the step even said "our nose pins start at
 * ₹18,016" and sent three rings. Now nothing is sent and the step takes its
 * "None match" path. Without a budget main already sent nothing (unchanged).
 */
const ALLOWED: Array<{ key: string; why: string }> = ["-20000", "-50000", "30000-", "20000-50000", "-5000"].map(
  (budget) => ({
    key: `Nose pins | ${budget}`,
    why: "a category the shop doesn't have is no longer swapped for other products (None match path)",
  }),
);

async function runAll(): Promise<Record<string, unknown>> {
  const { showProducts } = await import("./flow-products.server");
  const out: Record<string, unknown> = {};
  for (const category of CATEGORIES) {
    for (const budget of BUDGETS) {
      const sent: unknown[] = [];
      let n = 0;
      vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (String(url).includes("graph.facebook.com")) {
          sent.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(JSON.stringify({ messages: [{ id: `wamid.flow.${++n}` }] }));
        }
        throw new Error(`unexpected fetch ${String(url)}`);
      });
      const db = memoryDb({ products: PRODUCTS, organizations: [ORG_ROW] });
      const result = await showProducts(db.supabase, {
        organizationId: String(PRODUCTS[0]!["organization_id"]),
        contactId: "c1",
        conversationId: "cv1",
        to: "917981223192",
        phoneNumberId: "pn",
        accessToken: "tok",
        windowOpen: true,
        metadata: { kind: "flow_v2", run_id: "run-1", node_id: "n1" },
        query: { category, ...budget, limit: 5 },
      });
      vi.unstubAllGlobals();
      out[`${category || "(any)"} | ${budget.minPrice ?? ""}-${budget.maxPrice ?? ""}`] = {
        result,
        sent,
      };
    }
  }
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe("flows 'Show products' is byte-identical to main", () => {
  it("every one of the 72 queries sends exactly what main sent", async () => {
    const now = await runAll();
    expect(Object.keys(now)).toHaveLength(CATEGORIES.length * BUDGETS.length);
    if (process.env["REPLAY_WRITE"] === "flows") {
      mkdirSync(join(__dirname, "test-support", "aiden-replay"), { recursive: true });
      writeFileSync(FILE, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    expect(existsSync(FILE)).toBe(true);
    const main = readFileSync(FILE, "utf8");
    const recordedAll = JSON.parse(main) as Record<string, unknown>;
    // Every other query byte for byte; the ALLOWED ones send nothing now.
    const strip = (all: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(all).filter(([k]) => !ALLOWED.some((a) => a.key === k)));
    expect(`${JSON.stringify(strip(now), null, 2)}\n`).toBe(`${JSON.stringify(strip(recordedAll), null, 2)}\n`);
    for (const a of ALLOWED) {
      expect(recordedAll[a.key]).toBeDefined();
      expect(now[a.key]).toEqual({ result: { ok: true, found: false, shown: 0, error: null }, sent: [] });
    }
    // The matrix really exercises the cases the gender/shelf rules touch.
    const recorded = JSON.parse(main) as Record<string, { sent: unknown[] }>;
    expect(JSON.stringify(recorded["rings | -"]!.sent)).toMatch(/Gilded Chevron/);
    expect(JSON.stringify(recorded["gents rings | -"]!.sent)).toMatch(/Onyx Skyline/);
  });
});
