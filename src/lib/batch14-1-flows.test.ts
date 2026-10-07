import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryDb } from "./test-support/memory-db";
import { PRODUCTS } from "./test-support/zoori-replay";

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
      const db = memoryDb({ products: PRODUCTS });
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
    expect(`${JSON.stringify(now, null, 2)}\n`).toBe(main);
    // The matrix really exercises the cases the gender/shelf rules touch.
    const recorded = JSON.parse(main) as Record<string, { sent: unknown[] }>;
    expect(JSON.stringify(recorded["rings | -"]!.sent)).toMatch(/Gilded Chevron/);
    expect(JSON.stringify(recorded["gents rings | -"]!.sent)).toMatch(/Onyx Skyline/);
  });
});
