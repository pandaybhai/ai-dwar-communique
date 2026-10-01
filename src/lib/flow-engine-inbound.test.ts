import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/ai-tools.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/feature-flags.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/flows.server", () => ({ loadSendSettings: async () => ({ timezone: "Asia/Kolkata" }) }));

import { handleInboundForRuns, routeInbound } from "./flow-engine.server";

type Op = {
  table: string;
  kind: "select" | "update" | "insert";
  filters: Array<[string, unknown[]]>;
  payload?: unknown;
};

/**
 * A tiny in-memory stand-in for the Supabase query builder. `activeRuns` is
 * what each successive "active run" lookup sees (the last entry repeats).
 */
function fakeDb(activeRuns: Array<Record<string, unknown> | null>) {
  const ops: Op[] = [];
  const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
  let lookups = 0;
  const respond = (op: Op): { data: unknown; error: null } => {
    if (op.table === "flow_run_events" && op.kind === "insert") {
      const rows = Array.isArray(op.payload) ? op.payload : [op.payload];
      for (const r of rows as Array<{ event: string; detail: Record<string, unknown> }>) events.push({ event: r.event, detail: r.detail });
      return { data: null, error: null };
    }
    if (op.table === "flow_runs" && op.kind === "select") {
      const current = activeRuns[Math.min(lookups, activeRuns.length - 1)] ?? null;
      if (op.filters.some(([f]) => f === "in")) {
        lookups += 1;
        return { data: current ? [current] : [], error: null };
      }
      return { data: current, error: null };
    }
    if (op.table === "flow_runs" && op.kind === "update") {
      const isClaim = op.filters.some(([f, a]) => f === "eq" && a[0] === "status" && a[1] === "waiting");
      return { data: isClaim ? [{ id: "run-1" }] : null, error: null };
    }
    if (op.table === "flow_versions") return { data: { graph: { nodes: [], edges: [] } }, error: null };
    // contacts etc.: nothing found — advance() fails safe, which is fine here.
    return { data: null, error: null };
  };
  const client = {
    from(table: string) {
      const op: Op = { table, kind: "select", filters: [] };
      const builder: Record<string, unknown> = {};
      const chain = (name: string) => (...a: unknown[]) => {
        op.filters.push([name, a]);
        return builder;
      };
      for (const m of ["eq", "in", "or", "order", "limit", "maybeSingle", "single"]) builder[m] = chain(m);
      builder["select"] = () => builder;
      builder["update"] = (p: unknown) => ((op.kind = "update"), (op.payload = p), builder);
      builder["insert"] = (p: unknown) => ((op.kind = "insert"), (op.payload = p), builder);
      builder["then"] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
        ops.push(op);
        return Promise.resolve(respond(op)).then(res, rej);
      };
      return builder;
    },
  };
  return {
    supabase: client as unknown as SupabaseClient,
    ops,
    events,
    claimed: () => ops.some((o) => o.table === "flow_runs" && o.kind === "update" && o.filters.some(([f, a]) => f === "eq" && a[1] === "waiting")),
    names: () => events.map((e) => e.event),
  };
}

let seq = 0;
function run(over: Record<string, unknown>) {
  seq += 1;
  return {
    id: "run-1",
    organization_id: `org-${seq}`,
    flow_id: "flow-1",
    version_id: "ver-1",
    contact_id: "contact-1",
    conversation_id: "conv-1",
    current_node_id: "n1",
    variables: {},
    status: "waiting",
    waiting_for: "reply",
    wake_at: null,
    steps: 1,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

const inbound = (body = "hi", replyId: string | null = null) => ({
  organizationId: "org",
  contactId: "contact-1",
  conversationId: "conv-1",
  body,
  replyId,
});

describe("routeInbound", () => {
  it("routes by run state", () => {
    expect(routeInbound(null, false, "k")).toBe("release");
    expect(routeInbound({ status: "waiting", waiting_for: "reply", variables: {} }, false, "k")).toBe("take");
    expect(routeInbound({ status: "running", waiting_for: null, variables: {} }, false, "k")).toBe("hold");
    expect(routeInbound({ status: "waiting", waiting_for: "timer", variables: {} }, false, "k")).toBe("release");
    expect(routeInbound({ status: "waiting", waiting_for: "payment", variables: {} }, false, "k")).toBe("release");
    expect(routeInbound({ status: "done", waiting_for: null, variables: {} }, true, "k")).toBe("release");
  });

  it("drops only a held repeat of the same tap within 20 s", () => {
    const now = Date.parse("2026-09-28T10:00:00Z");
    const vars = { _last_reply: { k: "btn_yes", at: "2026-09-28T09:59:50Z" } };
    const r = { status: "waiting", waiting_for: "reply", variables: vars };
    expect(routeInbound(r, true, "btn_yes", now)).toBe("duplicate");
    expect(routeInbound(r, false, "btn_yes", now)).toBe("take");
    expect(routeInbound(r, true, "btn_no", now)).toBe("take");
    expect(routeInbound(r, true, "btn_yes", now + 30_000)).toBe("take");
  });
});

describe("handleInboundForRuns", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("no active run → normal routing", async () => {
    const db = fakeDb([null]);
    expect(await handleInboundForRuns(db.supabase, inbound())).toEqual({ consumed: false });
  });

  it("timer wait → normal routing (Aiden answers), never reply_ignored", async () => {
    const db = fakeDb([run({ waiting_for: "timer", wake_at: new Date(Date.now() + 3 * 86_400_000).toISOString() })]);
    expect(await handleInboundForRuns(db.supabase, inbound("where is my order?"))).toEqual({ consumed: false, runActive: true });
    expect(db.claimed()).toBe(false);
    expect(db.names()).toContain("reply_released");
    expect(db.names()).not.toContain("reply_ignored");
  });

  it("payment wait → normal routing", async () => {
    const db = fakeDb([run({ waiting_for: "payment" })]);
    expect(await handleInboundForRuns(db.supabase, inbound("paid?"))).toEqual({ consumed: false, runActive: true });
    expect(db.claimed()).toBe(false);
    expect(db.names()).toContain("reply_released");
  });

  it("waiting for this contact's reply → the flow takes it", async () => {
    const db = fakeDb([run({ waiting_for: "reply" })]);
    expect(await handleInboundForRuns(db.supabase, inbound("yes", "btn_yes"))).toEqual({ consumed: true });
    expect(db.claimed()).toBe(true);
    expect(db.names()).toContain("reply");
  });

  it("busy run → held, then handed to the flow when it waits for a reply", async () => {
    const db = fakeDb([run({ status: "running", waiting_for: null }), run({ waiting_for: "reply" })]);
    const p = handleInboundForRuns(db.supabase, inbound("yes", "btn_yes"));
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toEqual({ consumed: true });
    expect(db.names()).toEqual(expect.arrayContaining(["reply_held", "reply"]));
    expect(db.claimed()).toBe(true);
  });

  it("held message the flow can't take (run moved to a timer wait) → normal routing", async () => {
    const db = fakeDb([run({ status: "running", waiting_for: null }), run({ waiting_for: "timer" })]);
    const p = handleInboundForRuns(db.supabase, inbound("hello?"));
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toEqual({ consumed: false, runActive: true });
    expect(db.claimed()).toBe(false);
    const released = db.events.find((e) => e.event === "reply_released");
    expect(released?.detail).toMatchObject({ held: true, waiting_for: "timer" });
  });

  it("held message while the run stays busy past the hold → normal routing, not dropped", async () => {
    const db = fakeDb([run({ status: "running", waiting_for: null })]);
    const p = handleInboundForRuns(db.supabase, inbound("hello?"));
    await vi.advanceTimersByTimeAsync(13_000);
    expect(await p).toEqual({ consumed: false, runActive: true });
    expect(db.events.find((e) => e.event === "reply_released")?.detail).toMatchObject({ reason: "flow_busy" });
    expect(db.names()).not.toContain("reply_dropped");
  });

  it("held message after the run finished → normal routing", async () => {
    const db = fakeDb([run({ status: "running", waiting_for: null }), null]);
    const p = handleInboundForRuns(db.supabase, inbound("thanks"));
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toEqual({ consumed: false, runActive: false });
  });

  it("keeps the duplicate-tap drop: same button id within 20 s while held", async () => {
    const db = fakeDb([
      run({ status: "running", waiting_for: null }),
      run({ waiting_for: "reply", variables: { _last_reply: { k: "btn_yes", at: new Date().toISOString() } } }),
    ]);
    const p = handleInboundForRuns(db.supabase, inbound("Yes", "btn_yes"));
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toEqual({ consumed: true });
    expect(db.claimed()).toBe(false);
    expect(db.events.find((e) => e.event === "reply_dropped")?.detail).toMatchObject({ reason: "duplicate_tap" });
  });

  it("keeps the stuck-run guard: a run 'running' for over 2 minutes is ignored", async () => {
    const db = fakeDb([run({ status: "running", waiting_for: null, updated_at: new Date(Date.now() - 180_000).toISOString() })]);
    expect(await handleInboundForRuns(db.supabase, inbound("hello"))).toEqual({ consumed: false });
    expect(db.names()).not.toContain("reply_held");
  });
});
