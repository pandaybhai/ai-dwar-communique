import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import type { FlowGraph } from "./flow-graph";
import { csvSafeCell, parseCsv, toCsv } from "./csv";
import {
  RESPONSE_STATUSES,
  answerColumns,
  buildRow,
  questionSteps,
  rangeBounds,
  responseStatus,
  responsesCsv,
  responsesCsvRows,
  type RunRecord,
} from "./flow-responses";
import { cleanSearch, exportResponses, loadResponsesContext } from "./flow-responses.server";
import { segmentExpressions } from "./segments.server";

/**
 * Batch 8 — Flows v2 Responses tab.
 *  (1) One row per run: name, phone, started, status (+ the step an unfinished
 *      run is at) and one column per answer variable / Update field.
 *  (2) Date, status and text filters; 50 per page, paginated in SQL.
 *  (3) Summary: started, finished, completion rate, drop-off per question.
 *  (4) CSV of the filtered rows, formula-injection safe.
 *  (5) contacts.view to see, contacts.export to download, org-scoped reads.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const FLOW = "22222222-2222-4222-8222-222222222222";
const V1 = "33333333-3333-4333-8333-333333333331";
const V2 = "33333333-3333-4333-8333-333333333332";
const DRAFT = "33333333-3333-4333-8333-333333333333";

const LEAD_V2: FlowGraph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    { id: "q_city", type: "ask", data: { text: "Which city are you in?", variable: "city", label: "City" } },
    { id: "q_budget", type: "list", data: { text: "Your budget?", variable: "budget", rows: [{ id: "r1", title: "Under 25k" }] } },
    { id: "menu", type: "buttons", data: { text: "Shall we call you?", buttons: [{ id: "b1", title: "Yes" }] } },
    { id: "q_loc", type: "location_request", data: { text: "Share your location", variable: "location" } },
    { id: "save_city", type: "set_field", data: { field: "city", value: "{{city}}", label: "Saved city" } },
    { id: "secret", type: "ask", data: { text: "x", variable: "_internal" } },
    { id: "calc", type: "set_variable", data: { variable: "total", expression: "1" } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [],
};
// The older version asked for a pincode the newer one dropped.
const LEAD_V1: FlowGraph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    { id: "q_city", type: "ask", data: { text: "City?", variable: "city", label: "Old city label" } },
    { id: "q_pin", type: "ask", data: { text: "Pincode?", variable: "pincode" } },
  ],
  edges: [],
};
const DRAFT_GRAPH: FlowGraph = { nodes: [{ id: "q_new", type: "ask", data: { text: "New?", variable: "unpublished" } }], edges: [] };

const VERSIONS = [
  { id: DRAFT, version: 3, status: "draft", graph: DRAFT_GRAPH },
  { id: V2, version: 2, status: "published", graph: LEAD_V2 },
  { id: V1, version: 1, status: "archived", graph: LEAD_V1 },
];

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  contact_id: "c1",
  conversation_id: "cv1",
  version_id: V2,
  status: "done",
  current_node_id: "end",
  variables: { city: "Pune", budget: "Under 25k", last_answer: "Under 25k", _attempts: { q_city: 1 }, _last_reply: { k: "x" } },
  started_at: "2026-10-04T05:30:00.000Z",
  contacts: { name: "Asha", phone: "+919800000001", attributes: {} },
  ...over,
});

describe("(1) answer columns", () => {
  const cols = answerColumns([LEAD_V2, LEAD_V1]);

  it("one column per variable saved by Ask/List/Buttons/Question steps and per Update field", () => {
    expect(cols.map((c) => c.key)).toEqual(["var:city", "var:budget", "var:location", "field:city", "var:pincode"]);
  });
  it("labelled with the step label, else the variable name; the newest version's label wins", () => {
    expect(Object.fromEntries(cols.map((c) => [c.key, c.label]))).toMatchObject({
      "var:city": "City",
      "var:budget": "budget",
      "field:city": "Saved city",
      "var:pincode": "pincode",
    });
  });
  it("ignores internal keys, built-ins, Set variable and buttons without a variable", () => {
    const keys = cols.map((c) => c.key).join(" ");
    expect(keys).not.toMatch(/_internal|last_answer|_attempts|_last_reply|total/);
  });
  it("question steps for drop-off: every step that waits for a reply, once", () => {
    expect(questionSteps([LEAD_V2, LEAD_V1]).map((q) => [q.nodeId, q.label])).toEqual([
      ["q_city", "City"],
      ["q_budget", "budget"],
      ["menu", "Shall we call you?"],
      ["q_loc", "location"],
      ["secret", "_internal"],
      ["q_pin", "pincode"],
    ]);
  });
});

describe("(1) status and rows", () => {
  it("maps every run status to finished / waiting / stopped / failed", () => {
    expect(["done", "running", "waiting", "paused", "cancelled", "expired", "failed"].map(responseStatus)).toEqual([
      "finished",
      "waiting",
      "waiting",
      "waiting",
      "stopped",
      "stopped",
      "failed",
    ]);
    expect(Object.values(RESPONSE_STATUSES).flat().sort()).toEqual(["cancelled", "done", "expired", "failed", "paused", "running", "waiting"]);
  });

  const cols = answerColumns([LEAD_V2, LEAD_V1]);
  const versions = new Map([
    [V2, { version: 2, graph: LEAD_V2 }],
    [V1, { version: 1, graph: LEAD_V1 }],
  ]);

  it("finished run: answers from its variables, no step, version number", () => {
    const r = buildRow(run(), cols, versions, new Set(["run-1:save_city"]));
    expect(r).toMatchObject({ name: "Asha", phone: "+919800000001", status: "finished", step: null, version: 2, conversation_id: "cv1" });
    expect(r.answers).toEqual({ "var:city": "Pune", "var:budget": "Under 25k", "var:location": "", "field:city": "Pune", "var:pincode": "" });
  });
  it("an Update field shows only for runs that passed that step", () => {
    const r = buildRow(run(), cols, versions, new Set());
    expect(r.answers["field:city"]).toBe("");
  });
  it("unfinished run: the step it waits at / stopped at", () => {
    expect(buildRow(run({ status: "waiting", current_node_id: "q_budget" }), cols, versions, new Set()).step).toBe("budget");
    expect(buildRow(run({ status: "expired", current_node_id: "q_city" }), cols, versions, new Set())).toMatchObject({ status: "stopped", step: "City" });
    expect(buildRow(run({ status: "failed", current_node_id: "menu" }), cols, versions, new Set())).toMatchObject({ status: "failed", step: "Shall we call you?" });
  });
  it("runs on an older version keep their answers and step names", () => {
    const r = buildRow(run({ version_id: V1, status: "cancelled", current_node_id: "q_pin", variables: { city: "Goa", pincode: "403001" } }), cols, versions, new Set());
    expect(r).toMatchObject({ version: 1, step: "pincode" });
    expect(r.answers["var:pincode"]).toBe("403001");
  });
  it("non-text answers are written out, never dropped", () => {
    const r = buildRow(run({ variables: { city: 42, location: { lat: 1, lng: 2 } } }), cols, versions, new Set());
    expect(r.answers["var:city"]).toBe("42");
    expect(r.answers["var:location"]).toBe('{"lat":1,"lng":2}');
  });
  it("a deleted contact still gives a row", () => {
    expect(buildRow(run({ contacts: null }), cols, versions, new Set())).toMatchObject({ name: "", phone: "" });
  });
});

describe("(2) filters", () => {
  const now = new Date(2026, 9, 5, 15, 20); // 5 Oct 2026, 15:20 local
  it("today / 7 days / 30 days start at local midnight; no upper bound", () => {
    expect(rangeBounds("today", { from: "", to: "" }, now)).toEqual({ from: new Date(2026, 9, 5).toISOString(), to: null });
    expect(rangeBounds("7d", { from: "", to: "" }, now)).toEqual({ from: new Date(2026, 8, 29).toISOString(), to: null });
    expect(rangeBounds("30d", { from: "", to: "" }, now)).toEqual({ from: new Date(2026, 8, 6).toISOString(), to: null });
  });
  it("custom includes both days; a missing date leaves that side open", () => {
    expect(rangeBounds("custom", { from: "2026-09-01", to: "2026-09-30" }, now)).toEqual({
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 9, 1).toISOString(),
    });
    expect(rangeBounds("custom", { from: "", to: "bad" }, now)).toEqual({ from: null, to: null });
  });
  it("search text can't break out of a PostgREST filter", () => {
    expect(cleanSearch(' a*b%c,d(e)f"g\\h ')).toBe("ab c d e f g h");
    expect(cleanSearch("x".repeat(200))).toHaveLength(80);
    expect(cleanSearch(null)).toBe("");
  });
});

describe("(4) CSV", () => {
  it("formula-injection safe: = + - @ (and tab / CR) get an apostrophe", () => {
    expect(["=SUM(A1)", "+91 98", "-1", "@cmd", "\tx", "\rx"].map(csvSafeCell)).toEqual(["'=SUM(A1)", "'+91 98", "'-1", "'@cmd", "'\tx", "'\rx"]);
    expect(["Pune", "a=b", "", null, undefined, 5].map(csvSafeCell)).toEqual(["Pune", "a=b", "", "", "", "5"]);
  });
  it("unchanged: toCsv still quotes commas, quotes and newlines and leaves other cells alone", () => {
    expect(toCsv([["a,b", 'say "hi"', "x\ny", "=1", null]])).toBe('"a,b","say ""hi""","x\ny",=1,');
  });
  it("same columns as the table; every cell (headers too) is safe", () => {
    const cols = [
      { key: "var:city", label: "City", kind: "variable" as const, nodeIds: ["q_city"] },
      { key: "var:x", label: "=evil", kind: "variable" as const, nodeIds: ["q_x"] },
    ];
    const rows = responsesCsvRows(
      cols,
      [{ run_id: "r", contact_id: "c", conversation_id: null, name: "@Asha", phone: "+919800000001", started_at: "2026-10-04T05:30:00.000Z", status: "waiting", step: "City", version: 2, answers: { "var:city": "=HYPERLINK(\"http://x\")", "var:x": "-5" } }],
      "Asia/Kolkata",
    );
    expect(rows).toEqual([
      ["Customer name", "Phone", "Started", "Status", "Stopped at step", "Flow version", "City", "'=evil"],
      ["'@Asha", "'+919800000001", "2026-10-04 11:00", "Waiting", "City", "v2", "'=HYPERLINK(\"http://x\")", "'-5"],
    ]);
    const text = responsesCsv(cols, [], "Asia/Kolkata");
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(parseCsv(text)).toEqual([rows[0]]);
  });
});

describe("unchanged: segment filters still quote values the same way", () => {
  it("name contains", async () => {
    const { supabase } = fakeDb(() => undefined);
    const out = await segmentExpressions(supabase, "org", { match: "all", conditions: [{ field: "name", operator: "contains", value: 'a*"b' }] } as never);
    expect(out).toEqual({ match: "all", expressions: ['name.ilike."*a\\"b*"'] });
  });
});

// ---------- API route ----------

const h = vi.hoisted(() => ({
  db: null as null | ReturnType<typeof import("./test-support/fake-db").fakeDb>,
  perms: new Set<string>(),
  flowsV2: true,
  logged: [] as Array<{ action: string; details: Record<string, unknown> }>,
}));
vi.mock("@/lib/whatsapp-api.server", () => ({
  requireOrgMember: async (_req: Request, org: string) =>
    org === "11111111-1111-4111-8111-111111111111"
      ? { supabase: h.db!.supabase, organizationId: org, userId: "u1" }
      : Response.json({ error: "You don't have access to this workspace." }, { status: 403 }),
  requirePermission: async (_a: unknown, key: string) =>
    h.perms.has(key) ? null : Response.json({ error: `no ${key}` }, { status: 403 }),
  isResponse: (v: unknown) => v instanceof Response,
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
  logServerActivity: async (_db: unknown, _org: string, _u: string, action: string, details: Record<string, unknown>) => {
    h.logged.push({ action, details });
  },
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/flow-engine.server", () => ({ flowsV2Enabled: async () => h.flowsV2 }));

import { Route } from "../routes/api/flows/responses";

type Post = (a: { request: Request }) => Promise<Response>;
const post = (Route.options as unknown as { server: { handlers: { POST: Post } } }).server.handlers.POST;

type World = { flowKey?: string | null; runs?: RunRecord[]; total?: number; people?: string[]; counts?: (op: FakeOp) => number };
function world(w: World = {}) {
  h.db = fakeDb((op) => {
    if (op.table === "flows") return { data: w.flowKey === null ? null : { id: FLOW, name: "Lead form!", key: w.flowKey ?? "v2:abc" }, error: null };
    if (op.table === "flow_versions") return { data: VERSIONS, error: null };
    if (op.table === "contacts") return { data: (w.people ?? []).map((id) => ({ id, flow_runs: [{ id: "x" }] })), error: null };
    if (op.table === "organizations") return { data: { timezone: "Asia/Kolkata" }, error: null };
    if (op.table === "flow_run_events") return { data: [{ run_id: "run-1", node_id: "save_city" }], error: null };
    if (op.table === "flow_runs") {
      const opts = op.select?.[1] as { head?: boolean } | undefined;
      if (opts?.head) return { data: null, error: null, count: w.counts ? w.counts(op) : 0 };
      return { data: w.runs ?? [run()], error: null, count: w.total ?? (w.runs ?? [run()]).length };
    }
    return undefined;
  });
  return h.db;
}
const call = (body: Record<string, unknown>) =>
  post({ request: new Request("http://x", { method: "POST", body: JSON.stringify({ organization_id: ORG, flow_id: FLOW, ...body }) }) });
const runOps = () => h.db!.ops.filter((o) => o.table === "flow_runs");
const filtersOf = (o: FakeOp) => o.filters.map(([n, a]) => `${n}:${JSON.stringify(a)}`);

beforeEach(() => {
  h.perms = new Set(["contacts.view"]);
  h.flowsV2 = true;
  h.logged = [];
});

describe("(5) permissions and scoping", () => {
  it("viewing needs contacts.view — nothing is read without it", async () => {
    world();
    h.perms = new Set();
    const res = await call({ action: "list" });
    expect(res.status).toBe(403);
    expect(h.db!.ops).toEqual([]);
  });
  it("the CSV needs contacts.export on top of viewing", async () => {
    world();
    const res = await call({ action: "export" });
    expect(res.status).toBe(403);
    expect(runOps()).toEqual([]);
  });
  it("another workspace's id is refused", async () => {
    world();
    h.perms = new Set(["contacts.view", "contacts.export"]);
    const res = await post({ request: new Request("http://x", { method: "POST", body: JSON.stringify({ organization_id: "99999999-9999-4999-8999-999999999999", flow_id: FLOW, action: "list" }) }) });
    expect(res.status).toBe(403);
  });
  it("a flow not in this workspace (or a store flow) is not found", async () => {
    world({ flowKey: null });
    expect((await call({ action: "list" })).status).toBe(404);
    world({ flowKey: "abandoned_checkout" });
    expect((await call({ action: "list" })).status).toBe(404);
    expect(runOps()).toEqual([]);
  });
  it("Flows v2 off: refused", async () => {
    world();
    h.flowsV2 = false;
    expect((await call({ action: "list" })).status).toBe(403);
  });
  it("every read is scoped to the caller's organization", async () => {
    const db = world({ people: ["c9"] });
    await call({ action: "list", filters: { search: "asha" } });
    for (const o of db.ops) expect(db.has(o, "eq", "organization_id", ORG)).toBe(true);
    for (const o of runOps()) expect(db.has(o, "eq", "flow_id", FLOW)).toBe(true);
  });
});

describe("(1)(2)(3) list", () => {
  it("one page of 50, newest first, paginated in SQL with the total", async () => {
    const db = world({ total: 120 });
    const res = await call({ action: "list", page: 2, summary: false });
    const body = (await res.json()) as { rows: Array<{ answers: Record<string, string> }>; total: number; page_size: number; columns: Array<{ key: string; label: string }>; summary: unknown };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ total: 120, page_size: 50, summary: null });
    const page = runOps().find((o) => !(o.select?.[1] as { head?: boolean })?.head)!;
    expect(db.has(page, "range", 100, 149)).toBe(true);
    expect(db.has(page, "order", "started_at", { ascending: false })).toBe(true);
    expect(page.select?.[1]).toEqual({ count: "exact", head: false });
    // Draft-only variables are not columns; internal keys never are.
    expect(body.columns.map((c) => c.key)).toEqual(["var:city", "var:budget", "var:location", "field:city", "var:pincode"]);
    expect(body.rows[0]!.answers).toMatchObject({ "var:city": "Pune", "field:city": "Pune" });
  });
  it("status and dates become SQL filters", async () => {
    const db = world();
    await call({ action: "list", summary: false, filters: { status: "stopped", from: "2026-10-01T00:00:00.000Z", to: "2026-10-02T00:00:00.000Z" } });
    const page = runOps()[0]!;
    expect(db.has(page, "in", "status", ["cancelled", "expired"])).toBe(true);
    expect(db.has(page, "gte", "started_at", "2026-10-01T00:00:00.000Z")).toBe(true);
    expect(db.has(page, "lt", "started_at", "2026-10-02T00:00:00.000Z")).toBe(true);
  });
  it("search: name/phone among this flow's customers, or the answer variables — never internal keys", async () => {
    const db = world({ people: ["c1", "c2"] });
    await call({ action: "list", summary: false, filters: { search: "98000" } });
    const who = db.ops.find((o) => o.table === "contacts")!;
    expect(db.has(who, "eq", "flow_runs.flow_id", FLOW)).toBe(true);
    expect(db.has(who, "or", 'name.ilike."*98000*",phone.ilike."*98000*"')).toBe(true);
    const or = runOps()[0]!.filters.find(([n]) => n === "or")![1][0] as string;
    expect(or).toBe(
      'contact_id.in.(c1,c2),variables->>city.ilike."*98000*",variables->>budget.ilike."*98000*",variables->>location.ilike."*98000*",variables->>pincode.ilike."*98000*"',
    );
    expect(or).not.toMatch(/_attempts|_last_reply|_internal|last_answer/);
  });
  it("summary: started, finished, completion rate, drop-off per question — any status, same dates", async () => {
    const db = world({
      counts: (op) => {
        const f = filtersOf(op).join(" ");
        if (f.includes('neq:["status","done"]')) return f.includes('"q_city"') ? 3 : f.includes('"q_budget"') ? 2 : 0;
        if (f.includes('eq:["status","done"]')) return 6;
        return 12;
      },
    });
    const res = await call({ action: "list", filters: { status: "finished", from: "2026-10-01T00:00:00.000Z" } });
    const { summary } = (await res.json()) as { summary: { started: number; finished: number; completion_rate: number; drop_off: Array<{ node_id: string; label: string; count: number }> } };
    expect(summary).toMatchObject({ started: 12, finished: 6, completion_rate: 50 });
    expect(summary.drop_off.slice(0, 2)).toEqual([
      { node_id: "q_city", label: "City", count: 3 },
      { node_id: "q_budget", label: "budget", count: 2 },
    ]);
    // Counted in SQL (head requests), never by loading runs.
    const heads = runOps().filter((o) => (o.select?.[1] as { head?: boolean })?.head);
    expect(heads.length).toBe(2 + summary.drop_off.length);
    for (const o of heads) {
      expect(db.has(o, "gte", "started_at", "2026-10-01T00:00:00.000Z")).toBe(true);
      expect(o.filters.some(([n, a]) => n === "in" && a[0] === "status")).toBe(false);
    }
  });
  it("a search nothing can match returns no rows without reading runs", async () => {
    // Only fields (no variables) and no matching customer → nothing to look in.
    h.db = fakeDb((op) => {
      if (op.table === "flows") return { data: { id: FLOW, name: "F", key: "v2:x" }, error: null };
      if (op.table === "flow_versions") return { data: [{ id: V2, version: 1, status: "published", graph: { nodes: [{ id: "s", type: "set_field", data: { field: "city", value: "x" } }], edges: [] } }], error: null };
      if (op.table === "contacts") return { data: [], error: null };
      return undefined;
    });
    const res = await call({ action: "list", filters: { search: "zzz" } });
    expect(await res.json()).toMatchObject({ rows: [], total: 0, summary: { started: 0, finished: 0, completion_rate: 0 } });
    expect(runOps()).toEqual([]);
  });
  it("bad input is refused", async () => {
    world();
    expect((await call({ action: "list", filters: { status: "everything" } })).status).toBe(400);
    expect((await call({ action: "list", filters: { from: "yesterday" } })).status).toBe(400);
  });
});

describe("(4) export route", () => {
  it("CSV download of the filtered rows, safe cells, logged", async () => {
    world({ runs: [run({ contacts: { name: "=cmd", phone: "+919800000001", attributes: {} } })] });
    h.perms = new Set(["contacts.view", "contacts.export"]);
    const res = await call({ action: "export", filters: { status: "finished" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="lead-form-responses-\d{4}-\d{2}-\d{2}\.csv"$/);
    const rows = parseCsv(await res.text());
    expect(rows[0]).toEqual(["Customer name", "Phone", "Started", "Status", "Stopped at step", "Flow version", "City", "budget", "location", "Saved city", "pincode"]);
    expect(rows[1]).toEqual(["'=cmd", "'+919800000001", "2026-10-04 11:00", "Finished", "", "v2", "Pune", "Under 25k", "", "Pune", ""]);
    expect(h.db!.has(runOps()[0]!, "in", "status", ["done"])).toBe(true);
    expect(h.logged).toEqual([{ action: "flow_responses_exported", details: { flow_id: FLOW, rows: 1, truncated: false } }]);
  });
  it("reads 500 rows at a time and stops at the cap", async () => {
    const many = Array.from({ length: 500 }, (_, i) => run({ id: `r${i}` }));
    const db = world({ runs: many, counts: () => 2000 });
    const ctx = (await loadResponsesContext(db.supabase, ORG, FLOW))!;
    const out = await exportResponses(db.supabase, ctx, {}, 1000);
    expect(out.rows).toHaveLength(1000);
    expect(out.truncated).toBe(true);
    const pages = runOps().filter((o) => !(o.select?.[1] as { head?: boolean })?.head);
    expect(pages.map((o) => o.filters.find(([n]) => n === "range")![1])).toEqual([
      [0, 499],
      [500, 999],
    ]);
  });
  it("a short last chunk ends the export, not truncated", async () => {
    const db = world({ runs: [run()] });
    const ctx = (await loadResponsesContext(db.supabase, ORG, FLOW))!;
    const out = await exportResponses(db.supabase, ctx, {});
    expect(out).toMatchObject({ truncated: false, error: null });
    expect(out.rows).toHaveLength(1);
  });
});
