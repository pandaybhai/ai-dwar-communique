import { afterEach, describe, expect, it, vi } from "vitest";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";

/**
 * Batch 16 item 6 — flows "Show products" correctness, the parts that need
 * the webhook or the step itself (the 72-query differential is in
 * batch14-1-flows.test.ts; its changed cases are listed in the PR).
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("(d) a list/button tap after the flow ended is never silently dropped", () => {
  it("no run waiting: the tap goes to Aiden's path as a normal message (route 'ai', the agent set-up read)", async () => {
    const { processWebhookPayload } = await import("./whatsapp-webhook.server");
    const w = latencyWorld({ org: "b16-stale", rttMs: 0, graphMs: 0, waitingRun: false });
    vi.stubGlobal("fetch", w.fetchStub);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    const tap = { id: "wamid.stale", type: "interactive", interactive: { type: "list_reply", list_reply: { id: "nmuux8kg1a:rmuux9gv4d", title: "₹50k–1L" } }, context: { id: "wamid.prompt" } };
    await processWebhookPayload(w.supabase, "ev-b16-stale", inboundPayload(tap), new Date(Date.now() - 300).toISOString(), { storeMs: 10 });
    const timing = logs.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).find((j) => j?.["scope"] === "webhook_timing");
    expect(timing?.["route"]).toBe("ai");
    // The run was looked for and not found; Aiden's set-up was read for this message.
    expect(w.ops.some((o) => o.table === "flow_runs" && o.kind === "select")).toBe(true);
    expect(w.ops.some((o) => o.table === "ai_agents" && o.kind === "select")).toBe(true);
    // The tap's title is the message's words (what Aiden reads).
    const stored = w.ops.find((o) => o.table === "messages" && (o.kind === "insert" || o.kind === "upsert"));
    expect(JSON.stringify(stored?.payload)).toContain("₹50k–1L");
  });

  it("the engine releases a tap for a run that already ended (never 'consumed')", async () => {
    const { routeInbound } = await import("./flow-engine.server");
    expect(routeInbound({ status: "done", waiting_for: null, variables: {} } as never, false, "nmuux8kg1a:rmuux9gv4d")).toBe("release");
    expect(routeInbound(null, false, "nmuux8kg1a:rmuux9gv4d")).toBe("release");
  });
});

describe("(a)/(c) Show products: one shelf, never a code without a photo", () => {
  it("a 'rings' step never tops up with earrings; fewer matches → fewer sent", async () => {
    const { memoryDb } = await import("./test-support/memory-db");
    const { AI_TOOL_HANDLERS } = await import("./ai-tools.server");
    const row = (id: string, title: string, category: string, price: number) => ({
      id, organization_id: "o", title, category, price, currency: "INR", is_visible: true,
      image_url: `https://x/${id}.jpg`, product_url: `https://x/${id}`, availability: "in_stock",
    });
    const db = memoryDb({
      products: [
        row("r1", "Gents Pearl Ring", "Rings", 120000),
        row("e1", "Pearl Drops", "Earrings", 110000),
        row("e2", "Pearl Hoops", "earrings", 130000),
        row("e3", "Pearl Studs", "Gold Earrings", 105000),
      ],
    });
    const out = await AI_TOOL_HANDLERS["catalogSearch"]!(
      { supabase: db.supabase, organizationId: "o", actorUserId: null, initiatedBy: "ai" },
      { category: "Rings", min_price: 100000, keyword: "Pearl", limit: 5, order: "price_asc" },
    );
    expect((out.data as Array<{ id: string }>).map((r) => r.id)).toEqual(["r1"]);
    // Aiden's own shelf rule (brokered) is unchanged.
    const aiden = await AI_TOOL_HANDLERS["catalogSearch"]!(
      { supabase: db.supabase, organizationId: "o", actorUserId: null, initiatedBy: "ai", brokered: true },
      { category: "Rings", limit: 5 },
    );
    expect((aiden.data as Array<{ id: string }>).map((r) => r.id)).toEqual(["r1"]);
  });

  it("a SKU-only title with no photo is skipped; one with a photo or a real name still goes", async () => {
    const { sendable } = await import("./flow-products.server");
    const rows = [
      { title: "ZERN-0207", sku: "ZERN-0207", image_url: null },
      { title: "ZLRG-0014", sku: "ZLRG-0014", image_url: "https://x/1.jpg" },
      { title: "Plain Band", sku: null, image_url: null },
    ];
    expect(sendable(rows).map((r) => r["title"])).toEqual(["ZLRG-0014", "Plain Band"]);
  });
});

describe("(b) the keyword field takes a variable ({{stones}}), never a guess", () => {
  it("{{stones}} is filled from the customer's answer; empty → no keyword filter at all", async () => {
    const { productQueryOf } = await import("./flow-graph");
    const ctx = (vars: Record<string, unknown>) => ({ vars, contact: { name: "", phone: "", attributes: {}, tags: [] } }) as never;
    expect(productQueryOf({ category: "{{product}}", keyword: "{{stones}}", budget: "{{budget}}" }, ctx({ product: "Rings", stones: "Pearl", budget: "Above ₹1L" }))).toMatchObject({
      category: "Rings",
      keyword: "Pearl",
      minPrice: 100000,
    });
    const none = productQueryOf({ category: "Rings", keyword: "{{stones}}" }, ctx({}));
    expect(none.keyword).toBeUndefined();
  });
});
