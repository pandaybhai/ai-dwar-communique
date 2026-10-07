import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";

/**
 * Batch 17 (3): webhooks never answer ok for an event they couldn't store;
 * unsigned / oversized WhatsApp bodies are refused; the re-processor only
 * runs WhatsApp rows; Shopify store data never lands in a disconnected
 * workspace; and a message stored by a pass that died before answering is
 * answered by the retry — once.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown }, verified: true }));
vi.mock("@/lib/shopify.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/shopify.server")>()),
  verifyWebhookForShop: async () => h.verified,
  getServiceClient: () => h.db!.supabase,
}));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-webhook.server")>()),
  getServiceClient: () => (h.db ?? fakeDb(() => undefined)).supabase,
}));
vi.mock("@/lib/shopify-compliance.server", () => ({
  redactShopCustomer: vi.fn(async () => ({ ok: true })),
  redactShopData: vi.fn(async () => ({ ok: true })),
}));

import { acceptWebhook, processWebhookPayload, reclaimUnanswered, reprocessUnprocessedEvents } from "./whatsapp-webhook.server";
import { processShopifyWebhook } from "./shopify-webhook.server";
import { Route as WaRoute } from "../routes/api/public/whatsapp-webhook";
import { Route as ShopifyRoute } from "../routes/api/public/shopify-webhook";
import { redactShopCustomer } from "./shopify-compliance.server";

type Post = (ctx: { request: Request }) => Promise<Response>;
const postOf = (r: unknown) => (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  h.verified = true;
});

describe("(3) WhatsApp webhook: stored or not ok", () => {
  it("the event couldn't be stored → 500 (Meta retries), nothing processed", async () => {
    const db = fakeDb((op) => (op.table === "webhook_events" ? { data: null, error: { message: "db down" } } : undefined));
    const process = vi.fn();
    const res = await acceptWebhook(db.supabase, { rawBody: "{}", signatureValid: true, waitUntil: null, process });
    expect(res.status).toBe(500);
    expect(process).not.toHaveBeenCalled();
  });

  it("stored → 200 ok, exactly as before", async () => {
    const db = fakeDb((op) => (op.table === "webhook_events" ? { data: { id: "ev", received_at: null }, error: null } : undefined));
    const res = await acceptWebhook(db.supabase, { rawBody: "{}", signatureValid: true, waitUntil: null, process: async () => {} });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("route: an unsigned body is 401 and never stored", async () => {
    const db = fakeDb(() => undefined);
    h.db = db;
    const res = await postOf(WaRoute)({ request: new Request("http://x/api/public/whatsapp-webhook", { method: "POST", body: "{}" }) });
    expect(res.status).toBe(401);
    expect(db.ops).toEqual([]);
  });

  it("route: a body over 1 MB is 413 before it is read or verified", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    const byHeader = await postOf(WaRoute)({
      request: new Request("http://x/", { method: "POST", body: "{}", headers: { "content-length": String(big.length) } }),
    });
    expect(byHeader.status).toBe(413);
    const byLength = await postOf(WaRoute)({ request: new Request("http://x/", { method: "POST", body: big }) });
    expect(byLength.status).toBe(413);
  });

  it("the re-processor only picks up WhatsApp (provider meta) rows", async () => {
    const db = fakeDb(() => ({ data: [], error: null }));
    await reprocessUnprocessedEvents(db.supabase);
    const read = db.ops.find((o) => o.table === "webhook_events" && o.kind === "select")!;
    expect(db.has(read, "eq", "provider", "meta")).toBe(true);
  });
});

describe("(3) Shopify webhook", () => {
  const post = (body = "{}") =>
    postOf(ShopifyRoute)({
      request: new Request("http://x/api/public/shopify-webhook", {
        method: "POST",
        body,
        headers: { "x-shopify-topic": "orders/create", "x-shopify-shop-domain": "shop-a.myshopify.com", "x-shopify-event-id": "e1" },
      }),
    });

  it("a duplicate event (unique key) is acked 200; any other store failure is 500 so Shopify retries", async () => {
    h.db = fakeDb((op) => (op.table === "webhook_events" ? { data: null, error: { code: "23505", message: "duplicate key" } } : undefined));
    expect((await post()).status).toBe(200);
    h.db = fakeDb((op) => (op.table === "webhook_events" ? { data: null, error: { code: "57014", message: "timeout" } } : undefined));
    expect((await post()).status).toBe(500);
  });

  it("unchanged: a bad signature is 401", async () => {
    h.verified = false;
    h.db = fakeDb(() => undefined);
    expect((await post()).status).toBe(401);
  });

  const world = (rows: Array<{ id: string; organization_id: string; status: string }>) =>
    fakeDb((op) =>
      op.table === "integrations" && op.kind === "select"
        ? { data: rows.map((r) => ({ ...r, shop_domain: "shop-a.myshopify.com" })), error: null }
        : undefined,
    );
  const marked = (db: ReturnType<typeof fakeDb>) =>
    db.ops.filter((o) => o.table === "webhook_events" && o.kind === "update").map((o) => (o.payload as { error: string | null }).error);

  it("store data never routes to a disconnected integration", async () => {
    const db = world([{ id: "int-old", organization_id: "org-old", status: "disconnected" }]);
    await processShopifyWebhook({ supabase: db.supabase, topic: "orders/create", shopDomain: "shop-a.myshopify.com", payload: { id: 1 }, eventRowId: "ev" });
    expect(marked(db)).toEqual(["No connected store for this shop domain."]);
    expect(db.ops.some((o) => o.table === "orders")).toBe(false);
  });

  it("a connected workspace wins over a newer disconnected one for the same shop", async () => {
    const db = world([
      { id: "int-new", organization_id: "org-new", status: "disconnected" },
      { id: "int-live", organization_id: "org-live", status: "connected" },
    ]);
    await processShopifyWebhook({ supabase: db.supabase, topic: "products/delete", shopDomain: "shop-a.myshopify.com", payload: { id: 7 }, eventRowId: "ev" });
    const touched = db.ops.find((o) => o.table === "integrations" && o.kind === "update")!;
    expect(db.has(touched, "eq", "id", "int-live")).toBe(true);
  });

  it("GDPR redact still reaches a disconnected workspace (it arrives after uninstall)", async () => {
    const db = world([{ id: "int-old", organization_id: "org-old", status: "disconnected" }]);
    await processShopifyWebhook({ supabase: db.supabase, topic: "customers/redact", shopDomain: "shop-a.myshopify.com", payload: { customer: { id: 5 } }, eventRowId: "ev" });
    expect(redactShopCustomer).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------- stored vs answered

const TAP = {
  id: "wamid.tap",
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } },
  context: { id: "wamid.prompt" },
};
const answeredWrites = (ops: FakeOp[]) =>
  ops.filter((o) => o.table === "messages" && o.kind === "update" && "answered_at" in (o.payload as object));
const claims = (ops: FakeOp[]) =>
  ops.filter((o) => o.table === "messages" && o.kind === "update" && "answer_claimed_at" in (o.payload as object));

async function deliver(opts: { duplicate: boolean; reclaim?: "claimed" | "busy" | "missing"; failFlow?: boolean }) {
  const w = latencyWorld({
    org: `o17-${Math.random()}`,
    rttMs: 0,
    graphMs: 0,
    waitingRun: true,
    duplicate: opts.duplicate,
    override: (op) => {
      if (op.table === "messages" && op.kind === "update" && "answer_claimed_at" in (op.payload as object)) {
        if (opts.reclaim === "claimed") return { data: [{ id: "m-in" }], error: null };
        if (opts.reclaim === "missing")
          return { data: null, error: { code: "PGRST204", message: "Could not find the 'answer_claimed_at' column of 'messages'" } };
        return { data: [], error: null };
      }
      if (opts.failFlow && op.table === "flow_runs" && op.kind === "select") return { data: null, error: { message: "boom" } } as never;
      return undefined;
    },
  });
  vi.stubGlobal("fetch", w.fetchStub);
  await processWebhookPayload(w.supabase, "ev-17", inboundPayload(TAP), new Date().toISOString(), { storeMs: 1 });
  return w;
}

describe("(3) stored is not answered: the retry answers a message whose pass died", () => {
  it("a fresh message is answered and recorded answered (after the send)", async () => {
    const w = await deliver({ duplicate: false });
    expect(w.graphSends).toHaveLength(1);
    const marks = answeredWrites(w.ops);
    expect(marks).toHaveLength(1);
    expect(w.has(marks[0]!, "eq", "id", "m-in")).toBe(true);
    expect(w.has(marks[0]!, "is", "answered_at", null)).toBe(true);
    // No extra write before the reply: the insert stamps answer_claimed_at itself.
    expect(claims(w.ops)).toEqual([]);
  });

  it("a duplicate of a stored-but-unanswered message is claimed once and answered", async () => {
    const w = await deliver({ duplicate: true, reclaim: "claimed" });
    expect(w.graphSends).toHaveLength(1);
    const c = claims(w.ops);
    expect(c).toHaveLength(1);
    expect(w.has(c[0]!, "eq", "meta_message_id", "wamid.tap")).toBe(true);
    expect(w.has(c[0]!, "eq", "direction", "inbound")).toBe(true);
    expect(w.has(c[0]!, "is", "answered_at", null)).toBe(true);
    expect(c[0]!.filters.some(([n, a]) => n === "lt" && a[0] === "answer_claimed_at")).toBe(true);
    expect(answeredWrites(w.ops)).toHaveLength(1);
    // Counters belong to the first store only: no second unread bump.
    expect(w.ops.some((o) => o.table === "conversations" && o.kind === "update" && "unread_count" in (o.payload as object))).toBe(false);
  });

  it("already answered, or being answered right now (claim lost): stays a duplicate, nothing sent", async () => {
    const w = await deliver({ duplicate: true, reclaim: "busy" });
    expect(w.graphSends).toEqual([]);
    expect(answeredWrites(w.ops)).toEqual([]);
  });

  it("a pass that dies after storing is not recorded answered; its retry answers once", async () => {
    // The window write fails after the message is stored: the route is "failed".
    const dead = latencyWorld({
      org: "o17-dead",
      rttMs: 0,
      graphMs: 0,
      waitingRun: true,
      override: (op) => {
        if (op.table === "conversations" && op.kind === "update") throw new Error("worker cut off");
        return undefined;
      },
    });
    vi.stubGlobal("fetch", dead.fetchStub);
    await processWebhookPayload(dead.supabase, "ev-dead", inboundPayload(TAP), new Date().toISOString(), { storeMs: 1 });
    expect(dead.graphSends).toEqual([]);
    expect(answeredWrites(dead.ops)).toEqual([]);
    // The retry finds it stored and unanswered: claims it and answers.
    const retry = await deliver({ duplicate: true, reclaim: "claimed" });
    expect(retry.graphSends).toHaveLength(1);
    expect(answeredWrites(retry.ops)).toHaveLength(1);
  });

  it("before the migration (columns missing): a duplicate stays a duplicate, exactly as today", async () => {
    const w = await deliver({ duplicate: true, reclaim: "missing" });
    expect(w.graphSends).toEqual([]);
  });
});

describe("(3) migration (not applied): answered is separate from stored", () => {
  const sql = readFileSync(new URL("../../supabase/aidwar-migrations/20261032_batch17_message_answered.sql", import.meta.url), "utf8");
  it("old rows read answered (constant default, then dropped); the insert stamps the claim", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS answered_at timestamptz DEFAULT 'epoch';\s*ALTER TABLE public\.messages ALTER COLUMN answered_at DROP DEFAULT;/);
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS answer_claimed_at timestamptz DEFAULT now();");
    expect(sql).toMatch(/SET lock_timeout = '5s';/);
  });
});
