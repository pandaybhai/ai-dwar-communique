import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp, type FakeRpc } from "./test-support/fake-db";

/**
 * Batch 9, server side:
 *  (2) publish blocks a WhatsApp shop step when no WhatsApp shop is connected;
 *      flows without that step publish exactly as before (and never look);
 *  (4) a campaign's charged total is the sum of its debit_message rows — at
 *      settle and whenever a late price lands — never counted twice;
 *  unchanged: the WhatsApp catalogue sync sends what it always sent.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  billingEnabled: vi.fn(async () => true),
}));
vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  requireOrgMember: async () => ({ supabase: h.db!.supabase, organizationId: "org", userId: "u1" }),
  requirePermission: async () => null,
  logServerActivity: async () => {},
}));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-webhook.server")>()),
  getServiceClient: () => h.db!.supabase,
}));
vi.mock("@/lib/flow-engine.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/flow-engine.server")>()),
  flowsV2Enabled: async () => true,
}));
vi.mock("@/lib/billing.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/billing.server")>()),
  billingEnabled: h.billingEnabled,
}));
vi.mock("@/lib/whatsapp-numbers.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-numbers.server")>()),
  getWhatsAppConnection: async () => ({
    connection: { wabaId: "waba", phoneNumberId: "pn", accessToken: "merchant-tok" },
    error: null,
  }),
}));

import { Route as FlowsV2Route } from "../routes/api/flows/v2";
import { processWebhookPayload } from "./whatsapp-webhook.server";
import { settleCampaignSpend, syncCampaignCharged } from "./campaign-billing.server";
import { syncCatalog } from "./whatsapp-catalog.server";
import type { FlowGraph } from "./flow-graph";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["META_CATALOG_PLATFORM_TOKEN"];
});

type Post = (ctx: { request: Request }) => Promise<Response>;
const post = (FlowsV2Route.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers.POST;
const call = (body: Record<string, unknown>) =>
  post({ request: new Request("http://x/api/flows/v2", { method: "POST", body: JSON.stringify(body) }) });

const FLOW_ID = "5b77eecd-1b82-4380-9a16-fca99e7dbbb6";
const ORG_ID = "75aed2f5-4a6c-43be-bff0-bbfee37f3faf";

const WELCOME: FlowGraph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    { id: "menu", type: "buttons", data: { text: "Hi {{name}}! How can we help?", buttons: [{ id: "b1", title: "Shop" }, { id: "b3", title: "Talk to us" }] } },
    { id: "shop", type: "text", data: { text: "Browse our latest picks on our website." } },
    { id: "team", type: "assign", data: {} },
    { id: "tag", type: "tag", data: { tag: "WhatsApp lead", action: "add" } },
    { id: "field", type: "set_field", data: { field: "interest", value: "shop" } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "e0", source: "start", target: "menu", sourceHandle: "next" },
    { id: "e1", source: "menu", target: "shop", sourceHandle: "b1" },
    { id: "e3", source: "menu", target: "team", sourceHandle: "b3" },
    { id: "e9", source: "menu", target: "end", sourceHandle: "window_closed" },
    { id: "e4", source: "shop", target: "tag", sourceHandle: "next" },
    { id: "e5", source: "tag", target: "field", sourceHandle: "next" },
    { id: "e6", source: "field", target: "end", sourceHandle: "next" },
    { id: "e7", source: "team", target: "end", sourceHandle: "next" },
  ],
};
const WITH_SHOP: FlowGraph = {
  nodes: [
    ...WELCOME.nodes,
    { id: "wshop", type: "carousel", data: { header: "Our picks", text: "Take a look:", retailer_ids: ["SKU-1"], titles: { "SKU-1": "Ring" } } },
  ],
  edges: [
    ...WELCOME.edges.filter((e) => e.id !== "e1"),
    { id: "e1", source: "menu", target: "wshop", sourceHandle: "b1" },
    { id: "e10", source: "wshop", target: "shop", sourceHandle: "next" },
    { id: "e11", source: "wshop", target: "end", sourceHandle: "window_closed" },
  ],
};

function flowsWorld(graph: FlowGraph, catalogs: Array<{ id: string }>) {
  const db = fakeDb(
    (op) => {
      if (op.table === "flows" && op.kind === "select") return { data: { id: FLOW_ID, name: "Welcome menu", key: "v2:abc", whatsapp_account_id: null }, error: null };
      if (op.table === "flow_versions" && op.kind === "select") return { data: [{ id: "ver-2", graph, version: 2 }], error: null };
      // Batch 10C: publishing a draft returns the row it published.
      if (op.table === "flow_versions" && op.kind === "update") return { data: [{ id: "ver-2" }], error: null };
      if (op.table === "whatsapp_catalogs") return { data: catalogs, error: null };
      if (op.table === "whatsapp_accounts") return { data: [], error: null };
      if (op.table === "organization_members") return { data: [], error: null };
      return undefined;
    },
    // Batch 10C: the live database doesn't have flow_publish_version yet, so publish runs step by step.
    (call) => (call.name === "flow_publish_version" ? { data: null, error: { code: "PGRST202", message: "Could not find the function public.flow_publish_version" } } : undefined),
  );
  h.db = db;
  return db;
}
const published = (db: ReturnType<typeof fakeDb>) =>
  db.ops.some((o) => o.table === "flow_versions" && o.kind === "update" && (o.payload as { status?: string }).status === "published");

describe("(2) publish: the WhatsApp shop guard", () => {
  it("unchanged: a flow without a WhatsApp shop step publishes, and the shop is never looked up", async () => {
    const db = flowsWorld(WELCOME, []);
    const res = await call({ action: "publish", organization_id: ORG_ID, flow_id: FLOW_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 2 });
    expect(published(db)).toBe(true);
    expect(db.ops.some((o) => o.table === "whatsapp_catalogs")).toBe(false);
  });

  it("a WhatsApp shop step with no connected shop: 422 'Connect WhatsApp shop first' on that step, nothing published", async () => {
    const db = flowsWorld(WITH_SHOP, []);
    const res = await call({ action: "publish", organization_id: ORG_ID, flow_id: FLOW_ID });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, problems: [{ nodeId: "wshop", message: "Connect WhatsApp shop first" }] });
    expect(published(db)).toBe(false);
  });

  it("with a connected shop the same flow publishes", async () => {
    const db = flowsWorld(WITH_SHOP, [{ id: "cat-1" }]);
    const res = await call({ action: "publish", organization_id: ORG_ID, flow_id: FLOW_ID });
    expect(res.status).toBe(200);
    expect(published(db)).toBe(true);
  });

  it("editor context tells the canvas whether the shop is connected (other fields unchanged)", async () => {
    flowsWorld(WELCOME, []);
    const off = (await (await call({ action: "editor_context", organization_id: ORG_ID, flow_id: FLOW_ID })).json()) as Record<string, unknown>;
    expect(off).toEqual({ ok: true, numbers: [], whatsapp_account_id: null, whatsapp_shop_connected: false, members: [] });
    flowsWorld(WELCOME, [{ id: "cat-1" }]);
    const on = (await (await call({ action: "editor_context", organization_id: ORG_ID, flow_id: FLOW_ID })).json()) as Record<string, unknown>;
    expect(on["whatsapp_shop_connected"]).toBe(true);
  });
});

// ------------------------------------------------------------------ (4)

const ledgerFilter = (op: FakeOp, col: string, val: unknown) => op.filters.some(([n, a]) => n === "eq" && a[0] === col && a[1] === val);

/** The live "Demo" case: 4.16 held, settled at completion, then three 1.04 prices land. */
function campaignWorld(state: { debits: number[]; charged: number; held: number }) {
  const db = fakeDb(
    (op) => {
      if (op.table === "campaigns" && op.kind === "select")
        return {
          data: { id: "camp", estimated_cost: 4.16, held_amount: state.held, charged_amount: state.charged, sent_count: 4, template_name: "t" },
          error: null,
        };
      if (op.table === "campaigns" && op.kind === "update") {
        const p = op.payload as { charged_amount?: number; held_amount?: number };
        const lt = op.filters.find(([n]) => n === "lt");
        // The database applies the "only raise" guard.
        if (p.charged_amount !== undefined && (!lt || state.charged < Number(lt[1][1]))) state.charged = p.charged_amount;
        if (p.held_amount !== undefined) state.held = p.held_amount;
        return { data: null, error: null };
      }
      if (op.table === "wallet_ledger" && ledgerFilter(op, "entry_type", "debit_message"))
        return { data: state.debits.map((a) => ({ amount: -a })), error: null };
      if (op.table === "wallet_ledger") return { data: [], error: null };
      return undefined;
    },
    () => ({ data: "entry", error: null }),
  );
  return db;
}

describe("(4) campaign charged total = sum of its debit_message rows", () => {
  it("settled before Meta priced anything, then three 1.04 prices land: total 3.12, never 0, never doubled", async () => {
    const state = { debits: [] as number[], charged: 0, held: 4.16 };
    const db = campaignWorld(state);
    expect(await settleCampaignSpend(db.supabase, "org", "camp")).toEqual({ ok: true });
    expect(state).toMatchObject({ charged: 0, held: 0 });
    for (let i = 1; i <= 3; i += 1) {
      state.debits.push(1.04);
      expect((await syncCampaignCharged(db.supabase, "org", "camp")).amount).toBe(Number((1.04 * i).toFixed(2)));
    }
    expect(state.charged).toBe(3.12);
    // The same price reported again (read after delivered) changes nothing.
    await syncCampaignCharged(db.supabase, "org", "camp");
    expect(state.charged).toBe(3.12);
    // The update is filtered to this campaign, this workspace, and only ever raises.
    const last = db.ops.filter((o) => o.table === "campaigns" && o.kind === "update").at(-1)!;
    expect(db.has(last, "eq", "id", "camp")).toBe(true);
    expect(db.has(last, "eq", "organization_id", "org")).toBe(true);
    expect(db.has(last, "lt", "charged_amount", 3.12)).toBe(true);
    expect(db.ops.find((o) => o.table === "wallet_ledger" && ledgerFilter(o, "entry_type", "debit_message"))!.filters).toContainEqual(["eq", ["metadata->>campaign_id", "camp"]]);
  });

  it("settle after the prices: charged = the debits, only the unused hold comes back", async () => {
    const state = { debits: [1.04, 1.04, 1.04], charged: 0, held: 4.16 };
    const db = campaignWorld(state);
    await settleCampaignSpend(db.supabase, "org", "camp");
    expect(state.charged).toBe(3.12);
    // (campaign_ledger_charge is asked first; this fake has none, so the rows are read.)
    expect(db.rpcs.filter((r) => r.name !== "campaign_ledger_charge").map((r) => [r.args["p_type"], r.args["p_amount"]])).toEqual([["hold_release", 1.04]]);
  });

  it("no debit rows (billing off / free messages): nothing written; a failed read writes nothing", async () => {
    const state = { debits: [] as number[], charged: 0, held: 0 };
    const db = campaignWorld(state);
    expect(await syncCampaignCharged(db.supabase, "org", "camp")).toEqual({ ok: true, amount: 0 });
    expect(db.ops.some((o) => o.table === "campaigns" && o.kind === "update")).toBe(false);
    const broken = fakeDb((op) => (op.table === "wallet_ledger" ? { data: null, error: { message: "timeout" } } : undefined));
    expect((await syncCampaignCharged(broken.supabase, "org", "camp")).ok).toBe(false);
    expect(broken.ops.some((o) => o.kind === "update")).toBe(false);
  });

  describe("webhook: a late price brings the campaign's total up to date", () => {
    const statusPayload = (status: string) => ({
      entry: [
        {
          id: "waba",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn", display_phone_number: "911111111111" },
                contacts: [],
                messages: [],
                statuses: [{ id: "wamid.out", status, timestamp: "1700000000", pricing: { billable: true, pricing_model: "PMP", category: "marketing" } }],
              },
            },
          ],
        },
      ],
    });
    const world = (opts: { campaignId: string | null; priced?: boolean; priceError?: boolean }) => {
      const db = fakeDb(
        (op) => {
          if (op.table === "whatsapp_accounts") return { data: { id: "acc", organization_id: "org", waba_id: "waba" }, error: null };
          if (op.table === "messages" && op.kind === "select")
            return { data: { id: "m-out", status: "sent", type: "template", conversation_id: "cv1", campaign_id: opts.campaignId }, error: null };
          // Batch 12: the status is one conditional update that returns the row.
          if (op.table === "messages" && op.kind === "update")
            return { data: [{ id: "m-out", status: "delivered", type: "template", conversation_id: "cv1", campaign_id: opts.campaignId, created_at: "2026-10-01T00:00:00Z" }], error: null };
          if (op.table === "wallet_ledger") return { data: [{ amount: -1.04 }, { amount: -1.04 }], error: null };
          return undefined;
        },
        (c: FakeRpc) =>
          c.name === "price_message"
            ? opts.priceError
              ? { data: null, error: { message: "no rate" } }
              : { data: opts.priced ?? true, error: null }
            : undefined,
      );
      h.db = db;
      return db;
    };
    const chargedUpdates = (db: ReturnType<typeof fakeDb>) =>
      db.ops.filter((o) => o.table === "campaigns" && o.kind === "update").map((o) => o.payload);

    it("a campaign message priced on delivery: charged_amount set from the ledger (2 × 1.04)", async () => {
      const db = world({ campaignId: "camp" });
      await processWebhookPayload(db.supabase, "ev-late", statusPayload("delivered"));
      expect(db.rpcs.some((r) => r.name === "price_message")).toBe(true);
      expect(chargedUpdates(db)).toEqual([{ charged_amount: 2.08 }]);
    });

    it("unchanged: a non-campaign message, a missing rate or a pricing error never touches campaigns", async () => {
      for (const opts of [{ campaignId: null }, { campaignId: "camp", priced: false }, { campaignId: "camp", priceError: true }]) {
        const db = world(opts);
        await processWebhookPayload(db.supabase, "ev-x", statusPayload("delivered"));
        expect(chargedUpdates(db)).toEqual([]);
        expect(db.ops.some((o) => o.table === "wallet_ledger")).toBe(false);
      }
    });

    it("'sent' is never priced, so nothing changes there either", async () => {
      const db = world({ campaignId: "camp" });
      await processWebhookPayload(db.supabase, "ev-sent", statusPayload("sent"));
      expect(db.rpcs.some((r) => r.name === "price_message")).toBe(false);
      expect(chargedUpdates(db)).toEqual([]);
    });
  });
});

// ------------------------------------------------------------------ catalogue sync

describe("unchanged: WhatsApp catalogue sync ('Sync now' calls the same action)", () => {
  it("pushes visible products with a price and a picture, in the same shape, and records the count", async () => {
    process.env["META_CATALOG_PLATFORM_TOKEN"] = "platform-tok";
    const products = [
      { id: "p1", external_id: "https://shop.in/p/ring", sku: "R1", title: "Ring", description: null, price: 1499, currency: "INR", image_url: "https://shop.in/r.jpg", product_url: "https://shop.in/p/ring", brand: "Shop", category: "rings", availability: "in_stock", inventory_quantity: null },
    ];
    const db = fakeDb((op) => {
      if (op.table === "whatsapp_credentials") return { data: { granted_scopes: [] }, error: null };
      if (op.table === "whatsapp_catalogs" && op.kind === "select")
        return { data: { catalog_id: "cat-1", catalog_name: "Shop", status: "linked", mode: "managed", last_sync_at: null, pushed_count: 0, rejected_count: 0, last_error: null, is_catalog_visible: true, is_cart_enabled: true }, error: null };
      if (op.table === "products" && op.kind === "select" && op.filters.some(([n]) => n === "not") && op.filters.some(([n, a]) => n === "eq" && a[0] === "is_visible"))
        return { data: products, error: null };
      if (op.table === "products" && op.kind === "select") return { data: [], error: null };
      return undefined;
    });
    const calls: Array<{ url: string; body: Record<string, unknown> | null; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null, auth: (init?.headers as Record<string, string>)["Authorization"] ?? null });
      return new Response(JSON.stringify({ handles: [] }), { status: 200 });
    });
    const out = await syncCatalog({ supabase: db.supabase, organizationId: "org", userId: "u1", whatsappAccountId: "acc" });
    expect(out).toMatchObject({ ok: true, catalog_id: "cat-1", eligible: 1, pushed: 1, rejected: 0, removed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/cat-1/items_batch");
    expect(calls[0]!.auth).toBe("Bearer platform-tok");
    expect(calls[0]!.body).toEqual({
      item_type: "PRODUCT_ITEM",
      allow_upsert: true,
      requests: [
        {
          method: "UPDATE",
          data: { id: "https://shop.in/p/ring", title: "Ring", description: "Ring", availability: "in stock", condition: "new", price: "1499.00 INR", image_link: "https://shop.in/r.jpg", link: "https://shop.in/p/ring", brand: "Shop", product_type: "rings" },
        },
      ],
    });
    const search = db.ops.find((o) => o.table === "products" && o.kind === "select")!;
    expect(db.has(search, "not", "price", "is", null)).toBe(true);
    expect(db.has(search, "not", "image_url", "is", null)).toBe(true);
    expect(db.ops.find((o) => o.table === "whatsapp_catalogs" && o.kind === "update")!.payload).toMatchObject({ pushed_count: 1, rejected_count: 0, last_error: null });
  });
});
