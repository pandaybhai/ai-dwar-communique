import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp, type FakeRpc } from "./test-support/fake-db";

/**
 * Batch 10C, routes:
 *  (1) Cards page: "stored_previews" finds each design's preview already drawn
 *      for today's brand paint — nothing drawn, nothing recorded — so it stays
 *      across visits and days, and is gone once the logo/name/colours change.
 *  (6) Flows v2 editor: a draft that doesn't save says so (no silent "ok");
 *      publish is all-or-nothing (one transaction when the migration is
 *      applied; step by step with every landed write put back until then).
 */

type Reply = { data: unknown; error: { code?: string; message: string } | null };
const h = vi.hoisted(() => ({
  db: null as null | ReturnType<typeof import("./test-support/fake-db").fakeDb>,
}));
vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  requireOrgMember: async () => ({ supabase: h.db!.supabase, organizationId: "75aed2f5-4a6c-43be-bff0-bbfee37f3faf", userId: "u1", role: "owner" }),
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

import { Route as CardsRoute } from "../routes/api/cards";
import { Route as FlowsV2Route } from "../routes/api/flows/v2";

type Post = (a: { request: Request }) => Promise<Response>;
const postOf = (r: unknown) => (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST;
const ORG = "75aed2f5-4a6c-43be-bff0-bbfee37f3faf";
const FLOW = "5e2ec668-55d1-436b-8ec1-f5579057ac7d";

beforeEach(() => {
  process.env["AIDWAR_SUPABASE_URL"] = "https://render.test";
  process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = "service-key";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ (1) Cards page previews

describe("Cards page keeps each design's last preview", () => {
  let stored: Set<string>;
  let renders: number;
  beforeEach(() => {
    stored = new Set();
    renders = 0;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (init?.method === "HEAD")
        return stored.has(String(url)) ? new Response(null, { status: 200, headers: { "content-type": "image/png" } }) : new Response(null, { status: 400 });
      renders += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { cacheKey: string };
      const url2 = `https://render.test/storage/v1/object/public/onboarding-cards/${body.cacheKey}.png`;
      stored.add(url2);
      return new Response(JSON.stringify({ url: url2 }));
    });
  });
  const cardsDb = (branding: Record<string, unknown>) =>
    fakeDb((op: FakeOp) => {
      if (op.table === "feature_flags") return { data: [{ key: "cards", default_enabled: true }], error: null };
      if (op.table === "organizations") return { data: { name: "Zoori", branding }, error: null };
      return undefined;
    });
  const call = (body: Record<string, unknown>) =>
    postOf(CardsRoute)({ request: new Request("http://x/api/cards", { method: "POST", body: JSON.stringify({ organization_id: ORG, ...body }) }) });

  it("nothing drawn yet → no previews; a drawn preview comes back on the next visit (any day) without drawing", async () => {
    h.db = cardsDb({ brand_primary: "#123456" });
    expect(await (await call({ action: "stored_previews" })).json()).toEqual({ urls: {} });
    const drawn = (await (await call({ action: "preview", kind: "customer_offer" })).json()) as { url: string };
    expect(renders).toBe(1);
    // A fresh server (restart / next day): memory is empty, storage still has it.
    vi.resetModules();
    const { Route: Fresh } = await import("../routes/api/cards");
    const res = await postOf(Fresh)({ request: new Request("http://x/api/cards", { method: "POST", body: JSON.stringify({ organization_id: ORG, action: "stored_previews" }) }) });
    expect(await res.json()).toEqual({ urls: { customer_offer: drawn.url } });
    expect(renders).toBe(1);
    expect(h.db.ops.some((o) => o.table === "ai_usage" && o.kind !== "select" && (o.payload as { task?: string }).task === "card_render")).toBe(false);
  });

  it("new logo, name or colours → that preview is gone (it was drawn with the old paint)", async () => {
    h.db = cardsDb({ brand_primary: "#abcdef" });
    await call({ action: "preview", kind: "customer_receipt" });
    expect(Object.keys(((await (await call({ action: "stored_previews" })).json()) as { urls: object }).urls)).toEqual(["customer_receipt"]);
    for (const paint of [{ brand_primary: "#000000" }, { brand_primary: "#abcdef", brand_logo_url: "https://shop.in/logo.png" }, { brand_primary: "#abcdef", brand_name: "Zoori Jewels" }]) {
      h.db = cardsDb(paint);
      expect(await (await call({ action: "stored_previews" })).json()).toEqual({ urls: {} });
    }
    // Back to the old paint: its preview is still the right one.
    h.db = cardsDb({ brand_primary: "#abcdef" });
    expect(Object.keys(((await (await call({ action: "stored_previews" })).json()) as { urls: object }).urls)).toEqual(["customer_receipt"]);
  });
});

// ------------------------------------------------------------------ (6) draft save + publish

const GRAPH = {
  nodes: [
    { id: "start", type: "start", data: {} },
    { id: "hi", type: "text", data: { text: "Hi {{name}}" } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "e0", source: "start", target: "hi", sourceHandle: "next" },
    { id: "e1", source: "hi", target: "end", sourceHandle: "next" },
  ],
};

function flowsDb(opts: { failUpdate?: (op: FakeOp) => boolean; failInsert?: boolean; rpc?: (c: FakeRpc) => Reply | undefined }) {
  return fakeDb(
    (op) => {
      if (op.table === "flows" && op.kind === "select") return { data: { id: FLOW, name: "Welcome", key: "v2:abc" }, error: null };
      if (op.table === "flow_versions" && op.kind === "select") {
        const published = op.filters.some(([f, a]) => f === "eq" && a[0] === "status" && a[1] === "published");
        return { data: published ? [{ id: "ver-1" }] : [{ id: "ver-2", graph: GRAPH, version: 2 }], error: null };
      }
      if (op.kind === "update" && opts.failUpdate?.(op)) return { data: null, error: { message: "boom" } };
      if (op.table === "flow_versions" && op.kind === "update") return { data: [{ id: "ver-2" }], error: null };
      if (op.table === "flow_versions" && op.kind === "insert" && opts.failInsert) return { data: null, error: { message: "boom" } };
      return undefined;
    },
    opts.rpc ?? (() => undefined),
  );
}
const flows = (body: Record<string, unknown>) =>
  postOf(FlowsV2Route)({ request: new Request("http://x/api/flows/v2", { method: "POST", body: JSON.stringify({ organization_id: ORG, flow_id: FLOW, ...body }) }) });
const MISSING: Reply = { data: null, error: { code: "PGRST202", message: "Could not find the function public.flow_publish_version" } };
const statusWrites = (db: ReturnType<typeof fakeDb>) =>
  db.ops
    .filter((o) => o.kind === "update" && (o.table === "flow_versions" || o.table === "flows"))
    .map((o) => `${o.table}:${JSON.stringify(o.payload, (k, v) => (k === "published_at" && v ? "<t>" : k === "graph" ? "<graph>" : v))}${JSON.stringify(o.filters.filter(([f]) => f === "eq" || f === "in").map(([, a]) => a))}`);

describe("flow draft save: a failure is never silent", () => {
  it("the draft write fails → 500 with words the editor shows", async () => {
    h.db = flowsDb({ failUpdate: (op) => op.table === "flow_versions" });
    const res = await flows({ action: "save_draft", graph: GRAPH });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Your changes weren't saved — please try again." });
  });
  it("a new draft insert fails → 500", async () => {
    h.db = fakeDb((op) => {
      if (op.table === "flows") return { data: { id: FLOW, name: "Welcome", key: "v2:abc" }, error: null };
      if (op.table === "flow_versions" && op.kind === "select") return { data: [], error: null };
      if (op.table === "flow_versions" && op.kind === "insert") return { data: null, error: { message: "boom" } };
      return undefined;
    });
    expect((await flows({ action: "save_draft", graph: GRAPH })).status).toBe(500);
  });
  it("the rename fails → 500 saying so", async () => {
    h.db = flowsDb({ failUpdate: (op) => op.table === "flows" });
    const res = await flows({ action: "save_draft", graph: GRAPH, name: "New name" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("the new name wasn't");
  });
  it("a good save still answers ok with the sealed graph", async () => {
    h.db = flowsDb({});
    const res = await flows({ action: "save_draft", graph: GRAPH });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, graph: { nodes: GRAPH.nodes } });
  });
});

describe("publish is all-or-nothing", () => {
  it("with the migration: one transaction (the RPC), no loose writes", async () => {
    const calls: FakeRpc[] = [];
    h.db = flowsDb({ rpc: (c) => (calls.push(c), { data: 2, error: null }) });
    const res = await flows({ action: "publish" });
    expect(await res.json()).toEqual({ ok: true, version: 2 });
    expect(calls.filter((c) => c.name === "flow_publish_version")).toEqual([
      { name: "flow_publish_version", args: { p_organization_id: ORG, p_flow_id: FLOW, p_version_id: "ver-2", p_graph: GRAPH, p_user: "u1" } },
    ]);
    expect(statusWrites(h.db)).toEqual([]);
  });
  it("the transaction fails → 500, nothing was changed", async () => {
    h.db = flowsDb({ rpc: (c) => (c.name === "flow_publish_version" ? { data: null, error: { code: "40001", message: "serialization" } } : undefined) });
    const res = await flows({ action: "publish" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("nothing was changed");
    expect(statusWrites(h.db)).toEqual([]);
  });
  it("without the migration (today): archive old → publish draft → switch on, in that order", async () => {
    h.db = flowsDb({ rpc: (c) => (c.name === "flow_publish_version" ? MISSING : undefined) });
    expect(await (await flows({ action: "publish" })).json()).toEqual({ ok: true, version: 2 });
    expect(statusWrites(h.db)).toEqual([
      `flow_versions:{"status":"archived"}[["id",["ver-1"]],["status","published"]]`,
      `flow_versions:{"status":"published","graph":"<graph>","published_at":"<t>","published_by":"u1"}[["id","ver-2"],["flow_id","${FLOW}"],["status","draft"]]`,
      `flows:{"is_enabled":true}[["id","${FLOW}"],["organization_id","${ORG}"]]`,
    ]);
  });
  it("without the migration, the draft can't be published → the old version is put back", async () => {
    h.db = flowsDb({ rpc: (c) => (c.name === "flow_publish_version" ? MISSING : undefined), failUpdate: (op) => op.table === "flow_versions" && (op.payload as { status?: string }).status === "published" && op.filters.some(([, a]) => a[1] === "ver-2") });
    const res = await flows({ action: "publish" });
    expect(res.status).toBe(500);
    expect(statusWrites(h.db).at(-1)).toBe(`flow_versions:{"status":"published"}[["id","ver-1"],["status","archived"]]`);
  });
  it("without the migration, the flow can't be switched on → draft back to draft, old version back to published", async () => {
    h.db = flowsDb({ rpc: (c) => (c.name === "flow_publish_version" ? MISSING : undefined), failUpdate: (op) => op.table === "flows" });
    const res = await flows({ action: "publish" });
    expect(res.status).toBe(500);
    expect(statusWrites(h.db).slice(-2)).toEqual([
      `flow_versions:{"status":"draft","published_at":null,"published_by":null}[["id","ver-2"]]`,
      `flow_versions:{"status":"published"}[["id","ver-1"],["status","archived"]]`,
    ]);
  });
  it("problems still block publishing before anything is written", async () => {
    // A draft whose text step is empty.
    h.db = fakeDb((op) => {
      if (op.table === "flows") return { data: { id: FLOW, name: "Welcome", key: "v2:abc" }, error: null };
      if (op.table === "flow_versions" && op.kind === "select") return { data: [{ id: "ver-2", graph: { ...GRAPH, nodes: GRAPH.nodes.map((n) => (n.id === "hi" ? { ...n, data: { text: "" } } : n)) }, version: 2 }], error: null };
      return undefined;
    });
    const res = await flows({ action: "publish" });
    expect(res.status).toBe(422);
    expect(h.db.rpcs.some((r) => r.name === "flow_publish_version")).toBe(false);
    expect(statusWrites(h.db)).toEqual([]);
  });
});

describe("unpublish never half-done", () => {
  it("switching the flow off fails → 500, the version is untouched", async () => {
    h.db = fakeDb((op) => {
      if (op.table === "flows" && op.kind === "select") return { data: { id: FLOW, name: "Welcome", key: "v2:abc" }, error: null };
      if (op.table === "flow_versions" && op.kind === "select") return { data: op.filters.some(([f]) => f === "maybeSingle") ? { id: "ver-1", graph: GRAPH } : [], error: null };
      if (op.table === "flows" && op.kind === "update") return { data: null, error: { message: "boom" } };
      return undefined;
    });
    const res = await flows({ action: "unpublish" });
    expect(res.status).toBe(500);
    expect(h.db.ops.some((o) => o.table === "flow_versions" && o.kind === "update")).toBe(false);
  });
});
