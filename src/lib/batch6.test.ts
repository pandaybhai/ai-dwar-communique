import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { inVirtualTime } from "./test-support/virtual-time";
import { aidenWorld } from "./test-support/aiden-world";
import { coalesceBurst, finishEvent, processWebhookPayload } from "./whatsapp-webhook.server";
import { replyTimer, STAGE_ORDER } from "./reply-timing";
import { sendServiceText } from "./service-text.server";
import { enabledFlags as flagsFromAiTools } from "./ai-tools.server";
import { enabledFlags as flagsFromModule } from "./feature-flags.server";
import { prepareAgentInbound, readAgentGate, runAgentOnInbound } from "./ai-agent.server";
import { conversationTurns } from "./ai-tasks.server";
import { OPT_OUT_CONFIRMATION } from "./opt-out";

/**
 * Batch 6.
 *  (1) Per-stage reply timings are stored on webhook_events.timing (with the
 *      update that closes the event), and closing an event never depends on
 *      that column existing yet.
 *  (2) Flow replies: fewer round trips before the WhatsApp send — the number,
 *      markers and opt-out words in one read, the cash-on-delivery reads beside
 *      the message write, the run claimed/started while the window write lands
 *      (nothing is sent before it has), no conversation re-read, the published
 *      version read beside the ownership check, post-send writes together.
 *  (3) Aiden: the same gates and burst window; its chat-independent reads move
 *      into the burst wait and the gate is read beside the burst read.
 *
 * Harness: one query = one round trip (RTT); the Worker's six-connection cap
 * is modelled. On this harness (warm, send start after processing starts):
 *                         main    batch 6
 *   button tap → reply    7.1      5.1 RTT
 *   keyword → prompt      9.1      6.1 RTT
 *   Aiden, burst end → model call   7.1 → 4.0 RTT (aidenWorld), plus one
 *   read fewer before the reply send (the gate already checked the window)
 */
const RTT = 40;
const GRAPH = 120;
const TAP = {
  id: "wamid.tap",
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } },
  context: { id: "wamid.prompt" },
};
const KEYWORD = { id: "wamid.kw", type: "text", text: { body: "menu" } };

type World = ReturnType<typeof latencyWorld>;
async function deliver(org: string, waitingRun: boolean, msg: Record<string, unknown>, override?: Parameters<typeof latencyWorld>[0]["override"]) {
  const w = latencyWorld({ org, rttMs: RTT, graphMs: GRAPH, waitingRun, maxConcurrent: 6, ...(override ? { override } : {}) });
  vi.stubGlobal("fetch", w.fetchStub);
  // Batch 17: on a virtual clock, so "within N round trips" never races a loaded machine.
  await inVirtualTime(async () => {
    w.t0.at = Date.now();
    await processWebhookPayload(w.supabase, `ev-${org}`, inboundPayload(msg), new Date(Date.now() - 300).toISOString(), { storeMs: 210 });
  });
  return w;
}
const idx = (ops: FakeOp[], pred: (o: FakeOp) => boolean) => ops.findIndex(pred);
const closing = (w: World) => w.ops.filter((o) => o.table === "webhook_events" && o.kind === "update");
const isWindowWrite = (o: FakeOp) => o.table === "conversations" && o.kind === "update" && "last_customer_message_at" in (o.payload as object);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ (1)
describe("(1) timings are stored on the webhook event", () => {
  it("warm-up (module loading is not part of any budget)", async () => {
    await deliver("o6-warm", true, TAP);
    await deliver("o6-warm2", false, KEYWORD);
  });

  it("a flow reply stores every stage, in the same update that marks the event processed", async () => {
    const w = await deliver("o6-timing", true, TAP);
    const updates = closing(w);
    expect(updates).toHaveLength(1);
    const patch = updates[0]!.payload as { processed_at: string; error: null; timing: Record<string, unknown> };
    expect(patch.processed_at).toBeTruthy();
    expect(patch.error).toBeNull();
    const timing = patch.timing as {
      v: number;
      store_ms: number;
      received_lag_ms: number;
      messages: Array<{ message_id: string; route: string; marks: Record<string, number>; ms: Record<string, number>; received_to_send_ms: number }>;
    };
    expect(timing.v).toBe(1);
    expect(timing.store_ms).toBe(210);
    expect(timing.received_lag_ms).toBeGreaterThanOrEqual(300);
    const m = timing.messages[0]!;
    expect(m).toMatchObject({ message_id: "wamid.tap", route: "flow" });
    for (const stage of ["account", "contact", "conversation", "message_stored", "guards_done", "flow_routed", "flow_env", "send_start", "flows"]) {
      expect(m.marks[stage], stage).toBeTypeOf("number");
      expect(m.ms[stage], stage).toBeTypeOf("number");
    }
    // The send API call and the post-send writes are measured spans.
    expect(m.ms["send_api"]).toBeGreaterThanOrEqual(GRAPH - 5);
    expect(m.ms["post_send"]).toBeGreaterThanOrEqual(RTT - 5);
    // Marks only ever move forward, in the documented order.
    const seen = STAGE_ORDER.filter((s) => s in m.marks).map((s) => m.marks[s]!);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    // received_at was 300 ms before processing: the send is that much later.
    expect(m.received_to_send_ms).toBeGreaterThanOrEqual(m.marks["send_start"]! + 300);
  });

  it("unchanged: an event with nothing to time is closed exactly as before (no timing key)", async () => {
    const db = fakeDb(() => undefined);
    await finishEvent(db.supabase, "ev-c", [], "unknown_phone_number_id");
    const update = db.ops.find((o) => o.table === "webhook_events" && o.kind === "update")!;
    expect(update.payload).toEqual({ processed_at: expect.any(String), error: "unknown_phone_number_id" });
  });

  it("the timer computes stage durations between neighbouring marks", () => {
    let now = 1000;
    const { timer, result } = replyTimer(250, () => now);
    now = 1100;
    timer.mark("contact");
    now = 1100;
    timer.mark("account"); // out of order: still placed by STAGE_ORDER
    now = 1300;
    timer.mark("send_start");
    timer.mark("send_start"); // first occurrence wins
    timer.span("send_api", 400);
    timer.span("send_api", 100);
    now = 1900;
    const t = result("wamid.1", "flow");
    expect(t.marks).toEqual({ contact: 100, account: 100, send_start: 300 });
    expect(t.ms).toEqual({ account: 100, contact: 0, send_start: 200, send_api: 500 });
    expect(t.received_to_send_ms).toBe(550);
    expect(t.total_ms).toBe(900);
  });
});

// ------------------------------------------------------------------ (2)
describe("(2) flow replies: under 3 s means few round trips before the send", () => {
  it("a button tap's send starts within 6 round trips (main: 7)", async () => {
    const w = await deliver("o6-tap", true, TAP);
    expect(w.graphSends).toHaveLength(1);
    expect((w.graphSends[0]!.body["text"] as { body: string }).body).toBe("Browse our latest picks on our website.");
    expect(w.graphSends[0]!.at).toBeLessThan(6 * RTT);
  });

  it("a keyword that starts a flow starts sending within 7 round trips (main: 9)", async () => {
    const w = await deliver("o6-kw", false, KEYWORD);
    expect(w.graphSends).toHaveLength(1);
    expect(w.graphSends[0]!.body["type"]).toBe("interactive");
    expect(w.graphSends[0]!.at).toBeLessThan(7 * RTT);
  });

  it("the number, lead markers and opt-out words are one read (no separate marker/keyword reads)", async () => {
    const w = await deliver("o6-embed", true, TAP);
    expect(w.ops.filter((o) => o.table === "whatsapp_accounts")).toHaveLength(1);
    expect(w.ops.some((o) => o.table === "lead_source_markers")).toBe(false);
    expect(w.ops.some((o) => o.table === "opt_out_keywords")).toBe(false);
    // The number's row is reused: only the token is read for the connection.
    expect(w.ops.filter((o) => o.table === "whatsapp_credentials")).toHaveLength(1);
  });

  it("an opt-out word configured by the workspace (embedded) still opts out, and the flow never takes it", async () => {
    const w = await deliver("o6-custom-stop", true, { id: "wamid.unsub", type: "text", text: { body: "band karo" } }, (op) =>
      op.table === "whatsapp_accounts"
        ? {
            data: {
              id: "acc-o6-custom-stop",
              organization_id: "o6-custom-stop",
              waba_id: "waba",
              phone_number_id: "pn",
              display_phone_number: "911111111111",
              status: "active",
              is_default: true,
              organizations: { lead_source_markers: [], opt_out_keywords: [{ keyword: "band karo", action: "opt_out" }] },
            },
            error: null,
          }
        : undefined,
    );
    expect(w.graphSends).toHaveLength(1);
    expect((w.graphSends[0]!.body["text"] as { body: string }).body).toBe(OPT_OUT_CONFIRMATION);
    expect(w.ops.find((o) => o.table === "contacts" && o.kind === "update")?.payload).toMatchObject({ opt_in_status: "opted_out" });
    expect(w.ops.some((o) => o.table === "flow_runs" && o.kind === "update" && (o.payload as { status?: string }).status === "running")).toBe(false);
  });

  it("embedded markers label a brand-new contact, oldest marker first", { timeout: 15_000 }, async () => {
    const w = await deliver("o6-markers", false, { id: "wamid.m", type: "text", text: { body: "hi from INSTA and FB" } }, (op) =>
      op.table === "whatsapp_accounts"
        ? {
            data: {
              id: "acc-o6-markers",
              organization_id: "o6-markers",
              waba_id: "waba",
              phone_number_id: "pn",
              status: "active",
              organizations: {
                lead_source_markers: [
                  { marker: "FB", source: "facebook_post", created_at: "2026-02-01T00:00:00Z" },
                  { marker: "INSTA", source: "instagram_bio", created_at: "2026-01-01T00:00:00Z" },
                ],
                opt_out_keywords: [],
              },
            },
            error: null,
          }
        : undefined,
    );
    const upsert = w.ops.find((o) => o.table === "contacts" && o.kind === "upsert")!;
    expect(upsert.payload).toMatchObject({ source: "instagram_bio" });
  });

  it("unchanged: when the embedded read fails, the plain reads run as before", async () => {
    let first = true;
    const w = await deliver("o6-fallback", true, TAP, (op) => {
      if (op.table === "whatsapp_accounts" && first) {
        first = false;
        return { data: null, error: { code: "PGRST200", message: "Could not find a relationship" } };
      }
      return undefined;
    });
    expect(w.ops.filter((o) => o.table === "whatsapp_accounts")).toHaveLength(2);
    expect(w.ops.some((o) => o.table === "lead_source_markers")).toBe(true);
    expect(w.ops.some((o) => o.table === "opt_out_keywords")).toBe(true);
    expect(w.graphSends).toHaveLength(1);
  });

  it("unchanged: nothing is sent before the 24-hour window write has landed", async () => {
    for (const [org, waiting, msg] of [["o6-w-tap", true, TAP], ["o6-w-kw", false, KEYWORD]] as const) {
      const w = await deliver(org, waiting, msg);
      const windowWrite = w.starts.find((s) => s.table === "conversations" && s.kind === "update")!;
      expect(windowWrite).toBeTruthy();
      // The write's round trip finishes before the Graph call starts.
      expect(w.graphSends[0]!.at).toBeGreaterThanOrEqual(windowWrite.at + RTT - 2);
      expect(idx(w.ops, isWindowWrite)).toBeGreaterThan(-1);
    }
  });

  it("the run is claimed while the window write is in flight (one round trip saved)", async () => {
    const w = await deliver("o6-overlap", true, TAP);
    const windowWrite = w.starts.find((s) => s.table === "conversations" && s.kind === "update")!;
    const claim = w.starts.find((s) => s.table === "flow_runs" && s.kind === "update")!;
    expect(Math.abs(claim.at - windowWrite.at)).toBeLessThan(RTT / 2);
  });

  it("the engine doesn't re-read the conversation the message came in on", async () => {
    const w = await deliver("o6-noconv", true, TAP);
    const convReadsById = w.ops.filter((o) => o.table === "conversations" && o.kind === "select" && o.filters.some(([f, a]) => f === "eq" && a[0] === "id"));
    expect(convReadsById).toHaveLength(0);
  });

  it("unchanged: a pending cash-on-delivery answer is still taken by COD, never by the waiting flow", async () => {
    const w = await deliver("o6-cod", true, { id: "wamid.yes", type: "text", text: { body: "yes" } }, (op) => {
      if (op.table === "cod_confirmations" && op.kind === "select")
        return {
          data: { id: "cod-1", organization_id: "o6-cod", order_id: "ord-1", contact_id: "c1", status: "pending", asked_at: "2026-09-30T00:00:00Z" },
          error: null,
        };
      if (op.table === "cod_confirmations" && op.kind === "update") return { data: [{ id: "cod-1" }], error: null };
      return undefined;
    });
    expect(w.ops.some((o) => o.table === "cod_confirmations" && o.kind === "update")).toBe(true);
    expect(w.ops.some((o) => o.table === "flow_runs" && o.kind === "update" && (o.payload as { status?: string }).status === "running")).toBe(false);
    expect(w.graphSends).toHaveLength(0);
    // Its first read was started beside the message write, not after it.
    const write = w.starts.find((s) => s.table === "messages" && s.kind === "upsert")!;
    const codRead = w.starts.find((s) => s.table === "cod_confirmations" && s.kind === "select")!;
    expect(codRead.at - write.at).toBeLessThan(RTT / 2);
  });

  it("unchanged: a redelivered message is never answered twice, and our own echo is never automated", async () => {
    const dupe = latencyWorld({ org: "o6-dupe", rttMs: RTT, graphMs: GRAPH, waitingRun: true, duplicate: true, maxConcurrent: 6 });
    vi.stubGlobal("fetch", dupe.fetchStub);
    await processWebhookPayload(dupe.supabase, "ev-dupe", inboundPayload(TAP), new Date().toISOString());
    expect(dupe.graphSends).toHaveLength(0);
    expect(dupe.ops.some((o) => o.table === "flow_runs" && o.kind === "update")).toBe(false);
    const echo = await deliver("o6-echo", true, { ...TAP, from: "911111111111" });
    expect(echo.graphSends).toHaveLength(0);
  });

  it("a teammate-owned conversation still never starts a keyword flow (ownership read with the conversation)", { timeout: 15_000 }, async () => {
    // Batch 11 (6): assigned_to now arrives with the conversation the webhook
    // already reads, so no separate ownership read sits before the start.
    const w = await deliver("o6-owned", false, KEYWORD, (op) =>
      op.table === "conversations" && op.kind === "select" && String(op.select?.[0] ?? "").includes("assigned_to") && !op.filters.some(([f]) => f === "not")
        ? {
            data: {
              id: "cv1",
              contact_id: "c1",
              unread_count: 0,
              assigned_to: "teammate-1",
              last_customer_message_at: new Date().toISOString(),
              whatsapp_account_id: "acc-o6-owned",
              contacts: { phone: "+919800000001" },
            },
            error: null,
          }
        : undefined,
    );
    expect(w.ops.some((o) => o.table === "flow_runs" && o.kind === "insert")).toBe(false);
    expect(w.graphSends).toHaveLength(0);
    expect(w.ops.some((o) => o.table === "conversations" && o.filters.some(([f]) => f === "not"))).toBe(false);
  });

  it("unchanged: without the conversation's owner in hand, the trigger reads it itself and still holds back", async () => {
    const { dispatchInboundTriggers } = await import("./flow-triggers.server");
    const w = latencyWorld({
      org: "o6-owned2",
      rttMs: 1,
      graphMs: 1,
      waitingRun: false,
      override: (op) =>
        op.table === "conversations" && op.kind === "select" && op.filters.some(([f]) => f === "not")
          ? { data: [{ id: "cv1" }], error: null }
          : undefined,
    });
    vi.stubGlobal("fetch", w.fetchStub);
    const r = await dispatchInboundTriggers(w.supabase, {
      organizationId: "o6-owned2",
      contactId: "c1",
      conversationId: "cv1",
      body: "menu",
      isFirstMessageEver: false,
      isCtwa: false,
      campaignButton: null,
    });
    expect(r.started).toBe(false);
    expect(w.ops.some((o) => o.table === "conversations" && o.filters.some(([f]) => f === "not"))).toBe(true);
    expect(w.ops.some((o) => o.table === "flow_runs" && o.kind === "insert")).toBe(false);
  });

  it("status-only payloads don't read markers, opt-out words or the Flows flag", async () => {
    const w = latencyWorld({ org: "o6-status", rttMs: 1, graphMs: 1, waitingRun: false });
    await processWebhookPayload(w.supabase, "ev-status", {
      entry: [{ id: "waba", changes: [{ field: "messages", value: { metadata: { phone_number_id: "pn" }, statuses: [{ id: "wamid.x", status: "delivered", timestamp: "1" }] } }] }],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(w.ops.some((o) => ["lead_source_markers", "opt_out_keywords", "feature_flags"].includes(o.table))).toBe(false);
  });
});

// ------------------------------------------------------- send + post-send
describe("(2) the sender: post-send writes together, timings recorded, result unchanged", () => {
  it("writes the message row and touches the conversation in one round trip; spans recorded", async () => {
    const order: string[] = [];
    const db = fakeDb((op) => {
      order.push(`${op.table}:${op.kind}`);
      if (op.table === "messages") return { data: { id: "m-out" }, error: null };
      return undefined;
    });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ messages: [{ id: "wamid.sent" }] })));
    const { timer, result } = replyTimer(null);
    const r = await sendServiceText(db.supabase, {
      organizationId: "o",
      phoneNumberId: "pn",
      accessToken: "t",
      conversationId: "cv",
      to: "91",
      body: "hello",
      windowOpen: true,
      timer,
    });
    expect(r).toEqual({ ok: true, messageId: "m-out", error: null });
    expect(order).toEqual(["messages:insert", "conversations:update"]);
    expect(db.ops[0]!.payload).toMatchObject({ meta_message_id: "wamid.sent", direction: "outbound", type: "text", body: "hello", status: "pending" });
    const t = result("x", "flow");
    expect(t.marks["send_start"]).toBeTypeOf("number");
    expect(t.ms["send_api"]).toBeTypeOf("number");
    expect(t.ms["post_send"]).toBeTypeOf("number");
  });

  it("unchanged: a refused send is stored as failed with Meta's error", async () => {
    const db = fakeDb((op) => (op.table === "messages" ? { data: { id: "m-f" }, error: null } : undefined));
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: 131047 } }), { status: 400 }));
    const r = await sendServiceText(db.supabase, { organizationId: "o", phoneNumberId: "pn", accessToken: "t", conversationId: "cv", to: "91", body: "x", windowOpen: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("131047");
    expect(db.ops[0]!.payload).toMatchObject({ status: "failed", error_detail: expect.stringContaining("131047") });
  });

  it("unchanged: without the caller's window answer, the window is still read first", async () => {
    const db = fakeDb((op) => (op.table === "conversations" && op.kind === "select" ? { data: { last_customer_message_at: "2020-01-01T00:00:00Z" }, error: null } : undefined));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const r = await sendServiceText(db.supabase, { organizationId: "o", phoneNumberId: "pn", accessToken: "t", conversationId: "cv", to: "91", body: "x" });
    expect(r).toEqual({ ok: false, messageId: null, error: "service_window_closed" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("flags: the AI tools module re-exports the same resolver the flow path uses", () => {
    expect(flagsFromAiTools).toBe(flagsFromModule);
  });
});

// ------------------------------------------------------------------ (3)
describe("(3) Aiden: same gates and burst, less waiting around them", () => {
  it("the gate is read only once the burst wait is over", async () => {
    vi.useFakeTimers();
    try {
      const db = fakeDb(() => ({ data: [], error: null }));
      let calledAt = -1;
      const start = Date.now();
      const p = coalesceBurst(db.supabase, {
        conversationId: "cv",
        messageId: "m1",
        occurredAt: new Date().toISOString(),
        body: "hi",
        storedAt: Date.now() - 1000,
        // The mechanism at a 5 s window (Batch 15A: the default is now 1 s).
        windowMs: 5000,
        afterWait: () => (calledAt = Date.now() - start),
      });
      await vi.advanceTimersByTimeAsync(3999);
      expect(calledAt).toBe(-1);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(calledAt).toBe(4000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the chat's two reads go out together", async () => {
    const w = aidenWorld({ rttMs: RTT });
    // Batch 17: virtual clock — together = exactly one round trip, on any machine.
    const ms = await inVirtualTime(async () => {
      const t = Date.now();
      await conversationTurns(w.supabase, "org", "cv1");
      return Date.now() - t;
    });
    expect(ms).toBeLessThan(2 * RTT);
    expect(w.ops.map((o) => o.table)).toEqual(["conversations", "messages"]);
  });

  async function answer(conversation?: Record<string, unknown>) {
    process.env["LOVABLE_API_KEY"] = "k";
    const w = aidenWorld({ rttMs: 5, ...(conversation ? { conversation } : {}) });
    const graph: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("graph.facebook.com")) graph.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return w.fetchStub(url, init);
    });
    const prepared = prepareAgentInbound(w.supabase, "org-a", "cv1");
    await new Promise((r) => setTimeout(r, 60)); // the burst wait
    const gate = readAgentGate(w.supabase, "cv1");
    const outcome = await runAgentOnInbound(w.supabase, {
      organizationId: "org-a",
      conversationId: "cv1",
      contactId: "c1",
      phoneNumberId: "pn",
      accessToken: "t",
      waId: "9198",
      // Small talk: answerable without tools (this bare workspace brokers none).
      body: "hello",
      alreadyHandled: false,
      optedOut: false,
      prepared,
      gate,
    });
    return { w, graph, outcome };
  }

  it("answers as before, and the reply doesn't re-read the window the gate just checked", async () => {
    const { w, graph, outcome } = await answer();
    expect(outcome).toMatchObject({ acted: true, mode: "replying", sent: true });
    expect(graph).toHaveLength(1);
    expect((graph[0]!["text"] as { body: string }).body).toContain("20-day returns");
    // Gate read + chat's conversation read; no third (window) read before the send.
    const convReads = w.ops.filter((o) => o.table === "conversations" && o.kind === "select");
    expect(convReads).toHaveLength(2);
  });

  it("unchanged: a teammate who took over during the burst still stops the answer", async () => {
    const { graph, outcome } = await answer({ assigned_to: "user-1" });
    expect(outcome).toEqual({ acted: false, reason: "assigned_to_human" });
    expect(graph).toHaveLength(0);
  });

  it("unchanged: a closed window is never answered", async () => {
    const { graph, outcome } = await answer({ last_customer_message_at: "2020-01-01T00:00:00Z" });
    expect(outcome).toEqual({ acted: false, reason: "window_closed" });
    expect(graph).toHaveLength(0);
  });
});
