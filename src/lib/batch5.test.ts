import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { inVirtualTime } from "./test-support/virtual-time";
import {
  acceptWebhook,
  coalesceBurst,
  processWebhookPayload,
  waitUntilOf,
} from "./whatsapp-webhook.server";
import { executeRun, withoutConfirmLine } from "./ai-run.server";
import { sendCampaignTemplate } from "./campaigns.server";
import { templateParamsFromComponents } from "./templates";
import { fillTemplateText, previewText, type ConversationRow } from "@/components/inbox/inbox-utils";

/**
 * Batch 5.
 *  (1) Meta gets its 200 as soon as the event is stored; processing follows.
 *  (2) Fewer round trips before a flow reply; the burst window counts the
 *      work already done; the AI's bookkeeping and check set-up leave the
 *      critical path.
 *  (3) "Let me confirm that for you." only stays on a run that hands over.
 *  (4) Template sends keep their values; the inbox preview shows them.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ------------------------------------------------------------------ (1)
describe("(1) webhook ack: stored, 200, then processed", () => {
  const eventDb = () =>
    fakeDb((op) =>
      op.table === "webhook_events" && op.kind === "insert"
        ? { data: { id: "ev-1", received_at: "2026-09-30T05:21:40Z" }, error: null }
        : undefined,
    );

  it("answers 200 before processing finishes, hands the work to waitUntil", async () => {
    const db = eventDb();
    let finish!: () => void;
    const processing = new Promise<void>((r) => (finish = r));
    const calls: Array<{ eventId: string; receivedAt: string | null }> = [];
    const handed: Array<Promise<unknown>> = [];
    const res = await acceptWebhook(db.supabase, {
      rawBody: JSON.stringify({ entry: [] }),
      signatureValid: true,
      waitUntil: (p) => handed.push(p),
      process: async (_s, eventId, _p, receivedAt) => {
        calls.push({ eventId, receivedAt: receivedAt ?? null });
        await processing;
      },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    // The event row was written before the ack; processing is still running.
    expect(db.ops[0]).toMatchObject({ table: "webhook_events", kind: "insert" });
    expect(calls).toEqual([{ eventId: "ev-1", receivedAt: "2026-09-30T05:21:40Z" }]);
    expect(handed).toHaveLength(1);
    let settled = false;
    void handed[0]!.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await handed[0];
    expect(settled).toBe(true);
  });

  it("a processing failure never reaches Meta (the event records its own error)", async () => {
    const handed: Array<Promise<unknown>> = [];
    const res = await acceptWebhook(eventDb().supabase, {
      rawBody: "{}",
      signatureValid: true,
      waitUntil: (p) => handed.push(p),
      process: async () => {
        throw new Error("boom");
      },
    });
    expect(res.status).toBe(200);
    await expect(handed[0]).resolves.toBeUndefined();
  });

  it("unchanged: without waitUntil (dev, tests) the payload is processed before the 200", async () => {
    const order: string[] = [];
    await acceptWebhook(eventDb().supabase, {
      rawBody: "{}",
      signatureValid: true,
      waitUntil: null,
      process: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push("processed");
      },
    }).then(() => order.push("acked"));
    expect(order).toEqual(["processed", "acked"]);
  });

  // Batch 17 (3): a bad signature is now refused (401) and never stored.
  it("a bad signature is refused with 401, never stored or processed; bad JSON from Meta is kept verbatim", async () => {
    const db = eventDb();
    const process = vi.fn();
    const res = await acceptWebhook(db.supabase, { rawBody: "not json", signatureValid: false, waitUntil: () => {}, process });
    expect(res.status).toBe(401);
    expect(process).not.toHaveBeenCalled();
    expect(db.ops).toEqual([]);
    const signed = eventDb();
    await acceptWebhook(signed.supabase, { rawBody: "not json", signatureValid: true, waitUntil: () => {}, process: async () => {} });
    expect(signed.ops[0]!.payload).toEqual({ provider: "meta", payload: { _unparsable: "not json" }, signature_valid: true });
  });

  it("finds the runtime's waitUntil on the request (nitro) or its cloudflare context", () => {
    const direct = new Request("https://x/") as Request & { waitUntil?: unknown };
    const fn = vi.fn();
    direct.waitUntil = fn;
    expect(waitUntilOf(direct)).toBe(fn);

    const viaCtx = new Request("https://x/") as Request & { runtime?: unknown };
    const ctx = { hits: 0, waitUntil(this: { hits: number }) { this.hits += 1; } };
    viaCtx.runtime = { cloudflare: { context: ctx } };
    waitUntilOf(viaCtx)!(Promise.resolve());
    expect(ctx.hits).toBe(1);

    expect(waitUntilOf(new Request("https://x/"))).toBeNull();
  });

  it("unchanged: Meta redelivering the same message is stored again but never answered twice", async () => {
    const first = latencyWorld({ org: "org-redeliver", rttMs: 1, graphMs: 1, waitingRun: true });
    vi.stubGlobal("fetch", first.fetchStub);
    const TAP = { id: "wamid.tap", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } } };
    await processWebhookPayload(first.supabase, "ev-a", inboundPayload(TAP), null);
    expect(first.graphSends).toHaveLength(1);
    const again = latencyWorld({ org: "org-redeliver", rttMs: 1, graphMs: 1, waitingRun: true, duplicate: true });
    vi.stubGlobal("fetch", again.fetchStub);
    await processWebhookPayload(again.supabase, "ev-b", inboundPayload(TAP), null);
    expect(again.graphSends).toHaveLength(0);
    // processed_at is still written once the pass is done.
    expect(again.ops.at(-1)).toMatchObject({ table: "webhook_events", kind: "update" });
    expect((again.ops.at(-1)!.payload as { processed_at?: string }).processed_at).toBeTruthy();
  });
});

// ------------------------------------------------------------------ (2)
/**
 * Same harness as Batch 4, with the Worker's real limit of six requests in
 * flight. One RTT stands for one database round trip (live: ~0.23 s from the
 * Worker's colo to Mumbai). Before this batch, on this harness:
 *   button tap → reply       10 RTT     keyword → first prompt   12 RTT
 */
const RTT = 40;
const GRAPH = 120;
const TAP = { id: "wamid.tap", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } }, context: { id: "wamid.prompt" } };

async function deliver(org: string, waitingRun: boolean, msg: Record<string, unknown>) {
  const w = latencyWorld({ org, rttMs: RTT, graphMs: GRAPH, waitingRun, maxConcurrent: 6 });
  vi.stubGlobal("fetch", w.fetchStub);
  // Batch 17: on a virtual clock, so "within N round trips" never races a loaded machine.
  await inVirtualTime(async () => {
    w.t0.at = Date.now();
    await processWebhookPayload(w.supabase, `ev-${org}`, inboundPayload(msg), new Date().toISOString());
  });
  return w;
}
const idx = (ops: FakeOp[], pred: (o: FakeOp) => boolean) => ops.findIndex(pred);

describe("(2) flow replies: fewer round trips before the send", () => {
  it("warm-up (module loading is not part of any budget)", async () => {
    await deliver("org5-warm", true, TAP);
  });

  it("a button tap's send starts within 8 round trips (was 10)", async () => {
    const w = await deliver("org5-tap", true, TAP);
    expect(w.graphSends).toHaveLength(1);
    expect(w.graphSends[0]!.at).toBeLessThan(8 * RTT);
  });

  it("a keyword that starts a flow starts sending its first prompt within 10 round trips (was 12)", async () => {
    const w = await deliver("org5-kw", false, { id: "wamid.kw", type: "text", text: { body: "menu" } });
    expect(w.graphSends).toHaveLength(1);
    expect(w.graphSends[0]!.at).toBeLessThan(10 * RTT);
  });

  it("the number's token is read once, and the window read by the engine is not read again by the sender", async () => {
    const w = await deliver("org5-once", true, TAP);
    expect(w.ops.filter((o) => o.table === "whatsapp_credentials")).toHaveLength(1);
    const windowReads = w.ops.filter(
      (o) => o.table === "conversations" && o.kind === "select" && o.filters.some(([f, a]) => f === "eq" && a[0] === "id"),
    );
    // Batch 6: the message just written opened the window, so the engine
    // doesn't read the conversation at all (was one read).
    expect(windowReads).toHaveLength(0);
    // Tags come with the contact; the flow's number isn't read when the conversation has one.
    expect(w.ops.some((o) => o.table === "contact_tags")).toBe(false);
    expect(w.ops.some((o) => o.table === "flows")).toBe(false);
  });

  it("bookkeeping starts after the reply, and still lands before processed_at", async () => {
    const w = await deliver("org5-books", true, TAP);
    const outbound = idx(w.ops, (o) => o.table === "messages" && o.kind === "insert");
    const processed = idx(w.ops, (o) => o.table === "webhook_events" && o.kind === "update");
    const received = idx(w.ops, (o) => o.table === "analytics_events" && (o.payload as { event_type?: string }).event_type === "message.received");
    const campaignReply = idx(w.ops, (o) => o.table === "campaign_recipients");
    expect(outbound).toBeGreaterThan(-1);
    expect(received).toBeGreaterThan(outbound);
    expect(campaignReply).toBeGreaterThan(outbound);
    expect(processed).toBe(w.ops.length - 1);
  });

  it("unchanged: the 24-hour window write lands before anything is sent", async () => {
    const w = await deliver("org5-window", true, TAP);
    const windowWrite = idx(w.ops, (o) => o.table === "conversations" && o.kind === "update" && "last_customer_message_at" in (o.payload as object));
    expect(windowWrite).toBeGreaterThan(-1);
    expect(windowWrite).toBeLessThan(idx(w.ops, (o) => o.table === "messages" && o.kind === "insert"));
  });

  it("unchanged: STOP still opts out and the waiting flow never takes it", async () => {
    const w = await deliver("org5-stop", true, { id: "wamid.stop", type: "text", text: { body: "STOP" } });
    expect(w.ops.some((o) => o.table === "flow_runs" && o.kind === "update" && (o.payload as { status?: string }).status === "running")).toBe(false);
    expect(w.ops.find((o) => o.table === "contacts" && o.kind === "update")?.payload).toMatchObject({ opt_in_status: "opted_out" });
  });

  it("unchanged: a sender with no window read of its own still checks the window", async () => {
    const { sendServiceText } = await import("./service-text.server");
    const db = fakeDb((op) => (op.table === "conversations" ? { data: { last_customer_message_at: "2020-01-01T00:00:00Z" }, error: null } : undefined));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await sendServiceText(db.supabase, { organizationId: "o", phoneNumberId: "pn", accessToken: "t", conversationId: "cv", to: "91", body: "hi" });
    expect(res.error).toBe("service_window_closed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("(2) burst window: counted from when the message was stored", () => {
  const burstDb = (rows: Array<{ id: string; direction: string; body: string }>) =>
    fakeDb((op) => (op.table === "messages" ? { data: rows, error: null } : undefined));
  // The mechanism at a 5 s window (Batch 15A: the default is now 1 s, a platform setting).
  const args = { conversationId: "cv", messageId: "m2", occurredAt: new Date().toISOString(), body: "under 2000?", windowMs: 5000 };

  it("3 s already spent since storing → waits the remaining 2 s, not 5", async () => {
    vi.useFakeTimers();
    const db = burstDb([{ id: "m2", direction: "inbound", body: "under 2000?" }]);
    const out = coalesceBurst(db.supabase, { ...args, storedAt: Date.now() - 3000 });
    await vi.advanceTimersByTimeAsync(1990);
    expect(db.ops).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(await out).toEqual({ proceed: true, body: "under 2000?" });
    expect(db.ops).toHaveLength(1);
  });

  it("the window already over → no wait at all", async () => {
    vi.useFakeTimers();
    const db = burstDb([]);
    const out = coalesceBurst(db.supabase, { ...args, storedAt: Date.now() - 6000 });
    await vi.advanceTimersByTimeAsync(0);
    await out;
    expect(db.ops).toHaveLength(1);
  });

  it("unchanged: without a stored time the full window (5 s here) is waited", async () => {
    vi.useFakeTimers();
    const db = burstDb([]);
    const out = coalesceBurst(db.supabase, args);
    await vi.advanceTimersByTimeAsync(4990);
    expect(db.ops).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(20);
    await out;
    expect(db.ops).toHaveLength(1);
  });

  it("unchanged: the last text answers for the burst; an overtaken one stands down", async () => {
    vi.useFakeTimers();
    const rows = [
      { id: "m1", direction: "inbound", body: "silver rings" },
      { id: "m2", direction: "inbound", body: "under 2000?" },
    ];
    const last = coalesceBurst(burstDb(rows).supabase, { ...args, storedAt: Date.now() - 1000 });
    const first = coalesceBurst(burstDb(rows).supabase, { ...args, messageId: "m1", body: "silver rings", storedAt: Date.now() - 1000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await last).toEqual({ proceed: true, body: "silver rings\nunder 2000?" });
    expect(await first).toEqual({ proceed: false, body: null });
  });
});

// ------------------------------------------------------- AI run (2) + (3)
type Chat = { messages: Array<{ role: string; content: unknown }> };

function aiDb(chunks: string[]) {
  return fakeDb(
    (op: FakeOp) => {
      if (op.table === "organization_ai_settings")
        return { data: { ai_enabled: true, ai_monthly_cap_amount: 1000, currency: "INR", ai_markup_multiplier: 3 }, error: null };
      if (op.table === "platform_settings") return { data: { ai_monthly_cap_amount: 100000, ai_cap_currency: "INR", ai_markup_multiplier: 3 }, error: null };
      if (op.table === "ai_runs" && op.kind === "insert") return { data: { id: "run-1" }, error: null };
      if (op.table === "ai_tiers")
        return { data: { key: "everyday", display_name: "Everyday", provider: "lovable", model_id: "google/gemini-3.6-flash", is_active: true }, error: null };
      if (op.table === "ai_models") return { data: { supports_tools: true, is_available: true, is_deprecated: false }, error: null };
      return undefined;
    },
    (call) => {
      if (call.name === "match_knowledge_chunks")
        return {
          data: chunks.map((text, i) => ({ document_id: `d${i}`, source_type: "website", source_name: "site", source_ref: "https://myzoori.com/", title: `page ${i + 1}`, text, similarity: 0.5 })),
          error: null,
        };
      if (call.name === "ai_month_spend" || call.name === "platform_ai_month_spend") return { data: 0, error: null };
      return undefined;
    },
  );
}

/** The model answers `answer`; the policy check says "no" to sentences matching `reject`. */
function stubModel(answer: string, onAnswer?: () => void, reject?: RegExp) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/embeddings")) return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    const body = JSON.parse(String(init.body)) as Chat;
    if (String(body.messages[0]?.content ?? "").startsWith("You check whether sentences")) {
      const lines = String(body.messages.at(-1)?.content).match(/^\d+\. .*$/gm) ?? [];
      const answers = lines.map((l) => (reject && reject.test(l) ? "no" : "yes"));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers }) } }] }));
    }
    onAnswer?.();
    return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }));
  });
}

const ask = (db: ReturnType<typeof aiDb>, input: string, extra: Record<string, unknown> = {}) =>
  executeRun(db.supabase, {
    organizationId: "org",
    task: "agent_reply",
    tier: "everyday",
    conversationId: "conv-1",
    contactId: "c1",
    input,
    system: "You answer on behalf of this business.",
    useKnowledge: true,
    useTools: false,
    ...extra,
  });

const RETURNS = "We offer 20-day returns, no questions asked. Opened or used products can’t be returned, except in extreme cases like damaged, incorrect, or missing items after verification.";

describe("(2) the answer's bookkeeping and the policy check's set-up leave the critical path", () => {
  beforeEach(() => {
    process.env["LOVABLE_API_KEY"] = "test-key";
  });

  it("the policy check's reads start while the answer is being written, and are not repeated", async () => {
    const db = aiDb([RETURNS]);
    stubModel(`${RETURNS} If you want, I can also share the refund/cancellation details.\n{"needs_owner": false}`, undefined, /If you want/);
    await ask(db, "What is your return policy?");
    // The check's own brain was read before the answer came back (its price
    // is the first read after the model), and never read a second time.
    const tiers = db.ops.map((o, i) => [o, i] as const).filter(([o]) => o.table === "ai_tiers");
    const firstAfterModel = db.ops.findIndex((o) => o.table === "ai_rates");
    expect(tiers).toHaveLength(2);
    expect(firstAfterModel).toBeGreaterThan(-1);
    expect(tiers[1]![1]).toBeLessThan(firstAfterModel);
    // Every run is still recorded: the answer, the check and (Batch 16) the
    // one rewrite attempt for the unsupported sentence.
    expect(db.ops.filter((o) => o.table === "ai_runs" && o.kind === "insert")).toHaveLength(3);
  });

  it("with deferUsage the daily roll-up is handed over (one per run), not awaited before returning", async () => {
    const db = aiDb([RETURNS]);
    stubModel(`${RETURNS}\n{"needs_owner": false}`);
    const handed: Array<Promise<unknown>> = [];
    const out = await ask(db, "What is your return policy?", { deferUsage: (p: Promise<unknown>) => handed.push(p) });
    expect(out.status).toBe("ok");
    expect(handed).toHaveLength(1);
    await Promise.all(handed);
    // Batch 18: one ai_usage_add call (the row write as before only if that call fails).
    expect(db.ops.some((o) => o.table === "ai_usage" && o.kind === "insert") || db.rpcs.some((r) => r.name === "ai_usage_add")).toBe(true);
  });

  it("unchanged: without deferUsage the roll-up is written before the run returns", async () => {
    const db = aiDb([RETURNS]);
    stubModel(`${RETURNS}\n{"needs_owner": false}`);
    await ask(db, "What is your return policy?");
    // Batch 18: one ai_usage_add call (the row write as before only if that call fails).
    expect(db.ops.some((o) => o.table === "ai_usage" && o.kind === "insert") || db.rpcs.some((r) => r.name === "ai_usage_add")).toBe(true);
  });
});

describe("(3) 'Let me confirm that for you.' only on a run that hands over", () => {
  beforeEach(() => {
    process.env["LOVABLE_API_KEY"] = "test-key";
  });

  it("the live return-policy answer: the stripped offer goes, and so does the confirm line (still filed)", async () => {
    stubModel(`${RETURNS} If you want, I can also share the refund/cancellation details.\n{"needs_owner": false}`, undefined, /If you want/);
    const out = await ask(aiDb([RETURNS]), "What is your return policy?");
    expect(out.output).toBe(RETURNS);
    expect(out.status).toBe("ok");
    expect(out.needsOwner).toBe(true);
  });

  it("the live rings answer: a grounded reply the model ended with the line goes out without it", async () => {
    stubModel('I don’t have rings under ₹2000 right now — our rings start at ₹16,805. Want to see these?\n\nLet me confirm that for you.\n{"needs_owner": false}');
    const out = await ask(aiDb(["Rings from ₹16,805. Silver and gold."]), "Do you have silver rings under 2000?");
    expect(out.output).toBe("I don’t have rings under ₹2000 right now — our rings start at ₹16,805. Want to see these?");
    expect(out.status).toBe("ok");
  });

  it("a run that hands over keeps the line", async () => {
    stubModel('Refunds usually take a few days.\n\nLet me confirm that for you.\n{"needs_owner": true}');
    const out = await ask(aiDb(["Returns within 20 days."]), "I want a refund for my ring");
    expect(out.status).toBe("escalated");
    expect(out.escalationSignal).toBe("sensitive_topic");
    expect(out.output).toMatch(/Let me confirm that for you\.$/);
  });

  it("a reply that is nothing but the promise is filed for the merchant, never a hand-off (Batch 16)", async () => {
    stubModel('Let me confirm that for you.\n{"needs_owner": true}');
    const out = await ask(aiDb(["Petal Band — handcrafted ring."]), "is the petal band in stock?");
    expect(out.status).toBe("ok");
    expect(out.escalationSignal ?? null).toBeNull();
    expect(out.needsOwner).toBe(true);
    expect(out.output).toBe("Let me confirm that for you.");
  });

  it("unchanged: an answer without the line is untouched", async () => {
    stubModel(`${RETURNS}\n{"needs_owner": false}`);
    const out = await ask(aiDb([RETURNS]), "What is your return policy?");
    expect(out.output).toBe(RETURNS);
    expect(out.needsOwner).toBe(false);
  });

  it("withoutConfirmLine drops every 'let me confirm' sentence and keeps the rest and its lines", () => {
    expect(withoutConfirmLine("Rings start at ₹16,805.\n\nLet me confirm that for you.")).toBe("Rings start at ₹16,805.");
    expect(withoutConfirmLine("Rings start at ₹16,805. Delivery time — let me confirm that for you.\nWant to see them?")).toBe(
      "Rings start at ₹16,805.\nWant to see them?",
    );
    expect(withoutConfirmLine("Let me confirm that for you.")).toBe("");
    expect(withoutConfirmLine("Hi!\n\nWe ship across India.")).toBe("Hi!\n\nWe ship across India.");
  });
});

// ------------------------------------------------------------------ (4)
describe("(4) template sends keep their values; the inbox preview shows them", () => {
  const BODY = "Hi {{1}}, Aiden here from AiDwar. We stopped at {{2}}. Reply here to continue, or say 'help'.";

  it("sendCampaignTemplate stores the values it sent with on the message row", async () => {
    const db = fakeDb((op) => {
      if (op.table === "conversations" && op.kind === "select") return { data: { id: "cv1" }, error: null };
      if (op.table === "messages" && op.kind === "insert") return { data: { id: "m1" }, error: null };
      return undefined;
    });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ messages: [{ id: "wamid.t" }] }), { status: 200 }));
    const out = await sendCampaignTemplate(
      db.supabase,
      "org",
      { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "tok" },
      { contactId: "c1", phone: "+919800000001", variables: { "1": "Vinay", "2": "your website link" } },
      { name: "aidwar_onboarding_resume", language: "en_US", variableOrder: [1, 2], components: [{ type: "BODY", text: BODY }] as never },
      { campaignId: null, category: "utility" },
    );
    expect(out).toEqual({ messageId: "m1", error: null });
    const row = db.ops.find((o) => o.table === "messages" && o.kind === "insert")!.payload as Record<string, unknown>;
    expect(row["metadata"]).toEqual({ template_params: { "1": "Vinay", "2": "your website link" } });
    expect(row["template_name"]).toBe("aidwar_onboarding_resume");
  });

  it("the preview fills the template's text with those values", () => {
    expect(fillTemplateText(BODY, { template_params: { "1": "Vinay", "2": "your website link" } })).toBe(
      "Hi Vinay, Aiden here from AiDwar. We stopped at your website link. Reply here to continue, or say 'help'.",
    );
  });

  it("an older send with no stored values shows no raw {{1}}: sample values, else '...' (Batch 11, item 8)", () => {
    // Batch 11 (8): sent before Batch 5 stored the values — placeholders are
    // never shown raw any more.
    expect(fillTemplateText(BODY, null)).toBe("Hi ..., Aiden here from AiDwar. We stopped at .... Reply here to continue, or say 'help'.");
    expect(fillTemplateText(BODY, null, { "1": "Priya", "2": "your number" })).toBe(
      "Hi Priya, Aiden here from AiDwar. We stopped at your number. Reply here to continue, or say 'help'.",
    );
    // Unchanged: a send with stored values keeps a missing one as written.
    expect(fillTemplateText(BODY, { template_params: { "1": "Vinay" } })).toBe(
      "Hi Vinay, Aiden here from AiDwar. We stopped at {{2}}. Reply here to continue, or say 'help'.",
    );
  });

  it("an inbox send's values are read from its components (positional and named)", () => {
    expect(
      templateParamsFromComponents([
        { type: "header", parameters: [{ type: "image", image: { link: "x" } }] },
        { type: "body", parameters: [{ type: "text", text: "Vinay" }, { type: "text", text: "#1042" }] },
      ]),
    ).toEqual({ "1": "Vinay", "2": "#1042" });
    expect(templateParamsFromComponents([{ type: "body", parameters: [{ type: "text", parameter_name: "name", text: "Asha" }] }])).toEqual({ name: "Asha" });
    expect(templateParamsFromComponents([])).toEqual({});
  });

  it("unchanged: a text preview and a nameless template preview read as before", () => {
    const row = (preview: ConversationRow["preview"]) => ({ preview }) as ConversationRow;
    expect(previewText(row({ body: "hello", type: "text", direction: "inbound" }))).toBe("hello");
    expect(previewText(row({ body: null, type: "template", direction: "outbound", template_name: "order_update" }))).toBe("Template: order update");
  });
});

// ------------------------------------------------------------------ Batch 16 item 4
describe("Batch 16 item 4: an unsupported policy claim is rewritten once, not cut", () => {
  const SOURCE = "Returns: we accept returns within 7 days of delivery for unused items with tags.";
  // Live (Zoori): the claim went and the reply began "Lekin…". (The number
  // guard handles a day count on its own, so the claim here has none.)
  const ANSWER = "Haan ji, no-questions-asked returns hai. Lekin item unused hona chahiye with tags.";

  function stub(rewrite: (parts: string[]) => string | null) {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/embeddings")) return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
      const body = JSON.parse(String(init.body)) as Chat;
      const system = String(body.messages[0]?.content ?? "");
      const user = String(body.messages.at(-1)?.content ?? "");
      if (system.startsWith("You check whether sentences")) {
        seen.push("check");
        const lines = user.match(/^\d+\. .*$/gm) ?? [];
        const answers = lines.map((l) => (/no-questions|lifetime/i.test(l) ? "no" : "yes"));
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers }) } }] }));
      }
      if (system.startsWith("You edit a shop assistant")) {
        seen.push("rewrite");
        const parts = JSON.parse(user.slice(user.indexOf("REPLY PARTS:\n") + "REPLY PARTS:\n".length)) as string[];
        const out = rewrite(parts);
        return new Response(JSON.stringify({ choices: [{ message: { content: out ?? "sorry" } }] }));
      }
      seen.push("answer");
      return new Response(JSON.stringify({ choices: [{ message: { content: `${ANSWER}\n{"needs_owner": false}` } }] }));
    });
    return seen;
  }
  const meta = (db: ReturnType<typeof aiDb>) =>
    db.ops
      .filter((o) => o.table === "ai_runs" && o.kind === "insert")
      .map((o) => (o.payload as { metadata?: Record<string, unknown> }).metadata ?? {})
      .find((m) => !m["purpose"])!;

  beforeEach(() => {
    process.env["LOVABLE_API_KEY"] = "test-key";
  });

  it("the model's rewrite (no unsupported claim) goes out instead of a cut reply; recorded on the run", async () => {
    const db = aiDb([SOURCE]);
    const seen = stub(() => JSON.stringify({ parts: ["Returns 7 din ke andar ho jaate hain, item unused hona chahiye with tags."] }));
    const out = await ask(db, "return policy kya hai?");
    // The wording check alone found the claim; the rewrite is then checked again.
    expect(seen).toEqual(["answer", "rewrite", "check"]);
    expect(out.output).toBe("Returns 7 din ke andar ho jaate hain, item unused hona chahiye with tags.");
    expect(out.output).not.toMatch(/^Lekin/);
    expect(meta(db)["policy_rewrite"]).toEqual({ outcome: "rewritten", claims: ["Haan ji, no-questions-asked returns hai."] });
  });

  it("the rewrite still makes an unsupported claim: today's stripping applies", async () => {
    const db = aiDb([SOURCE]);
    stub(() => JSON.stringify({ parts: ["Returns no-questions hote hain, lifetime exchange bhi."] }));
    const out = await ask(db, "return policy kya hai?");
    // Today's behaviour (the live fault): the claim is cut, the reply begins "Lekin…".
    expect(out.output).toBe("Lekin item unused hona chahiye with tags.");
    expect((meta(db)["policy_rewrite"] as { outcome: string }).outcome).toBe("still_unsupported");
  });

  it("the rewrite adds a number the material never states: today's stripping applies", async () => {
    const db = aiDb([SOURCE]);
    stub(() => JSON.stringify({ parts: ["Returns ke liye ₹200 fee lagti hai, item unused ho."] }));
    const out = await ask(db, "return policy kya hai?");
    expect(out.output).not.toMatch(/₹200/);
    expect((meta(db)["policy_rewrite"] as { outcome: string }).outcome).toBe("still_unsupported");
  });

  it("the rewrite call fails (no JSON): today's stripping applies", async () => {
    const db = aiDb([SOURCE]);
    stub(() => null);
    const out = await ask(db, "return policy kya hai?");
    // Today's behaviour (the live fault): the claim is cut, the reply begins "Lekin…".
    expect(out.output).toBe("Lekin item unused hona chahiye with tags.");
    expect((meta(db)["policy_rewrite"] as { outcome: string }).outcome).toBe("failed");
  });
});
