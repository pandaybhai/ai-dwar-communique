import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 19 item 7 (Batch 18 follow-up) — a paid flow's resume is retry-safe.
 * If the resume dies after the payment's key is logged, the run is not left
 * waiting (and later sent down "not paid"): a webhook retry of the same
 * payment, or the sweeper after the 5-minute reclaim, finishes it on the paid
 * path — exactly once, never both.
 */

vi.mock("@/lib/ai-tools.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/feature-flags.server", () => ({ enabledFlags: async () => new Set(["flows_v2"]) }));
vi.mock("@/lib/flows.server", () => ({ loadSendSettings: async () => ({ timezone: "Asia/Kolkata" }) }));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  ACCOUNT_COLUMNS: "id, organization_id, waba_id",
  getWhatsAppConnection: async () => ({ connection: null }),
  connectionForAccount: async () => ({ connection: null }),
}));

import { resumePaidRun, tickRuns } from "./flow-engine.server";

const GRAPH = {
  nodes: [
    { id: "s", type: "start", data: {} },
    { id: "p", type: "payment", data: { amount: "500", wait_hours: 24 } },
    { id: "ok", type: "end", data: {} },
    { id: "no", type: "end", data: {} },
  ],
  edges: [
    { id: "e1", source: "s", target: "p", sourceHandle: "next" },
    { id: "e2", source: "p", target: "ok", sourceHandle: "paid" },
    { id: "e3", source: "p", target: "no", sourceHandle: "not_paid" },
  ],
};
const RECLAIM_MS = 5 * 60_000;

/** Date.now() moves on when the test says time has passed. */
function clock() {
  const real = Date.now.bind(Date);
  let skip = 0;
  vi.spyOn(Date, "now").mockImplementation(() => real() + skip);
  return (ms: number) => (skip += ms);
}

function world(): MemoryDb {
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  return uniqueEventKeys(memoryDb(
    {
      flow_versions: [{ id: "ver-1", flow_id: "flow-1", graph: GRAPH }],
      flows: [{ id: "flow-1", whatsapp_account_id: null }],
      contacts: [{ id: "c-1", name: "Asha", phone: "+919800000001", wa_id: null, attributes: {}, opt_in_status: "opted_in" }],
      flow_runs: [
        {
          id: "run-1",
          organization_id: "org-1",
          flow_id: "flow-1",
          version_id: "ver-1",
          contact_id: "c-1",
          conversation_id: null,
          current_node_id: "p",
          variables: { payment_link: "https://rzp.io/l/x" },
          status: "waiting",
          waiting_for: "payment",
          wake_at: at(24 * 3600_000),
          claimed_at: null,
          steps: 2,
          started_at: at(-60_000),
          trigger: {},
        },
      ],
      flow_run_events: [],
    },
    {
      // claim_flow_runs as in 20261009_batch3_safety.sql: stale claims back
      // to their wait first, then due waits are claimed (moved to running).
      claim_flow_runs: (args, db) => {
        const now = Date.now();
        const rows = db.rows("flow_runs");
        for (const r of rows)
          if (r["status"] === "running" && r["claimed_at"] && Date.parse(String(r["claimed_at"])) < now - RECLAIM_MS && r["waiting_for"] != null)
            Object.assign(r, { status: "waiting", claimed_at: null });
        const due = rows
          .filter((r) => r["status"] === "waiting" && r["wake_at"] && Date.parse(String(r["wake_at"])) <= now && (!r["claimed_at"] || Date.parse(String(r["claimed_at"])) < now - RECLAIM_MS))
          .slice(0, Number(args["p_limit"] ?? 50));
        for (const r of due) Object.assign(r, { status: "running", claimed_at: new Date(now).toISOString() });
        return { data: due.map((r) => ({ ...r })), error: null };
      },
    },
  ));
}

/** flow_run_events.idempotency_key is unique (23505 on a second insert), as on the live DB. */
function uniqueEventKeys(db: MemoryDb): MemoryDb {
  const base = db.supabase as unknown as Record<string, unknown>;
  const from = base["from"] as (n: string) => Record<string, unknown>;
  base["from"] = (name: string) => {
    const query = from(name);
    if (name !== "flow_run_events") return query;
    const insert = query["insert"] as (p: unknown) => unknown;
    query["insert"] = (payload: Row | Row[]) => {
      const key = !Array.isArray(payload) ? payload["idempotency_key"] : undefined;
      if (key && db.rows("flow_run_events").some((e) => e["idempotency_key"] === key))
        return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
      return insert.call(query, payload);
    };
    return query;
  };
  return db;
}

/** The engine's client, except that the first save of a finished run dies (connection reset). */
function dyingOnce(db: MemoryDb): SupabaseClient {
  let died = false;
  const base = db.supabase as unknown as Record<string, unknown>;
  return {
    ...base,
    from(name: string) {
      const query = (base["from"] as (n: string) => Record<string, unknown>)(name);
      if (name !== "flow_runs") return query;
      let payload: Row | null = null;
      const wrap = (t: Record<string, unknown>): Record<string, unknown> =>
        new Proxy(t, {
          get(target, prop) {
            const value = target[prop as string];
            if (prop === "update")
              return (p: Row) => {
                payload = p;
                return wrap((value as (a: Row) => Record<string, unknown>).call(target, p));
              };
            if (prop === "then")
              return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
                if (!died && payload?.["status"] === "done") {
                  died = true;
                  return Promise.reject(new TypeError("fetch failed: connection reset")).then(res, rej);
                }
                return (value as (a: unknown, b: unknown) => unknown).call(target, res, rej);
              };
            return typeof value === "function" ? (...a: unknown[]) => wrap((value as (...x: unknown[]) => Record<string, unknown>).apply(target, a)) : value;
          },
        });
      return wrap(query);
    },
  } as unknown as SupabaseClient;
}

const run = (db: MemoryDb) => db.rows("flow_runs")[0]!;
const events = (db: MemoryDb, event: string) => db.rows("flow_run_events").filter((e) => e["event"] === event);
const ARGS = { organizationId: "org-1", runId: "run-1", nodeId: "p", paymentLinkId: "plink_1" };

afterEach(() => vi.restoreAllMocks());

describe("7. paid flows: the resume is retry-safe", () => {
  it("healthy: resumed once on the paid path; a redelivery is a no-op; nothing extra is left on the run", async () => {
    const db = world();
    expect(await resumePaidRun(db.supabase, ARGS)).toBe(true);
    expect(run(db)).toMatchObject({ status: "done", current_node_id: "ok", claimed_at: null, wake_at: null });
    expect(run(db)["variables"]).toEqual({ payment_link: "https://rzp.io/l/x", payment_id: "plink_1", payment_status: "paid" });
    expect(await resumePaidRun(db.supabase, ARGS)).toBe(false);
    expect(events(db, "paid")).toHaveLength(1);
  });

  it("dies after the key is logged → a retry while claimed does nothing; after the reclaim the sweeper finishes it paid, once", async () => {
    const jump = clock();
    const db = world();
    await expect(resumePaidRun(dyingOnce(db), ARGS)).rejects.toThrow(/connection reset/);
    // Claimed, mark kept, not finished; the key is logged.
    expect(run(db)).toMatchObject({ status: "running", current_node_id: "p", waiting_for: "payment" });
    expect(events(db, "payment_webhook")).toHaveLength(1);

    // Razorpay retries straight away: the run is still claimed → no second resume.
    expect(await resumePaidRun(db.supabase, ARGS)).toBe(false);
    expect(run(db)["status"]).toBe("running");

    // Before the reclaim window, the sweeper leaves it alone too.
    jump(60_000);
    expect(await tickRuns(db.supabase)).toMatchObject({ processed: 0 });

    // After it: back to its wait, due, and finished on the PAID path — never "not paid".
    jump(RECLAIM_MS);
    expect(await tickRuns(db.supabase)).toMatchObject({ processed: 1 });
    expect(run(db)).toMatchObject({ status: "done", current_node_id: "ok" });
    expect((run(db)["variables"] as Row)["payment_status"]).toBe("paid");
    expect((run(db)["variables"] as Row)["_paid_resume"]).toBeUndefined();
    expect(events(db, "not_paid")).toHaveLength(0);

    // Later deliveries and ticks: nothing more.
    expect(await resumePaidRun(db.supabase, ARGS)).toBe(false);
    jump(RECLAIM_MS);
    expect(await tickRuns(db.supabase)).toMatchObject({ processed: 0 });
  });

  it("dies → Razorpay's retry of the same payment after the reclaim finishes it (the logged key alone no longer blocks it), once", async () => {
    const jump = clock();
    const db = world();
    await expect(resumePaidRun(dyingOnce(db), ARGS)).rejects.toThrow();
    // The 5-minute reclaim puts the run back in its wait (claim_flow_runs, before the sweep).
    jump(RECLAIM_MS + 1000);
    Object.assign(run(db), { status: "waiting", claimed_at: null });

    expect(await resumePaidRun(db.supabase, ARGS)).toBe(true);
    expect(run(db)).toMatchObject({ status: "done", current_node_id: "ok" });
    expect((run(db)["variables"] as Row)["payment_status"]).toBe("paid");
    // The sweeper and any further delivery find nothing to do.
    expect(await resumePaidRun(db.supabase, ARGS)).toBe(false);
    jump(2 * 3600_000);
    expect(await tickRuns(db.supabase)).toMatchObject({ processed: 0 });
    expect(events(db, "not_paid")).toHaveLength(0);
    expect(events(db, "payment_webhook")).toHaveLength(1);
  });

  it("a different payment link never rides on another payment's mark", async () => {
    const jump = clock();
    const db = world();
    await expect(resumePaidRun(dyingOnce(db), ARGS)).rejects.toThrow();
    jump(RECLAIM_MS + 1000);
    Object.assign(run(db), { status: "waiting", claimed_at: null });
    expect(await resumePaidRun(db.supabase, { ...ARGS, paymentLinkId: "plink_other" })).toBe(false);
    expect(run(db)["status"]).toBe("waiting");
  });

  it("unchanged: a payment wait that simply expires still takes the not-paid path", async () => {
    const jump = clock();
    const db = world();
    jump(25 * 3600_000);
    expect(await tickRuns(db.supabase)).toMatchObject({ processed: 1 });
    expect(run(db)).toMatchObject({ status: "done", current_node_id: "no" });
    expect((run(db)["variables"] as Row)["payment_status"]).toBe("not_paid");
  });
});
