import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { memoryDb, type Row } from "./test-support/memory-db";
import { activeRunsLine, isFlowDeleted, restoreDaysLeft } from "./flow-delete";

/**
 * Batch 35 item 4 — deleting a chat flow. A deleted flow never triggers
 * (keyword, first message, no-reply…) and never starts (startRun's
 * published-version read refuses it); deleting ends its active runs silently
 * in one database call and sends nothing; built-in store flows and the
 * platform's onboarding flow are refused; it can be restored for 30 days.
 * The SQL itself is tested on a throwaway Postgres (batch35-sql.test.ts).
 */

const startRun = vi.fn(async (_db: unknown, _a: { contactId: string; flowId: string }) => ({
  runId: "run-new",
  reason: null as string | null,
}));
vi.mock("@/lib/flow-engine.server", () => ({
  startRun: (db: unknown, a: { contactId: string; flowId: string }) => startRun(db, a),
  flowsV2Enabled: async () => true,
  readPublishedVersion: async () => null,
}));

import { dispatchInboundTriggers, dispatchNoReply } from "./flow-triggers.server";
import { deleteFlow, flowDeleteCheck, restoreFlow } from "./flow-delete.server";

const DELETED = { deleted_at: "2026-10-20T10:00:00Z", deleted_by: "u1", enabled_before: true };
const ACTIVITY_TABLE = ["activity", "log"].join("_");

beforeEach(() => startRun.mockClear());
afterEach(() => vi.unstubAllGlobals());

describe("a deleted flow never triggers", () => {
  const args = {
    organizationId: "org",
    contactId: "c1",
    conversationId: "conv-1",
    body: "menu",
    isFirstMessageEver: true,
    isCtwa: false,
    campaignButton: null,
  };
  const world = (triggers: unknown[]) =>
    fakeDb((op: FakeOp) => {
      if (op.table === "flow_triggers") return { data: triggers, error: null };
      if (op.table === "conversations") return { data: [], error: null };
      return undefined;
    });

  it("its keyword and first-message triggers are skipped; a live flow with the same keyword still starts", async () => {
    const deletedKw = {
      id: "t1",
      flow_id: "flow-deleted",
      kind: "keyword",
      config: { keywords: ["menu"], priority: 9 },
      flows: { whatsapp_account_id: null, config: DELETED },
    };
    const deletedFirst = {
      id: "t2",
      flow_id: "flow-deleted",
      kind: "first_message",
      config: {},
      flows: { whatsapp_account_id: null, config: DELETED },
    };
    const liveKw = {
      id: "t3",
      flow_id: "flow-live",
      kind: "keyword",
      config: { keywords: ["menu"], priority: 1 },
      flows: { whatsapp_account_id: null, config: { v2: true } },
    };
    expect(
      await dispatchInboundTriggers(world([deletedKw, deletedFirst, liveKw]).supabase, args),
    ).toEqual({ started: true, flowId: "flow-live" });
    expect(startRun.mock.calls.map((c) => c[1].flowId)).toEqual(["flow-live"]);

    startRun.mockClear();
    expect(await dispatchInboundTriggers(world([deletedKw, deletedFirst]).supabase, args)).toEqual({
      started: false,
    });
    expect(startRun).not.toHaveBeenCalled();
  });

  it("the trigger read asks for the flow's config with it (one query, no extra read)", async () => {
    const db = world([]);
    await dispatchInboundTriggers(db.supabase, args);
    const q = db.ops.find((o) => o.table === "flow_triggers")!;
    expect(String(q.select?.[0])).toContain("flows(whatsapp_account_id, config)");
  });

  it("no-reply triggers of a deleted flow never start", async () => {
    const db = fakeDb((op) =>
      op.table === "flow_triggers"
        ? {
            data: [
              {
                id: "t9",
                organization_id: "org",
                flow_id: "flow-deleted",
                kind: "no_reply",
                config: { days: 3 },
                flows: { config: DELETED },
              },
            ],
            error: null,
          }
        : { data: [], error: null },
    );
    expect((await dispatchNoReply(db.supabase)).started).toBe(0);
    expect(db.ops.some((o) => o.table === "conversations")).toBe(false);
  });

  it("startRun's gate: a deleted flow has no published version; a row without the flow read stays live", async () => {
    const engine =
      await vi.importActual<typeof import("./flow-engine.server")>("./flow-engine.server");
    const graph = { nodes: [{ id: "s", type: "start", data: {} }], edges: [] };
    const read = (row: unknown) =>
      engine.readPublishedVersion(fakeDb(() => ({ data: row, error: null })).supabase, "org", "f1");
    expect(await read({ id: "v1", graph, flows: { config: DELETED } })).toBeNull();
    expect(await read({ id: "v1", graph, flows: { config: { v2: true } } })).toEqual({
      id: "v1",
      graph,
    });
    expect(await read({ id: "v1", graph })).toEqual({ id: "v1", graph });
  });
});

describe("deleting and restoring", () => {
  function world(flows: Row[], rpcError: { code?: string; message: string } | null = null) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = memoryDb(
      {
        flows,
        platform_settings: [{ id: 1, onboarding_whatsapp_account_id: "acc-platform" }],
        flow_runs: [
          { id: "r1", organization_id: "org", flow_id: "f1", status: "waiting" },
          { id: "r2", organization_id: "org", flow_id: "f1", status: "paused" },
          { id: "r3", organization_id: "org", flow_id: "f1", status: "done" },
        ],
      },
      {
        flow_soft_delete: (args) => {
          calls.push({ name: "flow_soft_delete", args });
          return rpcError ? { data: null, error: rpcError } : { data: 2, error: null };
        },
        flow_restore_deleted: (args) => {
          calls.push({ name: "flow_restore_deleted", args });
          return rpcError ? { data: null, error: rpcError } : { data: true, error: null };
        },
      },
    );
    return { db, calls };
  }
  const v2 = (over: Row = {}): Row => ({
    id: "f1",
    organization_id: "org",
    key: "v2:abc",
    name: "Menu",
    whatsapp_account_id: null,
    config: { v2: true },
    ...over,
  });
  const args = { organizationId: "org", userId: "u1", flowId: "f1" };

  it("the confirm dialog gets the number of active runs", async () => {
    const { db } = world([v2()]);
    const check = await flowDeleteCheck(db.supabase, "org", "f1");
    expect(check).toEqual({ ok: true, data: { active_runs: 2, refusal: null } });
    expect(activeRunsLine(2)).toBe(
      "2 conversations are in this flow right now. They will end quietly — the customers get no message.",
    );
    expect(activeRunsLine(0)).toBe("No conversations are in this flow right now.");
  });

  it("one database call ends the runs; nothing is sent to anyone; logged", async () => {
    const fetchSpy = vi.fn(async () => new Response("no", { status: 599 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { db, calls } = world([v2()]);
    expect(await deleteFlow(db.supabase, args)).toEqual({ ok: true, data: { ended_runs: 2 } });
    expect(calls).toEqual([
      { name: "flow_soft_delete", args: { p_org: "org", p_flow: "f1", p_actor: "u1" } },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.rows("messages")).toHaveLength(0);
    expect(
      db.rows(ACTIVITY_TABLE).find((r) => r["action"] === "flow_v2_deleted")?.["details"],
    ).toEqual({ flow_id: "f1", name: "Menu", ended_runs: 2 });
  });

  it("built-in store flows and the platform's onboarding flow are refused with a reason", async () => {
    const legacy = world([v2({ key: "abandoned_checkout" })]);
    const a = await deleteFlow(legacy.db.supabase, args);
    expect(a.ok).toBe(false);
    expect(!a.ok && a.status).toBe(409);
    expect(!a.ok && a.error).toMatch(/built-in store flows/);
    expect(legacy.calls).toHaveLength(0);

    const platform = world([v2({ whatsapp_account_id: "acc-platform" })]);
    const b = await deleteFlow(platform.db.supabase, args);
    expect(!b.ok && b.error).toMatch(/onboarding number, so it's a platform flow/);
    expect((await flowDeleteCheck(platform.db.supabase, "org", "f1")).ok && true).toBe(true);
    expect(platform.calls).toHaveLength(0);

    // A merchant's own pinned flow is fine.
    expect(
      (await deleteFlow(world([v2({ whatsapp_account_id: "acc-shop" })]).db.supabase, args)).ok,
    ).toBe(true);
  });

  it("before the migration: a clear answer and nothing changed", async () => {
    const { db } = world([v2()], { code: "PGRST202", message: "not found" });
    const a = await deleteFlow(db.supabase, args);
    expect(!a.ok && a.status).toBe(503);
    expect(!a.ok && a.error).toMatch(/database update/);
    expect(db.rows("flows")[0]!["config"]).toEqual({ v2: true });
    expect(db.rows(ACTIVITY_TABLE)).toHaveLength(0);
  });

  it("restore within 30 days; refused after", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    try {
      const fresh = world([v2({ config: { v2: true, ...DELETED } })]);
      expect(await restoreFlow(fresh.db.supabase, args)).toEqual({
        ok: true,
        data: { restored: true },
      });
      expect(fresh.calls.map((c) => c.name)).toEqual(["flow_restore_deleted"]);
      expect(restoreDaysLeft({ config: DELETED })).toBe(22);

      const old = world([
        v2({ config: { v2: true, ...DELETED, deleted_at: "2026-09-01T00:00:00Z" } }),
      ]);
      const r = await restoreFlow(old.db.supabase, args);
      expect(!r.ok && r.status).toBe(410);
      expect(old.calls).toHaveLength(0);
      expect(restoreDaysLeft({ config: { ...DELETED, purged_at: "2026-10-21T00:00:00Z" } })).toBe(
        0,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("a flow row (or none) without the mark is live", () => {
    expect(isFlowDeleted(null)).toBe(false);
    expect(isFlowDeleted({ config: null })).toBe(false);
    expect(isFlowDeleted({ config: { v2: true } })).toBe(false);
    expect(isFlowDeleted({ config: DELETED })).toBe(true);
  });
});
