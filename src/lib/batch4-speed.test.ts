import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld, MENU_GRAPH } from "./test-support/latency-world";
import { inVirtualTime } from "./test-support/virtual-time";
import { OPT_OUT_CONFIRMATION } from "./opt-out";
import { processWebhookPayload } from "./whatsapp-webhook.server";
import { handleInboundForRuns } from "./flow-engine.server";
import { applyCodReply } from "./cod.server";

/**
 * Batch 4, item 1: a flow reply leaves in well under 3 s of the webhook being
 * received. Live, one database round trip from the worker to Mumbai costs
 * ~0.26 s, so the budget is "round trips before the WhatsApp send". Each
 * query in the latency world below costs one simulated round trip (RTT).
 *
 * Measured with this same harness (warm, one message):
 *                          before   after
 *   button tap → reply      23.4     8.1 RTT
 *   keyword → first prompt  22.3    10.1 RTT
 */
const RTT = 40;
const GRAPH = 120;

async function deliver(org: string, waitingRun: boolean, msg: Record<string, unknown>, extra: { duplicate?: boolean } = {}) {
  const w = latencyWorld({ org, rttMs: RTT, graphMs: GRAPH, waitingRun, ...extra });
  vi.stubGlobal("fetch", w.fetchStub);
  // Batch 17: on a virtual clock, so "within N round trips" never races a loaded machine.
  await inVirtualTime(async () => {
    w.t0.at = Date.now();
    await processWebhookPayload(w.supabase, `ev-${org}`, inboundPayload(msg), new Date().toISOString());
  });
  return { ...w, total: Date.now() - w.t0.at };
}
const TAP = { id: "wamid.tap", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } }, context: { id: "wamid.prompt" } };
const opIndex = (ops: FakeOp[], pred: (o: FakeOp) => boolean) => ops.findIndex(pred);

afterEach(() => vi.unstubAllGlobals());

describe("(1) flow replies: the send comes first", () => {
  it("warm-up (module loading is not part of any budget)", async () => {
    await deliver("org-warm", true, TAP);
  });

  it("a button tap on a waiting flow is answered within 10 round trips (was 23)", async () => {
    const w = await deliver("org-tap", true, TAP);
    expect(w.graphSends).toHaveLength(1);
    expect((w.graphSends[0]!.body["text"] as { body: string }).body).toBe("Browse our latest picks on our website.");
    expect(w.graphSends[0]!.at).toBeLessThan(10 * RTT + GRAPH);
  });

  it("a keyword that starts a flow sends its first prompt within 12 round trips (was 22)", async () => {
    const w = await deliver("org-kw", false, { id: "wamid.kw", type: "text", text: { body: "menu" } });
    expect(w.graphSends).toHaveLength(1);
    expect(w.graphSends[0]!.body["type"]).toBe("interactive");
    expect(w.graphSends[0]!.at).toBeLessThan(12 * RTT + GRAPH);
  });

  it("bookkeeping still lands, after the send and before the event is marked processed", async () => {
    const w = await deliver("org-order", true, TAP);
    const processed = opIndex(w.ops, (o) => o.table === "webhook_events" && o.kind === "update");
    const outbound = opIndex(w.ops, (o) => o.table === "messages" && o.kind === "insert");
    const received = opIndex(w.ops, (o) => o.table === "analytics_events" && (o.payload as { event_type?: string }).event_type === "message.received");
    const runLog = w.ops.map((o, i) => [o, i] as const).filter(([o]) => o.table === "flow_run_events");
    expect(outbound).toBeGreaterThan(-1);
    expect(received).toBeGreaterThan(-1);
    expect(processed).toBe(w.ops.length - 1);
    expect(received).toBeLessThan(processed);
    // The run's log (reply, exits, end) is one insert after the send; only the
    // idempotency row for the send itself is written before it.
    expect(runLog.filter(([, i]) => i < outbound).map(([o]) => Boolean((o.payload as { idempotency_key?: string }).idempotency_key))).toEqual([true]);
    const batch = runLog.find(([o]) => Array.isArray(o.payload))![0].payload as Array<{ event: string }>;
    expect(batch.map((r) => r.event)).toEqual(expect.arrayContaining(["reply", "exited", "ended"]));
    expect(runLog.at(-1)![1]).toBeLessThan(processed);
  });

  it("unchanged: the 24-hour window write lands before anything is sent", async () => {
    const w = await deliver("org-window", true, TAP);
    const windowWrite = opIndex(
      w.ops,
      (o) => o.table === "conversations" && o.kind === "update" && "last_customer_message_at" in (o.payload as object),
    );
    const firstSendCheck = opIndex(w.ops, (o) => o.table === "messages" && o.kind === "insert");
    expect(windowWrite).toBeGreaterThan(-1);
    expect(windowWrite).toBeLessThan(firstSendCheck);
  });

  it("unchanged: STOP is an opt-out — the confirmation goes out, the waiting flow never takes it", async () => {
    const w = await deliver("org-stop", true, { id: "wamid.stop", type: "text", text: { body: "STOP" } });
    expect(w.graphSends).toHaveLength(1);
    expect((w.graphSends[0]!.body["text"] as { body: string }).body).toBe(OPT_OUT_CONFIRMATION);
    const claims = w.ops.filter((o) => o.table === "flow_runs" && o.kind === "update" && (o.payload as { status?: string }).status === "running");
    expect(claims).toHaveLength(0);
    const optOut = w.ops.find((o) => o.table === "contacts" && o.kind === "update");
    expect(optOut?.payload).toMatchObject({ opt_in_status: "opted_out" });
    // The window write still happened before the confirmation was sent.
    const windowWrite = opIndex(w.ops, (o) => o.table === "conversations" && o.kind === "update" && "last_customer_message_at" in (o.payload as object));
    expect(windowWrite).toBeLessThan(opIndex(w.ops, (o) => o.table === "messages" && o.kind === "insert"));
  });

  it("unchanged: a redelivered message is never answered twice", async () => {
    const w = await deliver("org-dupe", true, TAP, { duplicate: true });
    expect(w.graphSends).toHaveLength(0);
    expect(w.ops.some((o) => o.table === "flow_runs" && o.kind === "update")).toBe(false);
  });

  it("unchanged: our own number echoing back is never automated", async () => {
    const w = await deliver("org-echo", true, { ...TAP, from: "911111111111" });
    expect(w.graphSends).toHaveLength(0);
  });

  it("logs one timing line per message: route and per-stage ms", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => void lines.push(String(line)));
    await deliver("org-log", true, TAP);
    spy.mockRestore();
    const timing = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).find((l) => l?.["scope"] === "webhook_timing");
    expect(timing).toMatchObject({ scope: "webhook_timing", message_id: "wamid.tap", route: "flow" });
    expect(Object.keys(timing!["stages"] as object)).toEqual(expect.arrayContaining(["contact", "message_stored", "guards_done", "flows"]));
    expect(typeof timing!["received_lag_ms"]).toBe("number");
  });
});

// ------------------------------------------------------------ the engine
const waitingRun = (org: string) => ({
  id: `run-${org}`,
  organization_id: org,
  flow_id: "flow-1",
  version_id: "ver-1",
  contact_id: "c1",
  conversation_id: "cv1",
  current_node_id: "menu",
  variables: { seen: 1 },
  status: "waiting",
  waiting_for: "reply",
  wake_at: null,
  steps: 2,
  started_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
});

function engineDb(org: string, opts: { graph?: unknown; claim?: boolean } = {}) {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] })));
  return fakeDb((op) => {
    if (op.table === "feature_flags") return { data: [{ key: "flows_v2", default_enabled: true }], error: null };
    if (op.table === "flow_runs" && op.kind === "select") return { data: [waitingRun(org)], error: null };
    if (op.table === "flow_runs" && op.kind === "update")
      return { data: (op.payload as { status?: string }).status === "running" && opts.claim === false ? [] : [{ id: `run-${org}` }], error: null };
    if (op.table === "flow_versions") return { data: { graph: opts.graph === undefined ? MENU_GRAPH : opts.graph }, error: null };
    if (op.table === "contacts") return { data: { name: "Asha", phone: "+919800000001", wa_id: "919800000001", attributes: {}, opt_in_status: "unknown" }, error: null };
    if (op.table === "conversations") return { data: { last_customer_message_at: new Date().toISOString(), whatsapp_account_id: "acc" }, error: null };
    if (op.table === "whatsapp_accounts") return { data: { id: "acc", organization_id: org, waba_id: "w", phone_number_id: "pn", status: "active", is_default: true }, error: null };
    if (op.table === "whatsapp_credentials") return { data: { access_token: "tok" }, error: null };
    if (op.table === "messages") return { data: { id: "m-out" }, error: null };
    return undefined;
  });
}
const tap = { contactId: "c1", conversationId: "cv1", whatsappAccountId: "acc", body: "Shop", replyId: "menu:b1" };

describe("(1) engine: the parallel take path keeps every rule", () => {
  it("the prefetched first look is used as the run (no second read)", async () => {
    const db = engineDb("org-e1");
    const peeked = Promise.resolve(waitingRun("org-e1") as never);
    const out = await handleInboundForRuns(db.supabase, { organizationId: "org-e1", ...tap, firstLook: peeked });
    expect(out).toEqual({ consumed: true });
    expect(db.ops.filter((o) => o.table === "flow_runs" && o.kind === "select")).toHaveLength(0);
  });

  it("a first look that failed (undefined) is read again; one that found nothing is trusted", async () => {
    const again = engineDb("org-e2");
    await handleInboundForRuns(again.supabase, { organizationId: "org-e2", ...tap, firstLook: Promise.resolve(undefined) });
    expect(again.ops.some((o) => o.table === "flow_runs" && o.kind === "select")).toBe(true);

    const none = engineDb("org-e3");
    expect(await handleInboundForRuns(none.supabase, { organizationId: "org-e3", ...tap, firstLook: Promise.resolve(null) })).toEqual({ consumed: false });
    expect(none.ops.some((o) => o.table === "flow_runs")).toBe(false);
  });

  it("variables saved after the reply keep what the run had plus the reply marker (env was read in parallel)", async () => {
    const db = engineDb("org-e4");
    await handleInboundForRuns(db.supabase, { organizationId: "org-e4", ...tap });
    const saves = db.ops.filter((o) => o.table === "flow_runs" && o.kind === "update" && "variables" in (o.payload as object));
    const vars = (saves.at(-1)!.payload as { variables: Record<string, unknown> }).variables;
    expect(vars["seen"]).toBe(1);
    expect(vars["last_answer"]).toBe("Shop");
    expect((vars["_last_reply"] as { k: string }).k).toBe("menu:b1");
  });

  it("no published graph: a run claimed in the same round trip is put back exactly as it was waiting", async () => {
    const db = engineDb("org-e5", { graph: null });
    expect(await handleInboundForRuns(db.supabase, { organizationId: "org-e5", ...tap })).toEqual({ consumed: false, runActive: true });
    const updates = db.ops.filter((o) => o.table === "flow_runs" && o.kind === "update").map((o) => o.payload);
    expect(updates.at(-1)).toEqual({ status: "waiting", claimed_at: null });
    expect(db.ops.some((o) => o.table === "messages")).toBe(false);
  });

  it("unchanged: a lost claim sends nothing (the run is busy; the message is held, then released)", async () => {
    vi.useFakeTimers();
    try {
      const db = engineDb("org-e6", { claim: false });
      const done = handleInboundForRuns(db.supabase, { organizationId: "org-e6", ...tap });
      await vi.advanceTimersByTimeAsync(13_000);
      expect(await done).toEqual({ consumed: false, runActive: true });
      expect(db.ops.some((o) => o.table === "messages")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------------- COD
describe("(1) cash-on-delivery: the fallback is read alongside the quote, used exactly as before", () => {
  const pendingRow = { id: "cod-latest", organization_id: "org", order_id: "o-latest", contact_id: "c1", status: "pending", asked_at: "2026-09-01T00:00:00Z" };
  const quotedRow = { id: "cod-quoted", organization_id: "org", order_id: "o-quoted", contact_id: "c1", status: "pending", asked_at: "2026-08-01T00:00:00Z" };
  const codDb = (quoteLeadsToOrder: boolean) =>
    fakeDb((op) => {
      if (op.table === "messages") return { data: { id: "m", scheduled_send_id: quoteLeadsToOrder ? "s1" : null }, error: null };
      if (op.table === "scheduled_sends" && op.kind === "select" && op.filters.some(([f, a]) => f === "eq" && a[0] === "id"))
        return { data: { trigger_type: "order", trigger_id: "o-quoted" }, error: null };
      if (op.table === "scheduled_sends") return { data: [], error: null };
      if (op.table === "cod_confirmations" && op.kind === "select")
        return { data: op.filters.some(([f, a]) => f === "eq" && a[0] === "order_id") ? quotedRow : pendingRow, error: null };
      return undefined;
    });
  const settled = (db: ReturnType<typeof codDb>) =>
    db.ops.filter((o) => o.table === "cod_confirmations" && o.kind === "update").map((o) => o.filters.find(([f, a]) => f === "eq" && a[0] === "id")?.[1][1]);

  it("a quote that leads to an order confirms that order, not the newest pending ask", async () => {
    const db = codDb(true);
    expect(await applyCodReply(db.supabase, { organizationId: "org", contactId: "c1", contextMetaId: "wamid.ask", body: "Confirm", payload: "cod_confirm" })).toBe(true);
    expect(settled(db)).toEqual(["cod-quoted"]);
  });

  it("a quote that leads nowhere falls back to the newest pending ask", async () => {
    const db = codDb(false);
    expect(await applyCodReply(db.supabase, { organizationId: "org", contactId: "c1", contextMetaId: "wamid.flowprompt", body: "Confirm", payload: "cod_confirm" })).toBe(true);
    expect(settled(db)).toEqual(["cod-latest"]);
  });
});
