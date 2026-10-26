import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { pgAvailable, startScratchPg, type ScratchPg } from "./test-support/scratch-pg";
import type { FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import {
  processWebhookPayload,
  reprocessUnprocessedEvents,
  resetBurstWindowCache,
} from "./whatsapp-webhook.server";
import { inputOf, LONG_CASE, LONG_SHOP } from "./test-support/context-fixture";
import { CASES, zooriWorld, type Case, type ReplayShop } from "./test-support/zoori-replay";

vi.mock("@/lib/feature-flags.server", async (orig) => ({
  ...(await orig<typeof import("./feature-flags.server")>()),
  enabledFlags: async () => new Set(["ai_features", "catalogs", "flows_v2"]),
}));

/**
 * Batch 29 — reply speed.
 *  (1) a reply is produced in the webhook's own request every time: the
 *      reply Aiden is still sending to the customer's PREVIOUS message no
 *      longer makes this one "already handled"; safety-net pickups are logged.
 *  (2) the burst wait is adaptive (quiet gap, hard cap) from platform_settings.
 *  (3) less input per reply: top-k material in a budget, recent turns + a
 *      short summary, a stable system block first.
 *  (4) retrieval and the cheap checks run together.
 *  (5) received_to_send_ms on every reply (webhook timing + ai_runs), and the
 *      /admin/ai Reply speed card from one SQL aggregate.
 */

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Outbound = { created_at: string; sent_by: string | null };

/**
 * Aiden replies in this workspace, nobody owns the chat, no flow takes the
 * message. `outbound` are the conversation's outbound rows as the database
 * would hold them while this message is processed; the "did anything reply?"
 * count is answered from them with the query's own filters.
 */
function aidenWorld(opts: { outbound?: () => Outbound[]; automation?: boolean } = {}) {
  const gateReads: number[] = [];
  const w = latencyWorld({
    org: `o29-${Math.random()}`,
    rttMs: 0,
    graphMs: 0,
    waitingRun: false,
    override: (op: FakeOp) => {
      if (op.table === "platform_settings")
        return {
          data: {
            ai_burst_quiet_ms: 0,
            ai_burst_cap_ms: 0,
            ai_monthly_cap_amount: 100000,
            ai_cap_currency: "INR",
            ai_markup_multiplier: 3,
          },
          error: null,
        };
      if (op.table === "organization_ai_settings")
        return {
          data: {
            ai_enabled: true,
            ai_monthly_cap_amount: 1000,
            currency: "INR",
            ai_markup_multiplier: 3,
          },
          error: null,
        };
      if (op.table === "ai_tiers")
        return {
          data: {
            key: "careful",
            display_name: "Careful",
            provider: "lovable",
            model_id: "google/gemini-3.6-flash",
            is_active: true,
          },
          error: null,
        };
      if (op.table === "ai_models")
        return {
          data: { supports_tools: true, is_available: true, is_deprecated: false },
          error: null,
        };
      if (op.table === "feature_flags")
        return {
          data: [
            { key: "flows_v2", default_enabled: true },
            { key: "ai_features", default_enabled: true },
          ],
          error: null,
        };
      if (op.table === "ai_agents")
        return { data: { id: "agent-1", mode: "replying" }, error: null };
      if (op.table === "automations")
        return opts.automation
          ? {
              data: [
                {
                  id: "auto-1",
                  is_active: true,
                  priority: 1,
                  created_at: "2026-01-01T00:00:00Z",
                  trigger_type: "keyword",
                  config: { keywords: ["price"], match: "contains" },
                  message_body: "Our price list: see the website.",
                },
              ],
              error: null,
            }
          : { data: [], error: null };
      if (op.table === "automation_runs" && op.kind !== "select")
        return { data: [{ id: "run" }], error: null };
      if (
        op.table === "messages" &&
        op.kind === "select" &&
        (op.select?.[1] as { head?: boolean } | undefined)?.head
      ) {
        const since = op.filters.find(
          ([n, a]) => n === "gte" && a[0] === "created_at",
        )?.[1][1] as string;
        const onlyPeople = op.filters.some(
          ([n, a]) => n === "not" && a[0] === "sent_by" && a[1] === "is" && a[2] === null,
        );
        const rows = (opts.outbound?.() ?? []).filter(
          (r) => r.created_at >= since && (!onlyPeople || r.sent_by !== null),
        );
        return { data: null, error: null, count: rows.length } as never;
      }
      if (op.table === "conversations" && op.kind === "select") {
        const columns = String(op.select?.[0] ?? "");
        if (columns.startsWith("assigned_to, needs_human")) gateReads.push(Date.now());
        return {
          data: {
            id: "cv1",
            contact_id: "c1",
            unread_count: 0,
            assigned_to: null,
            needs_human: false,
            last_customer_message_at: new Date().toISOString(),
            whatsapp_account_id: "acc",
            contacts: { phone: "+919800000001" },
          },
          error: null,
        };
      }
      return undefined;
    },
  });
  // The answer model says one line; WhatsApp and embeddings as the world answers them.
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("graph.facebook.com") || u.endsWith("/embeddings"))
      return w.fetchStub(url, init);
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: 'Hello! How can I help?\n{"needs_owner": false}',
            },
          },
        ],
      }),
    );
  });
  process.env["LOVABLE_API_KEY"] = "test-key";
  return { ...w, gateReads };
}
const replies = (w: { graphSends: Array<{ body: Record<string, unknown> }> }) =>
  w.graphSends.map((g) => (g.body["text"] as { body?: string } | undefined)?.body);

const timingOf = (ops: FakeOp[]) => {
  const close = ops.filter((o) => o.table === "webhook_events" && o.kind === "update").at(-1);
  return (
    close?.payload as
      { timing?: { messages: Array<Record<string, unknown>>; pickup?: unknown } } | undefined
  )?.timing;
};

describe("(1) the reply is produced in the webhook's own request — every time", () => {
  it("Aiden's reply to the customer's previous message, landing while this one is processed, no longer makes it 'already handled'", async () => {
    resetBurstWindowCache();
    // Live, 7 Oct 05:12: the customer typed "Rs 50k-1L" while the reply to
    // their earlier message was still going out. That reply's row was written
    // after this message's pass began, so the old count ("any outbound since")
    // called this message answered: route "ai", ai_done ~0 ms, no run, no reply.
    const w = aidenWorld({
      outbound: () => [{ created_at: new Date(Date.now() + 60_000).toISOString(), sent_by: null }],
    });
    await processWebhookPayload(
      w.supabase,
      "ev-29a",
      inboundPayload({ id: "wamid.b", type: "text", text: { body: "Rs 50k-1L" } }),
      new Date().toISOString(),
      {
        storeMs: 1,
      },
    );
    const m = timingOf(w.ops)!.messages[0]!;
    expect(m["route"]).toBe("ai");
    expect(m["ai_outcome"]).not.toBe("already_handled");
    // Aiden's own gate was read and the reply went out — in this same request.
    expect(w.gateReads.length).toBeGreaterThan(0);
    expect(m["ai_outcome"]).toBe("replying:ok:sent");
    expect(replies(w)).toEqual(["Hello! How can I help?"]);
    expect(m["received_to_send_ms"]).toBeTypeOf("number");
  });

  it("unchanged: a teammate's reply from the Inbox (sent_by) still stands Aiden down", async () => {
    resetBurstWindowCache();
    const w = aidenWorld({
      outbound: () => [
        { created_at: new Date(Date.now() + 60_000).toISOString(), sent_by: "user-1" },
      ],
    });
    await processWebhookPayload(
      w.supabase,
      "ev-29b",
      inboundPayload({ id: "wamid.c", type: "text", text: { body: "hello?" } }),
      new Date().toISOString(),
      {
        storeMs: 1,
      },
    );
    expect(timingOf(w.ops)!.messages[0]!["ai_outcome"]).toBe("already_handled");
  });

  it("unchanged: an automation that answered this message stands Aiden down (it says so itself, no count needed)", async () => {
    resetBurstWindowCache();
    const w = aidenWorld({ automation: true });
    await processWebhookPayload(
      w.supabase,
      "ev-29c",
      inboundPayload({ id: "wamid.d", type: "text", text: { body: "price?" } }),
      new Date().toISOString(),
      {
        storeMs: 1,
      },
    );
    expect(
      w.graphSends.map((s) => (s.body["text"] as { body?: string } | undefined)?.body),
    ).toContain("Our price list: see the website.");
    expect(timingOf(w.ops)!.messages[0]!["ai_outcome"]).toBe("already_handled");
  });

  it("a safety-net catch-up pickup is logged with its reason and delay, and kept on the event's timing", async () => {
    resetBurstWindowCache();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const receivedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    const event = {
      id: "ev-29d",
      payload: inboundPayload({ id: "wamid.e", type: "text", text: { body: "hi" } }),
      received_at: receivedAt,
      lease_until: null,
      error: "retry:1 1 failed: x",
    };
    const w = aidenWorld();
    const base = w.supabase;
    const supabase = {
      ...base,
      from: (t: string) => {
        if (t !== "webhook_events") return base.from(t);
        const b = base.from(t) as unknown as Record<string, unknown>;
        const thenOrig = b["then"] as (
          r: (v: unknown) => unknown,
          j: (e: unknown) => unknown,
        ) => unknown;
        let kind = "select";
        for (const k of ["update", "insert"]) {
          const orig = b[k] as (p: unknown) => unknown;
          b[k] = (p: unknown) => {
            kind = k;
            return orig(p);
          };
        }
        b["then"] = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) =>
          kind === "select"
            ? Promise.resolve({ data: [event], error: null }).then(r, j)
            : kind === "update"
              ? Promise.resolve({ data: [{ id: event.id }], error: null }).then(r, j)
              : thenOrig(r, j);
        return b;
      },
    } as typeof base;
    await reprocessUnprocessedEvents(supabase, { olderThanSeconds: 60 });
    const line = warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"reply_pickup"'));
    expect(line).toBeTruthy();
    const logged = JSON.parse(line!) as Record<string, unknown>;
    expect(logged).toMatchObject({
      scope: "reply_pickup",
      via: "catch_up",
      reason: "retry_after_failure",
      event_id: "ev-29d",
    });
    expect(Number(logged["delay_ms"])).toBeGreaterThanOrEqual(5 * 60_000 - 1000);
    warn.mockRestore();
  });

  it("the sweeps stay a safety net only: the cron still runs every 5 minutes and catch-up still waits for the re-answer window", async () => {
    const { CATCH_UP_MESSAGES_AFTER_MS, REANSWER_AFTER_MS } =
      await import("./whatsapp-webhook.server");
    expect(CATCH_UP_MESSAGES_AFTER_MS).toBe(REANSWER_AFTER_MS + 30_000);
    const src = readFileSync("src/lib/whatsapp-webhook.server.ts", "utf8");
    // The reply's own path never counts other messages' replies again.
    expect(src).not.toMatch(
      /\.eq\("direction", "outbound"\)\s*\.gte\("created_at", beforeAutomations\)/,
    );
  });
});

describe("(2) the burst wait is adaptive: answer after 1.5 s of quiet, never more than 3 s", () => {
  const rowsDb = (
    rows: Array<{ id: string; direction: string; body: string; created_at: string }>,
  ) => {
    let reads = 0;
    const db = latencyWorld({
      org: "o29-burst",
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) =>
        op.table === "messages" ? (reads++, { data: rows, error: null }) : undefined,
    });
    return { ...db, reads: () => reads };
  };
  // WhatsApp's own times are whole seconds.
  const second = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();

  async function waitOf(run: (afterWait: () => void) => Promise<unknown>): Promise<number> {
    vi.useFakeTimers();
    let at = -1;
    const start = Date.now();
    const out = run(() => (at = Date.now() - start));
    await vi.advanceTimersByTimeAsync(5000);
    await out;
    return at;
  }

  it("a message alone: answered once the customer has been quiet for 1.5 s (the default) — not the 3 s cap, not the old ~4.7 s", async () => {
    const { coalesceBurst, DEFAULT_BURST_QUIET_MS, DEFAULT_BURST_CAP_MS } =
      await import("./whatsapp-webhook.server");
    expect([DEFAULT_BURST_QUIET_MS, DEFAULT_BURST_CAP_MS]).toEqual([1500, 3000]);
    const now = Date.now();
    const db = rowsDb([
      {
        id: "m0",
        direction: "outbound",
        body: "Hi! How can I help?",
        created_at: second(now - 60_000),
      },
      { id: "m1", direction: "inbound", body: "rings under 50k?", created_at: second(now) },
    ]);
    const waited = await waitOf((afterWait) =>
      coalesceBurst(db.supabase, {
        conversationId: "cv",
        messageId: "m1",
        occurredAt: second(now),
        body: "rings under 50k?",
        storedAt: now,
        afterWait,
      }),
    );
    // (±a millisecond: the test's clock read and the wait's own)
    expect(waited).toBeGreaterThanOrEqual(1495);
    expect(waited).toBeLessThanOrEqual(1500);
  });

  it("a message late in a burst: the 3 s cap since the burst's first text cuts the wait (here to 1 s)", async () => {
    const { coalesceBurst } = await import("./whatsapp-webhook.server");
    const now = Date.now();
    const db = rowsDb([
      { id: "m1", direction: "inbound", body: "hi", created_at: second(now - 2000) },
      { id: "m2", direction: "inbound", body: "show me rings", created_at: second(now) },
    ]);
    let result: { proceed: boolean; body: string | null } | null = null;
    const waited = await waitOf(async (afterWait) => {
      result = await coalesceBurst(db.supabase, {
        conversationId: "cv",
        messageId: "m2",
        occurredAt: second(now),
        body: "show me rings",
        storedAt: now,
        afterWait,
      });
    });
    expect(waited).toBeGreaterThanOrEqual(995);
    expect(waited).toBeLessThanOrEqual(1000);
    // One answer for the burst, from the newest text.
    expect(result).toMatchObject({ proceed: true, body: "hi\nshow me rings" });
  });

  it("a customer still typing past the cap: no further wait at all", async () => {
    const { coalesceBurst } = await import("./whatsapp-webhook.server");
    const now = Date.now();
    const db = rowsDb([
      { id: "m1", direction: "inbound", body: "hello", created_at: second(now - 4000) },
      { id: "m2", direction: "inbound", body: "i want", created_at: second(now - 3000) },
      { id: "m3", direction: "inbound", body: "a ring", created_at: second(now - 2000) },
      { id: "m4", direction: "inbound", body: "for my wife", created_at: second(now - 1000) },
      { id: "m5", direction: "inbound", body: "under 1L", created_at: second(now) },
    ]);
    const waited = await waitOf((afterWait) =>
      coalesceBurst(db.supabase, {
        conversationId: "cv",
        messageId: "m5",
        occurredAt: second(now),
        body: "under 1L",
        storedAt: now,
        afterWait,
      }),
    );
    expect(waited).toBe(0);
  });

  it("an earlier text overtaken by a newer one stands down (one reply per burst, unchanged)", async () => {
    const { coalesceBurst } = await import("./whatsapp-webhook.server");
    const now = Date.now();
    const db = rowsDb([
      { id: "m1", direction: "inbound", body: "hi", created_at: second(now) },
      { id: "m2", direction: "inbound", body: "show me rings", created_at: second(now + 1000) },
    ]);
    vi.useFakeTimers();
    const out = coalesceBurst(db.supabase, {
      conversationId: "cv",
      messageId: "m1",
      occurredAt: second(now),
      body: "hi",
      storedAt: now,
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await out).toMatchObject({ proceed: false, body: null });
  });

  it("the values come from platform_settings (quiet / cap), with the defaults when the columns aren't there yet", async () => {
    const { burstSettings, resetBurstWindowCache } = await import("./whatsapp-webhook.server");
    const { fakeDb } = await import("./test-support/fake-db");
    resetBurstWindowCache();
    const missing = fakeDb((op) =>
      op.table === "platform_settings"
        ? { data: null, error: { code: "42703", message: "column does not exist" } }
        : undefined,
    );
    expect(await burstSettings(missing.supabase)).toEqual({ quietMs: 1500, capMs: 3000 });
    resetBurstWindowCache();
    const saved = fakeDb((op) =>
      op.table === "platform_settings"
        ? { data: { ai_burst_quiet_ms: 4000, ai_burst_cap_ms: 2000 }, error: null }
        : undefined,
    );
    // A quiet gap longer than the cap is cut to the cap.
    expect(await burstSettings(saved.supabase)).toEqual({ quietMs: 2000, capMs: 2000 });
    resetBurstWindowCache();
  });

  it("migration 20261090: the two columns, idempotent, checked 0–10000, defaults 1500 / 3000", () => {
    const sql = readFileSync("supabase/aidwar-migrations/20261090_batch29_reply_speed.sql", "utf8");
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ai_burst_quiet_ms integer NOT NULL DEFAULT 1500/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS ai_burst_cap_ms integer NOT NULL DEFAULT 3000/);
    expect(sql).toMatch(/ai_burst_quiet_ms BETWEEN 0 AND 10000/);
    expect(sql).toMatch(/ai_burst_cap_ms BETWEEN 0 AND 10000/);
  });
});

// ------------------------------------------------------------------ (3)
async function replay(c: Case, shop?: ReplayShop) {
  process.env["LOVABLE_API_KEY"] = "test-key";
  const world = zooriWorld(c, shop);
  vi.stubGlobal("fetch", (u: string, i?: RequestInit) => world.fetchStub(String(u), i));
  const { runAgentOnInbound } = await import("./ai-agent.server");
  const outcome = await runAgentOnInbound(
    world.supabase,
    world.args as Parameters<typeof runAgentOnInbound>[1],
  );
  return { outcome, ...world.result() };
}

/**
 * The fixture conversation (test-support/context-fixture.ts: 30 earlier
 * messages, six ~1,700-character website chunks, one catalogue search),
 * measured on the parent commit (92be897, Batch 28) with this same file:
 * 2 model calls, 5,536 + 5,847 = 11,383 input tokens (system 3,788 each).
 * Live (Zoori, 14 days): ~8,564 input tokens per reply.
 */
const BEFORE = { tokens: 11_383, perCall: [5_536, 5_847], systemTokens: 3_788 };

describe("(3) less input per reply, same answer", () => {
  it("the fixture conversation: ≥30% fewer input tokens than before, and the same reply", async () => {
    const r = await replay(LONG_CASE, LONG_SHOP);
    const after = inputOf(r.requests ?? []);
    expect(r.outcome).toMatchObject({ acted: true, status: "ok", sent: true });
    expect(after.calls).toBe(2);
    expect(after.tokens).toBeLessThanOrEqual(Math.round(BEFORE.tokens * 0.7));
    // Measured after (this branch): 3,461 + 3,772 = 7,233 tokens (system 2,240 each) — −36%.
    expect(after.tokens).toBeLessThanOrEqual(7_400);
    // The answer still has the material it needs (the best-matching chunk) and the search.
    expect(r.sent.map((m) => m.text)).toEqual([
      "Rings can be exchanged for another size within 20 days; resizing after that is part of lifelong free maintenance.\nUnder 20k: The Gilded Chevron, Industrial Sparkle/ The Urban Edge.\nShall I send pictures?",
    ]);
  });

  it("only the material that matters: the best matches within 0.15 of the top score, ≤4, in a ~1,200-token budget", async () => {
    const { selectKnowledge, REPLY_KNOWLEDGE } = await import("./ai-run.server");
    expect(REPLY_KNOWLEDGE).toEqual({ budgetTokens: 1200, maxChunks: 4, floor: 0.15 });
    const row = (similarity: number, chars = 1000) => ({ similarity, text: "x".repeat(chars) });
    // Far below the best one: left out.
    expect(
      selectKnowledge([row(0.62), row(0.57), row(0.45), row(0.41)]).map((r) => r.similarity),
    ).toEqual([0.62, 0.57]);
    // The budget (4,800 characters): a fourth 1,500-character chunk doesn't fit.
    expect(
      selectKnowledge([row(0.6, 1500), row(0.59, 1500), row(0.58, 1500), row(0.57, 1500)]),
    ).toHaveLength(3);
    // At most four, best first, whatever order they came in.
    expect(
      selectKnowledge([
        row(0.5, 100),
        row(0.6, 100),
        row(0.55, 100),
        row(0.58, 100),
        row(0.57, 100),
      ]).map((r) => r.similarity),
    ).toEqual([0.6, 0.58, 0.57, 0.55]);
    // A single oversized best match is cut to the budget, never dropped.
    const big = selectKnowledge([row(0.7, 9000)]);
    expect(big).toHaveLength(1);
    expect(big[0]!.text.length).toBe(4800);
    expect(selectKnowledge([])).toEqual([]);
  });

  it("the chat: the last 12 messages as they are, the customer's older words as one short note", async () => {
    const { compactHistory, REPLY_HISTORY } = await import("./ai-tasks.server");
    expect(REPLY_HISTORY.keepMessages).toBe(12);
    const short = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "Hello!" },
    ];
    expect(compactHistory(short)).toEqual({ history: short, summary: null });
    const turns = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 ? "assistant" : "user") as "user" | "assistant",
      content: i % 2 ? `reply ${i} ${"r".repeat(900)}` : `ask ${i}`,
    }));
    const { history, summary } = compactHistory(turns);
    expect(history).toHaveLength(12);
    expect(history[0]!.content.startsWith("ask 18")).toBe(true);
    // A long earlier reply is cut, never dropped mid-window.
    expect(Math.max(...history.map((t) => t.content.length))).toBeLessThanOrEqual(600);
    // Only the customer's words, the most recent 8 of the older ones, oldest first.
    expect(summary).toBe(
      'Earlier in this chat (18 older messages not shown), the customer wrote, oldest first: "ask 2" · "ask 4" · "ask 6" · "ask 8" · "ask 10" · "ask 12" · "ask 14" · "ask 16"',
    );
    expect(summary).not.toMatch(/reply/);
  });

  it("the long start of the prompt is the same from one reply to the next (brief + fixed rules first; material and notes last)", async () => {
    const a = await replay(CASES.find((c) => c.id === "return-policy-hinglish")!);
    const b = await replay(CASES.find((c) => c.id === "what-is-zoori")!);
    const [sa, sb] = [a.systems[0]!, b.systems[0]!];
    let common = 0;
    while (common < sa.length && sa[common] === sb[common]) common++;
    // Different questions, different material — the fixed rules still sit in the shared start.
    const policyEnd = sa.indexOf("needs_owner") + 40;
    expect(policyEnd).toBeGreaterThan(40);
    expect(common).toBeGreaterThanOrEqual(policyEnd);
    expect(sa.indexOf("Material from this business follows")).toBeGreaterThan(
      sa.indexOf("This business has a product catalogue"),
    );
  });

  it("the customer's language and the corrections count go after the rest of the brief (the sections' own order is unchanged)", async () => {
    const { promptSections } = await import("./brief-order");
    const keys = [
      "rules",
      "who",
      "spoken",
      "jobs",
      "instructions",
      "escalation",
      "taught",
      "knowledge",
    ].map((key) => ({ key }));
    expect(promptSections(keys).map((s) => s.key)).toEqual([
      "rules",
      "who",
      "jobs",
      "instructions",
      "escalation",
      "knowledge",
      "taught",
      "spoken",
    ]);
  });
});

// ------------------------------------------------------------------ (4)
/** A Supabase client whose reads of `table` wait until `release()` (the rest answer as usual). */
function holdTable<T extends { from: (t: string) => unknown }>(client: T, table: string) {
  let release!: () => void;
  let released = false;
  const gate = new Promise<void>((r) => (release = () => ((released = true), r())));
  const held = {
    ...client,
    from: (t: string) => {
      const b = client.from(t) as Record<string, unknown>;
      if (t !== table) return b;
      const then = b["then"] as (r: (v: unknown) => unknown, j: (e: unknown) => unknown) => unknown;
      b["then"] = (r: (v: unknown) => unknown, j: (e: unknown) => unknown) =>
        gate.then(() => then(r, j));
      return b;
    },
  } as T;
  return { client: held, release, released: () => released };
}

describe("(4) retrieval and the cheap checks run alongside what they don't depend on", () => {
  it("the material match starts during the burst wait, and the answer reuses it (one embedding, not two)", async () => {
    resetBurstWindowCache();
    process.env["LOVABLE_API_KEY"] = "test-key";
    const events: string[] = [];
    let burstReads = 0;
    const w = latencyWorld({
      org: `o29-ret-${Math.random()}`,
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) => {
        if (op.table === "platform_settings")
          return { data: { ai_burst_quiet_ms: 300, ai_burst_cap_ms: 300 }, error: null };
        if (op.table === "feature_flags")
          return {
            data: [
              { key: "flows_v2", default_enabled: true },
              { key: "ai_features", default_enabled: true },
            ],
            error: null,
          };
        if (op.table === "ai_agents")
          return { data: { id: "agent-1", mode: "replying" }, error: null };
        if (
          op.table === "messages" &&
          op.kind === "select" &&
          op.filters.some(([f, a]) => f === "limit" && a[0] === 30)
        ) {
          burstReads += 1;
          if (burstReads === 2) events.push("burst_end");
          return { data: [], error: null };
        }
        if (op.table === "conversations" && op.kind === "select")
          return {
            data: {
              id: "cv1",
              contact_id: "c1",
              unread_count: 0,
              assigned_to: null,
              needs_human: false,
              last_customer_message_at: new Date().toISOString(),
              whatsapp_account_id: "acc",
              contacts: { phone: "+919800000001" },
            },
            error: null,
          };
        return undefined;
      },
    });
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith("/embeddings")) {
        events.push("embedding");
        return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
      }
      return w.fetchStub(url, init);
    });
    await processWebhookPayload(
      w.supabase,
      "ev-29r",
      inboundPayload({ id: "wamid.r", type: "text", text: { body: "what is your return policy" } }),
      new Date().toISOString(),
      {
        storeMs: 1,
      },
    );
    expect(events.filter((e) => e === "embedding")).toHaveLength(1);
    expect(events.indexOf("embedding")).toBeLessThan(events.indexOf("burst_end"));
  });

  it("the run's price is read alongside the checks, not before them", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    const world = zooriWorld(CASES.find((c) => c.id === "return-policy-hinglish")!);
    const held = holdTable(
      world.supabase as unknown as { from: (t: string) => unknown },
      "ai_rates",
    );
    let checkWhileRatesPending = false;
    vi.stubGlobal("fetch", async (u: string, i?: RequestInit) => {
      if (String(i?.body ?? "").includes("You check whether sentences")) {
        checkWhileRatesPending = !held.released();
        setTimeout(held.release, 0);
      }
      return world.fetchStub(String(u), i);
    });
    // Nothing else releases the price read: before Batch 29 the checks waited for it.
    const timer = setTimeout(held.release, 2000);
    const { runAgentOnInbound } = await import("./ai-agent.server");
    await runAgentOnInbound(
      held.client as unknown as typeof world.supabase,
      world.args as Parameters<typeof runAgentOnInbound>[1],
    );
    clearTimeout(timer);
    expect(checkWhileRatesPending).toBe(true);
  });
});

// ------------------------------------------------------------------ (5)
describe("(5) every reply records its speed: received → WhatsApp accepted", () => {
  it("webhook timing: received_to_send_ms is set from the send WhatsApp accepted (it was always null live), with Aiden's outcome", async () => {
    resetBurstWindowCache();
    process.env["LOVABLE_API_KEY"] = "test-key";
    const w = aidenWorld();
    // A catch-up style pass: no received_at given — the message's own time is used.
    const sentAt = Math.floor(Date.now() / 1000) - 4;
    const payload = inboundPayload({ id: "wamid.s", type: "text", text: { body: "hello" } });
    (payload.entry[0]!.changes[0]!.value.messages[0] as Record<string, unknown>)["timestamp"] =
      String(sentAt);
    await processWebhookPayload(w.supabase, "ev-29s", payload, null, { storeMs: 1 });
    const m = timingOf(w.ops)!.messages[0]! as Record<string, unknown>;
    expect(m["ai_outcome"]).toBe("replying:ok:sent");
    expect(replies(w)).toEqual(["Hello! How can I help?"]);
    expect(m["received_to_send_ms"]).toBeTypeOf("number");
    expect(Number(m["received_to_send_ms"])).toBeGreaterThanOrEqual(3000);
  });

  it("ai_runs: the reply's run gets metadata.reply_speed (received_to_send_ms, pickup, reason, parts) in one write, keeping its metadata", async () => {
    process.env["LOVABLE_API_KEY"] = "test-key";
    const world = zooriWorld(CASES.find((c) => c.id === "return-policy-hinglish")!);
    vi.stubGlobal("fetch", (u: string, i?: RequestInit) => world.fetchStub(String(u), i));
    const ops: Array<{ table: string; kind: string; payload: unknown }> = [];
    const base = world.supabase as unknown as {
      from: (t: string) => Record<string, unknown>;
      rpc: unknown;
    };
    const supabase = {
      ...base,
      from: (t: string) => {
        const b = base.from(t);
        const update = b["update"] as (p: unknown) => unknown;
        b["update"] = (p: unknown) => (
          ops.push({ table: t, kind: "update", payload: p }),
          update(p)
        );
        return b;
      },
    } as unknown as typeof world.supabase;
    let since = 2000;
    const { runAgentOnInbound } = await import("./ai-agent.server");
    const out = await runAgentOnInbound(supabase, {
      ...(world.args as Parameters<typeof runAgentOnInbound>[1]),
      speed: { sinceReceived: () => (since += 500), pickup: "live", burstMs: 1500 },
    });
    expect(out).toMatchObject({ acted: true, sent: true });
    const write = ops.find((o) => o.table === "ai_runs" && o.kind === "update");
    const meta = (write?.payload as { metadata: Record<string, unknown> }).metadata;
    // The run's own metadata is kept (timing_ms, provider…), reply_speed added.
    expect(meta["timing_ms"]).toBeTruthy();
    const speed = meta["reply_speed"] as Record<string, unknown>;
    expect(speed["pickup"]).toBe("live");
    expect(Number(speed["received_to_send_ms"])).toBeGreaterThan(2000);
    expect(speed["reason"]).toBeTypeOf("string");
    expect((speed["parts"] as Record<string, number>)["burst"]).toBe(1500);
  });

  it("the reason: a safety-net pickup names itself; otherwise the stage that took longest", async () => {
    const { replySpeed } = await import("./reply-timing");
    expect(
      replySpeed({
        receivedToSendMs: 162_000,
        pickup: "catch_up",
        beforeAidenMs: 150_000,
        burstMs: 1500,
        runTiming: { model: 4900 },
        sendMs: 300,
      }).reason,
    ).toBe("catch_up");
    const live = replySpeed({
      receivedToSendMs: 9000,
      pickup: "live",
      beforeAidenMs: 2000,
      burstMs: 1500,
      runTiming: { prelude: 100, retrieval: 1700, model: 4900, checks: 1100 },
      sendMs: 300,
    });
    expect(live).toMatchObject({
      received_to_send_ms: 9000,
      reason: "model",
      parts: { waiting: 500, burst: 1500, model: 4900, retrieval: 1700 },
    });
  });
});

const MIGRATION = join(
  import.meta.dirname,
  "../../supabase/aidwar-migrations/20261090_batch29_reply_speed.sql",
);
describe.runIf(pgAvailable() || Boolean(process.env["CI"]))(
  "(5) reply_speed_stats (real Postgres)",
  () => {
    let pg: ScratchPg;
    beforeAll(() => {
      pg = startScratchPg({
        schemaFile: join(import.meta.dirname, "test-support/loadtest/schema.sql"),
        migrations: [
          join(import.meta.dirname, "test-support/wallet-stubs.sql"),
          MIGRATION,
          MIGRATION,
        ],
      });
    }, 120_000);
    afterAll(() => pg?.stop());

    const run = (org: string, ms: number | null, ago: string, extra = "") =>
      pg.sql(`insert into ai_runs (organization_id, status, task, created_at, metadata)
            values ('${org}', 'ok', 'agent_reply', now() - interval '${ago}',
                    ${ms === null ? `'{}'::jsonb` : `jsonb_build_object('reply_speed', jsonb_build_object('received_to_send_ms', ${ms}, 'pickup', 'live', 'reason', 'model'${extra}))`})`);

    it("per workspace p50 / p90 / slowest for 24 h and 7 d, and the replies over 30 s with their reason — in one call", () => {
      const zoori = pg.sql(`insert into organizations (name) values ('Zoori') returning id`);
      const other = pg.sql(`insert into organizations (name) values ('Other') returning id`);
      // Last 24 h: 1..10 s; earlier this week: a 162 s reply picked up by catch-up.
      for (let i = 1; i <= 10; i++) run(zoori, i * 1000, "1 hour");
      pg.sql(`insert into ai_runs (organization_id, status, task, created_at, metadata)
            values ('${zoori}', 'ok', 'agent_reply', now() - interval '2 days',
                    '{"reply_speed": {"received_to_send_ms": 162000, "pickup": "catch_up", "reason": "catch_up"}}')`);
      run(zoori, null, "1 hour"); // no reply_speed (before this branch): not counted
      run(zoori, 999_000, "8 days"); // outside 7 days
      pg.sql(
        `insert into ai_runs (organization_id, status, task, created_at, metadata) values ('${zoori}', 'ok', 'suggest_reply', now(), '{"reply_speed": {"received_to_send_ms": 99000}}')`,
      );
      run(other, 4000, "3 hours");
      const t = JSON.parse(pg.sql(`select public.reply_speed_stats()`));
      const z = (t.workspaces as Array<Record<string, unknown>>).find(
        (w) => w["organization_id"] === zoori,
      )!;
      expect(z["name"]).toBe("Zoori");
      expect(z["last_24h"]).toMatchObject({
        replies: 10,
        p50_ms: 5500,
        p90_ms: 9100,
        slowest_ms: 10000,
        over_slow: 0,
      });
      expect(z["last_7d"]).toMatchObject({ replies: 11, slowest_ms: 162000, over_slow: 1 });
      expect((t.workspaces as unknown[]).length).toBe(2);
      expect(t.slow).toHaveLength(1);
      expect(t.slow[0]).toMatchObject({
        organization_id: zoori,
        name: "Zoori",
        ms: 162000,
        reason: "catch_up",
        pickup: "catch_up",
      });
    });

    it("the burst settings: columns with their defaults and checks, applied twice without error", () => {
      expect(
        pg.sql(`select ai_burst_quiet_ms || '/' || ai_burst_cap_ms from platform_settings limit 1`),
      ).toBe("1500/3000");
      expect(() => pg.sql(`update platform_settings set ai_burst_cap_ms = 20000`)).toThrow();
    });

    it("service role only: anon and authenticated can't execute it", () => {
      for (const role of ["anon", "authenticated"]) {
        const exists = pg.sql(`select count(*) from pg_roles where rolname = '${role}'`);
        if (exists !== "1") continue;
        expect(
          pg.sql(
            `select has_function_privilege('${role}', 'public.reply_speed_stats(timestamptz, integer, integer)', 'execute')`,
          ),
        ).toBe("f");
      }
    });
  },
);
