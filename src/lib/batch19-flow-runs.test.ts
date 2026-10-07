import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 19 item 2 — the Flows v2 tick stops at the worker's deadline: no new
 * claim once it has passed, and runs claimed but not reached are handed back
 * (only our own, untouched claim) for the next tick.
 */

vi.mock("@/lib/ai-tools.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/feature-flags.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/flows.server", () => ({ loadSendSettings: async () => ({ timezone: "Asia/Kolkata" }) }));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  ACCOUNT_COLUMNS: "id, organization_id, waba_id",
  getWhatsAppConnection: async () => ({ connection: null }),
  connectionForAccount: async () => ({ connection: null }),
}));

import { tickRuns } from "./flow-engine.server";

const WAIT_THEN_END = {
  nodes: [
    { id: "s", type: "start", data: {} },
    { id: "w", type: "wait", data: { minutes: 30 } },
    { id: "e", type: "end", data: {} },
  ],
  edges: [
    { id: "e1", source: "s", target: "w", sourceHandle: "next" },
    { id: "e2", source: "w", target: "e", sourceHandle: "next" },
  ],
};

const claimedRun = (n: number) => ({
  id: `run-${n}`,
  organization_id: `org-${n}`,
  flow_id: "flow-1",
  version_id: "ver-1",
  contact_id: `contact-${n}`,
  conversation_id: `conv-${n}`,
  current_node_id: "w",
  variables: {},
  status: "running",
  waiting_for: "timer",
  wake_at: new Date(Date.now() - 1000).toISOString(),
  steps: 2,
  started_at: new Date().toISOString(),
  claimed_at: `2026-10-07T08:00:0${n}.000000+00:00`,
  trigger: {},
});

/** Date.now() moves on by `skip` ms whenever the test says time has passed. */
function clock() {
  const real = Date.now.bind(Date);
  let skip = 0;
  vi.spyOn(Date, "now").mockImplementation(() => real() + skip);
  return { now: real, jump: (ms: number) => (skip += ms) };
}

function world(onRunDone: (id: string) => void) {
  return fakeDb(
    (op: FakeOp) => {
      if (op.table === "contacts") return { data: { name: "Asha", phone: "+919800000001", wa_id: null, attributes: {}, opt_in_status: "opted_in" }, error: null };
      if (op.table === "flow_versions") return { data: { graph: WAIT_THEN_END }, error: null };
      if (op.table === "flow_runs" && op.kind === "select") return { data: { trigger: {} }, error: null };
      if (op.table === "flow_runs" && op.kind === "update" && (op.payload as Record<string, unknown>)["status"] === "done") {
        const id = op.filters.find(([n, a]) => n === "eq" && a[0] === "id")?.[1][1];
        onRunDone(String(id));
      }
      return undefined;
    },
    (call) => (call.name === "claim_flow_runs" ? { data: [1, 2, 3].map(claimedRun), error: null } : undefined),
  );
}

const putBacks = (db: ReturnType<typeof world>) =>
  db.ops.filter(
    (op) =>
      op.table === "flow_runs" &&
      op.kind === "update" &&
      (op.payload as Record<string, unknown>)["status"] === "waiting" &&
      (op.payload as Record<string, unknown>)["claimed_at"] === null,
  );

afterEach(() => vi.restoreAllMocks());

describe("2. Flows v2 tick deadline", () => {
  it("healthy: every claimed run is advanced and the result is exactly as before", async () => {
    const t = clock();
    const db = world(() => {});
    const out = await tickRuns(db.supabase, { deadlineAt: t.now() + 60_000 });
    expect(out).toEqual({ processed: 3, expired: 0 });
    expect(putBacks(db)).toHaveLength(0);
  });

  it("past the deadline mid-batch: the rest are handed back — own claim only — and never advanced", async () => {
    const t = clock();
    const db = world((id) => {
      if (id === "run-1") t.jump(120_000);
    });
    const out = await tickRuns(db.supabase, { deadlineAt: t.now() + 60_000 });
    expect(out).toEqual({ processed: 1, expired: 0, deferred: 2 });
    const back = putBacks(db);
    expect(back.map((op) => op.filters.find(([n, a]) => n === "eq" && a[0] === "id")?.[1][1])).toEqual(["run-2", "run-3"]);
    for (const [i, op] of back.entries()) {
      expect(db.has(op, "eq", "status", "running")).toBe(true);
      expect(db.has(op, "eq", "claimed_at", claimedRun(i + 2).claimed_at)).toBe(true);
    }
    // Only run-1 reached "done".
    const done = db.ops.filter((op) => op.table === "flow_runs" && op.kind === "update" && (op.payload as Record<string, unknown>)["status"] === "done");
    expect(done).toHaveLength(1);
  });

  it("already past the deadline: nothing is claimed", async () => {
    const t = clock();
    const db = world(() => {});
    const out = await tickRuns(db.supabase, { deadlineAt: t.now() - 1 });
    expect(out).toEqual({ processed: 0, expired: 0 });
    expect(db.rpcs.some((c) => c.name === "claim_flow_runs")).toBe(false);
  });
});
