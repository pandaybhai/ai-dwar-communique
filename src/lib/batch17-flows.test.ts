import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import type { FlowGraph } from "./flow-graph";

/**
 * Batch 17 (2): Flows v2 versions/triggers are written only by the server,
 * and the server only ever picks this workspace's version rows — a row that
 * names our flow_id but another workspace is never published, unpublished
 * or restored.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
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

import { Route as FlowsV2Route } from "../routes/api/flows/v2";

type Post = (ctx: { request: Request }) => Promise<Response>;
const post = (FlowsV2Route.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers.POST;
const call = (body: Record<string, unknown>) =>
  post({ request: new Request("http://x/api/flows/v2", { method: "POST", body: JSON.stringify(body) }) });

const FLOW_ID = "5b77eecd-1b82-4380-9a16-fca99e7dbbb6";
const ORG_ID = "75aed2f5-4a6c-43be-bff0-bbfee37f3faf";
const FOREIGN_VERSION = "0e1f2a3b-0000-4000-8000-000000000001";

const GOOD: FlowGraph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    { id: "hi", type: "text", data: { text: "Hello" } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "e0", source: "start", target: "hi", sourceHandle: "next" },
    { id: "e1", source: "hi", target: "end", sourceHandle: "next" },
  ],
};

type Row = { id: string; organization_id: string; status: string; graph: FlowGraph; version: number };

/** The database applies eq filters; a foreign row named our flow_id (the old browser-insert hole). */
function world(rows: Row[]) {
  const matches = (op: FakeOp, r: Row) =>
    op.filters.every(([n, a]) => n !== "eq" || (r as Record<string, unknown>)[a[0] as string] === undefined || (r as Record<string, unknown>)[a[0] as string] === a[1]);
  const db = fakeDb(
    (op) => {
      if (op.table === "flows" && op.kind === "select")
        return { data: { id: FLOW_ID, name: "Welcome", key: "v2:abc", whatsapp_account_id: null }, error: null };
      if (op.table === "flow_versions" && op.kind === "select") {
        const hit = rows.filter((r) => matches(op, r)).sort((a, b) => b.version - a.version);
        const single = op.filters.some(([n]) => n === "maybeSingle" || n === "single");
        return { data: single ? (hit[0] ?? null) : hit, error: null };
      }
      if (op.table === "flow_versions" && op.kind === "update") return { data: [{ id: "x" }], error: null };
      return undefined;
    },
    (c) => (c.name === "flow_publish_version" ? { data: null, error: { code: "PGRST202", message: "missing" } } : undefined),
  );
  h.db = db;
  return db;
}
const updates = (db: ReturnType<typeof fakeDb>) =>
  db.ops.filter((o) => o.table === "flow_versions" && o.kind === "update");
const touched = (db: ReturnType<typeof fakeDb>, id: string) => updates(db).some((o) => db.has(o, "eq", "id", id));

const BAD_GRAPH = { nodes: [], edges: [] } as unknown as FlowGraph;

describe("(2) the server only uses this workspace's version rows", () => {
  it("publish: a newer foreign draft for our flow is never picked; our own draft publishes", async () => {
    const db = world([
      { id: "mine", organization_id: "org", status: "draft", graph: GOOD, version: 2 },
      { id: "evil", organization_id: "other", status: "draft", graph: BAD_GRAPH, version: 9 },
    ]);
    const res = await call({ action: "publish", organization_id: ORG_ID, flow_id: FLOW_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 2 });
    expect(touched(db, "evil")).toBe(false);
    expect(touched(db, "mine")).toBe(true);
  });

  it("publish: only a foreign draft exists → 'no draft to publish', nothing written", async () => {
    const db = world([{ id: "evil", organization_id: "other", status: "draft", graph: GOOD, version: 3 }]);
    const res = await call({ action: "publish", organization_id: ORG_ID, flow_id: FLOW_ID });
    expect(res.status).toBe(400);
    expect(updates(db)).toEqual([]);
  });

  it("unpublish: a foreign 'published' row is not ours to archive", async () => {
    const db = world([{ id: "evil", organization_id: "other", status: "published", graph: GOOD, version: 1 }]);
    const res = await call({ action: "unpublish", organization_id: ORG_ID, flow_id: FLOW_ID });
    expect(res.status).toBe(400);
    expect(updates(db)).toEqual([]);
    expect(db.ops.some((o) => o.table === "flows" && o.kind === "update")).toBe(false);
  });

  it("restore: a foreign version id is 'doesn't exist'", async () => {
    world([{ id: FOREIGN_VERSION, organization_id: "other", status: "archived", graph: GOOD, version: 1 }]);
    const res = await call({ action: "restore", organization_id: ORG_ID, flow_id: FLOW_ID, version_id: FOREIGN_VERSION });
    expect(res.status).toBe(404);
  });

  it("every flow_versions read in the editor API carries the workspace filter (except the version counter)", async () => {
    const db = world([{ id: "mine", organization_id: "org", status: "draft", graph: GOOD, version: 2 }]);
    await call({ action: "publish", organization_id: ORG_ID, flow_id: FLOW_ID });
    const reads = db.ops.filter((o) => o.table === "flow_versions" && o.kind === "select" && o.filters.some(([n, a]) => n === "eq" && a[0] === "status" && a[1] === "draft"));
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(db.has(r, "eq", "organization_id", "org")).toBe(true);
  });
});

describe("(2) migration (not applied): browser keeps read, loses every write", () => {
  const sql = readFileSync(new URL("../../supabase/aidwar-migrations/20261031_batch17_flows_server_only_writes.sql", import.meta.url), "utf8");
  it("revokes writes (incl. TRUNCATE) from authenticated, everything from anon, keeps SELECT and service_role", () => {
    for (const t of ["flow_versions", "flow_triggers"]) {
      expect(sql).toContain(`REVOKE ALL ON public.${t} FROM anon;`);
      expect(sql).toContain(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.${t} FROM authenticated;`);
      expect(sql).toContain(`GRANT SELECT ON public.${t} TO authenticated;`);
      expect(sql).toContain(`GRANT ALL ON public.${t} TO service_role;`);
    }
    expect(sql).toMatch(/SET lock_timeout = '5s';/);
    expect(sql).not.toMatch(/^\s*(CREATE|DROP|ALTER|UPDATE|INSERT|DELETE)\b/im);
  });

  it("the flow builder writes only through the server API", () => {
    const editor = readFileSync(new URL("../components/flows/v2/flow-editor.tsx", import.meta.url), "utf8");
    for (const action of ["save_draft", "publish", "unpublish", "restore"])
      expect(editor).toMatch(new RegExp(`callApi[^\\n]*"/api/flows/v2"[^\\n]*action: "${action}"`));
    for (const f of ["../components/flows/v2/flow-editor.tsx", "../components/flows/v2/chat-flows-list.tsx", "../components/flows/v2/triggers-panel.tsx", "../components/inbox/flow-run-history.tsx", "../routes/app/flows.v2.$id.tsx"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src).not.toMatch(/from\("flow_(versions|triggers)"\)[^;]*\.(insert|update|upsert|delete)\(/);
    }
  });
});
