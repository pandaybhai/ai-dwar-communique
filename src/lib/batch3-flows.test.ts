import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

vi.mock("@/lib/ai-tools.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/flows.server", () => ({ loadSendSettings: async () => ({ timezone: "Asia/Kolkata" }) }));
vi.mock("@/lib/whatsapp-numbers.server", () => ({ getWhatsAppConnection: async () => ({ connection: null }) }));

import { MAX_GOTO_HOPS, tickRuns } from "./flow-engine.server";

const GRAPH = {
  nodes: [
    { id: "s", type: "start", data: {} },
    { id: "w", type: "wait", data: { minutes: 30 } },
    { id: "g", type: "goto_flow", data: { flow_id: "flow-2" } },
    { id: "e", type: "end", data: {} },
  ],
  edges: [
    { id: "e1", source: "s", target: "w", sourceHandle: "next" },
    { id: "e2", source: "w", target: "g", sourceHandle: "next" },
  ],
};
const WAIT_ONLY = {
  nodes: GRAPH.nodes.filter((n) => n.id !== "g"),
  edges: [GRAPH.edges[0]!, { id: "e2", source: "w", target: "e", sourceHandle: "next" }],
};
const NEXT_FLOW = {
  nodes: [
    { id: "s2", type: "start", data: {} },
    { id: "w2", type: "wait", data: { minutes: 60 } },
  ],
  edges: [{ id: "x", source: "s2", target: "w2", sourceHandle: "next" }],
};

let seq = 0;
/** A run as claim_flow_runs returns it once the migration is applied: already "running". */
const claimedRun = (status = "running") => ({
  id: "run-1",
  organization_id: `org-${++seq}`,
  flow_id: "flow-1",
  version_id: "ver-1",
  contact_id: "contact-1",
  conversation_id: "conv-1",
  current_node_id: "w",
  variables: {},
  status,
  waiting_for: "timer",
  wake_at: new Date(Date.now() - 1000).toISOString(),
  steps: 2,
  started_at: new Date().toISOString(),
  trigger: {},
});

function world(opts: { graph: object; runStatus?: string; trigger?: Record<string, unknown> }) {
  return fakeDb(
    (op: FakeOp) => {
      if (op.table === "contacts") return { data: { name: "Asha", phone: "+919800000001", wa_id: null, attributes: {}, opt_in_status: "opted_in" }, error: null };
      if (op.table === "flow_versions") {
        const next = op.filters.some(([n, a]) => n === "eq" && a[0] === "flow_id" && a[1] === "flow-2");
        return { data: next ? { id: "ver-2", graph: NEXT_FLOW } : { graph: opts.graph }, error: null };
      }
      if (op.table === "flow_runs" && op.kind === "select") return { data: { trigger: opts.trigger ?? {} }, error: null };
      if (op.table === "flow_runs" && op.kind === "insert") {
        const p = op.payload as Record<string, unknown>;
        return { data: { ...claimedRun("running"), ...p, id: "run-2", current_node_id: "s2", steps: 0 }, error: null };
      }
      return undefined;
    },
    (call) => (call.name === "claim_flow_runs" ? { data: [claimedRun(opts.runStatus)], error: null } : undefined),
  );
}

const run1Saves = (db: ReturnType<typeof world>) =>
  db.ops
    .filter((op) => op.table === "flow_runs" && op.kind === "update" && op.filters.some(([n, a]) => n === "eq" && a[0] === "id" && a[1] === "run-1"))
    .map((op) => op.payload as Record<string, unknown>);

describe("(4) timer claim moves the run to running; the engine advances it from its wait", () => {
  it("a claimed ('running') timer wait continues past the wait instead of waiting again", async () => {
    const db = world({ graph: WAIT_ONLY });
    const out = await tickRuns(db.supabase);
    expect(out.processed).toBe(1);
    const saves = run1Saves(db);
    expect(saves.at(-1)?.["status"]).toBe("done");
    expect(saves.some((p) => p["waiting_for"] === "timer")).toBe(false);
  });

  it("unchanged: a run the old claim returns ('waiting') behaves the same", async () => {
    const db = world({ graph: WAIT_ONLY, runStatus: "waiting" });
    await tickRuns(db.supabase);
    expect(run1Saves(db).at(-1)?.["status"]).toBe("done");
  });
});

describe("(4) Go-to-flow chains stop after 10 hand-overs", () => {
  it(`a run that is already hand-over ${MAX_GOTO_HOPS} fails with goto_limit and starts nothing`, async () => {
    const db = world({ graph: GRAPH, trigger: { kind: "goto_flow", hops: MAX_GOTO_HOPS } });
    await tickRuns(db.supabase);
    const last = run1Saves(db).at(-1)!;
    expect(last["status"]).toBe("failed");
    expect(last["last_error"]).toBe("goto_limit");
    expect(db.ops.some((op) => op.table === "flow_runs" && op.kind === "insert")).toBe(false);
  });

  it("unchanged: below the cap the next flow starts, carrying the hop count", async () => {
    const db = world({ graph: GRAPH, trigger: { kind: "goto_flow", hops: 3 } });
    await tickRuns(db.supabase);
    expect(run1Saves(db).some((p) => p["status"] === "done")).toBe(true);
    const insert = db.ops.find((op) => op.table === "flow_runs" && op.kind === "insert")!;
    expect((insert.payload as { trigger: Record<string, unknown> }).trigger).toEqual({ kind: "goto_flow", from_run: "run-1", hops: 4 });
  });

  it("a run started by any other trigger is hop 0", async () => {
    const db = world({ graph: GRAPH, trigger: { kind: "keyword" } });
    await tickRuns(db.supabase);
    const insert = db.ops.find((op) => op.table === "flow_runs" && op.kind === "insert")!;
    expect((insert.payload as { trigger: Record<string, unknown> }).trigger["hops"]).toBe(1);
  });
});

describe("(4) migration (not applied): claim sets running, reclaims stuck runs", () => {
  const sql = readFileSync(new URL("../../supabase/aidwar-migrations/20261009_batch3_safety.sql", import.meta.url), "utf8");
  it("timer claim sets status running; stuck claimed runs over 5 minutes go back to waiting", () => {
    expect(sql).toMatch(/SET status = 'running', claimed_at = now\(\)/);
    expect(sql).toMatch(/SET status = 'waiting', claimed_at = NULL[\s\S]*claimed_at < now\(\) - interval '5 minutes'/);
  });
  it("idempotent statements only", () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.claim_flow_runs/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS wallet_ledger_payment_credit_once/);
    expect(sql).not.toMatch(/^\s*(DROP|ALTER TABLE|CREATE TABLE|CREATE INDEX (?!IF))/im);
  });
});
