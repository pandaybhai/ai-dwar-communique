import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 19 item 2 — the flow worker has a deadline (~60 s, well before
 * pg_net's 120 s cut). Past it, it starts nothing new — no Meta send, no
 * Flows v2 claim, no no-reply run, no reminder — and returns cleanly; a send
 * it claimed but hadn't sent is handed back for the next tick.
 */

const MOCKED = [
  "@/lib/whatsapp-webhook.server",
  "@/lib/campaigns.server",
  "@/lib/flows.server",
  "@/lib/events.server",
  "@/lib/cod.server",
  "@/lib/flow-engine.server",
  "@/lib/flow-triggers.server",
  "@/lib/handoff-alerts.server",
];
const noEvent = async () => {};

const h = {
  client: null as unknown,
  sends: 0,
  codExpiries: 0,
  reminders: 0,
  tickArgs: [] as unknown[],
  noReplyArgs: [] as unknown[],
  beforeSend: () => {},
};

/** Date.now() moves on by `skip` ms whenever the test says time has passed. */
function clock() {
  const real = Date.now.bind(Date);
  let skip = 0;
  vi.spyOn(Date, "now").mockImplementation(() => real() + skip);
  return { jump: (ms: number) => (skip += ms) };
}

beforeEach(() => {
  Object.assign(h, { sends: 0, codExpiries: 0, reminders: 0, tickArgs: [], noReplyArgs: [], beforeSend: () => {} });
  vi.resetModules();
  vi.stubEnv("CRON_SECRET", "cron");
  vi.doMock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.client }));
  vi.doMock("@/lib/campaigns.server", () => ({
    loadSenderContext: async () => ({ accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "t" }),
    sendCampaignTemplate: async () => {
      h.sends += 1;
      return { messageId: "m-new", error: null };
    },
  }));
  vi.doMock("@/lib/flows.server", () => ({
    messageClassOf: () => "transactional",
    triggerStillValid: async () => ({ valid: true }),
    stepGateAllows: async () => ({ allowed: true }),
    optInAllows: () => ({ allowed: true }),
    loadSendSettings: async () => ({}),
    applyQuietHours: (now: Date) => now,
    frequencyCapReached: async () => false,
    flowLinkTarget: async () => null,
    resolveFlowVariables: async () => ({}),
    flowCarouselCards: async () => [],
  }));
  vi.doMock("@/lib/events.server", () => ({ emitEvent: noEvent }));
  vi.doMock("@/lib/cod.server", () => ({
    noteCodAsk: async () => {},
    expireCodConfirmations: async () => {
      h.codExpiries += 1;
      return 0;
    },
  }));
  vi.doMock("@/lib/flow-engine.server", () => ({
    tickRuns: async (_db: unknown, opts: unknown) => {
      h.tickArgs.push(opts);
      return { processed: 0, expired: 0 };
    },
  }));
  vi.doMock("@/lib/flow-triggers.server", () => ({
    dispatchNoReply: async (_db: unknown, opts: unknown) => {
      h.noReplyArgs.push(opts);
      return { started: 0 };
    },
  }));
  vi.doMock("@/lib/handoff-alerts.server", () => ({
    remindWaitingHandoffs: async () => {
      h.reminders += 1;
      return 0;
    },
  }));
});
afterEach(() => {
  for (const m of MOCKED) vi.doUnmock(m);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

function sendWorld() {
  const row: Record<string, unknown> = {
    id: "ss-1",
    organization_id: "org-1",
    flow_id: "flow-1",
    flow_step_id: "step-1",
    contact_id: "c-1",
    trigger_type: "order",
    trigger_id: "o-1",
    status: "scheduled",
    error: null,
    claimed_at: new Date().toISOString(),
  };
  const db = fakeDb(
    (op: FakeOp) => {
      if (op.table === "scheduled_sends" && op.kind === "update") {
        if (row["status"] === "scheduled") Object.assign(row, op.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      if (op.table === "scheduled_sends" && op.kind === "select") return { data: [], error: null };
      if (op.table === "flows")
        return { data: { id: "flow-1", key: "order_lifecycle", is_enabled: true, whatsapp_account_id: null, config: {} }, error: null };
      if (op.table === "flow_steps") return { data: { id: "step-1", step_order: 1, template_id: "tpl-1", condition: null, is_enabled: true }, error: null };
      if (op.table === "contacts") return { data: { id: "c-1", name: "Asha", phone: "+919800000001", opt_in_status: "opted_in" }, error: null };
      if (op.table === "message_templates") {
        h.beforeSend();
        return { data: { name: "order_update", language: "en", category: "UTILITY", status: "APPROVED", components: [] }, error: null };
      }
      return undefined;
    },
    (call) => (call.name === "claim_scheduled_sends" ? { data: [{ ...row }], error: null } : undefined),
  );
  return { db, row };
}

async function tick() {
  const { Route } = await import("../routes/api/internal/flow-worker");
  const post = (Route.options as unknown as { server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } } }).server.handlers.POST;
  const res = await post({ request: new Request("http://x/api/internal/flow-worker", { method: "POST", headers: { "x-cron-secret": "cron" } }) });
  return (await res.json()) as Record<string, unknown>;
}

describe("2. flow worker deadline", () => {
  it("healthy: sends, ticks and reminds exactly as before; every step gets the deadline", async () => {
    clock();
    const w = sendWorld();
    h.client = w.db.supabase;
    const out = await tick();
    expect(h.sends).toBe(1);
    expect(w.row).toMatchObject({ status: "sent", message_id: "m-new" });
    expect(h.codExpiries).toBe(1);
    expect(h.reminders).toBe(1);
    expect(out["handoff_reminders"]).toBe(0);
    const deadline = (h.tickArgs[0] as { deadlineAt: number }).deadlineAt;
    expect(deadline - Date.now()).toBeGreaterThan(50_000);
    expect(deadline - Date.now()).toBeLessThanOrEqual(60_000);
    expect(h.noReplyArgs[0]).toEqual({ deadlineAt: deadline });
  });

  it("past the deadline before Meta is asked: not sent, claim handed back, nothing new started, returns cleanly", async () => {
    const t = clock();
    const w = sendWorld();
    h.client = w.db.supabase;
    h.beforeSend = () => t.jump(70_000);
    const out = await tick();
    expect(h.sends).toBe(0);
    // Still scheduled, claim released, never marked send_started: the next tick sends it.
    expect(w.row).toMatchObject({ status: "scheduled", claimed_at: null, error: null });
    expect(out["outcomes"]).toEqual([{ id: "ss-1", status: "deferred", reason: "deadline" }]);
    expect(h.codExpiries).toBe(0);
    expect(h.reminders).toBe(0);
    expect(out["handoff_reminders"]).toBe("deferred");
    // The Flows v2 tick and the no-reply triggers are told the (passed) deadline and claim nothing.
    expect((h.tickArgs[0] as { deadlineAt: number }).deadlineAt).toBeLessThan(Date.now());
    expect((h.noReplyArgs[0] as { deadlineAt: number }).deadlineAt).toBeLessThan(Date.now());
  });
});

describe("2. no-reply triggers stop at the deadline", () => {
  it("starts no new run once the deadline has passed and says so", async () => {
    const t = clock();
    const startRun = vi.fn(async () => {
      if (startRun.mock.calls.length === 3) t.jump(120_000);
      return { runId: "run-new", reason: null };
    });
    vi.doMock("@/lib/flow-engine.server", () => ({ startRun, flowsV2Enabled: async () => true, readPublishedVersion: async () => null }));
    vi.doUnmock("@/lib/flow-triggers.server");
    const { dispatchNoReply } = await import("./flow-triggers.server");
    const trigger = { id: "trig-1", organization_id: "org", flow_id: "flow-1", kind: "no_reply", config: { days: 3 } };
    const db = fakeDb((op: FakeOp) => {
      if (op.table === "flow_triggers") return { data: [trigger], error: null };
      if (op.table === "conversations" && op.filters.some(([f]) => f === "range"))
        return { data: Array.from({ length: 10 }, (_, i) => ({ id: `conv-${i}`, contact_id: `c${i}`, last_customer_message_at: "2026-01-01T00:00:00Z" })), error: null };
      if (op.table === "conversations") return { data: [], error: null };
      if (op.table === "flow_trigger_fires" || op.table === "flow_runs") return { data: [], error: null };
      return undefined;
    });
    const out = await dispatchNoReply(db.supabase, { deadlineAt: Date.now() + 60_000 });
    expect(startRun).toHaveBeenCalledTimes(3);
    expect(out).toEqual({ started: 3, deferred: true });
  });
});
