import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aidenWorld } from "./test-support/aiden-world";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import { inVirtualTime } from "./test-support/virtual-time";
import { prepareAgentInbound, runAgentOnInbound } from "./ai-agent.server";
import { executeRun, prepareRun } from "./ai-run.server";
import { processWebhookPayload } from "./whatsapp-webhook.server";
// Loaded up front: the webhook imports these lazily, and module loading must
// not race the fake clock in the burst test below.
import "./flow-engine.server";
import "./flow-triggers.server";
import "./cod.server";
import "./offers.server";
import "./service-text.server";

/**
 * Batch 4, item 1 (Aiden): the answer policy is untouched; only waiting is
 * removed. The agent's set-up and the answer run's reads start before the
 * burst wait and run side by side. Measured with aidenWorld (one simulated
 * round trip per query), from the end of the burst wait to the model call:
 *   before 29.4 RTT → after 6.1 RTT.
 */
const RTT = 40;
const args = {
  organizationId: "org",
  conversationId: "cv1",
  contactId: "c1",
  phoneNumberId: "pn",
  accessToken: "tok",
  waId: "919800000001",
  body: "Is your gold hallmarked?",
  alreadyHandled: false,
  optedOut: false,
};

beforeEach(() => {
  process.env["LOVABLE_API_KEY"] = "k";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("(1) Aiden: set-up read during the burst, checks still after it", () => {
  it("prepared during the burst, the model is called within 10 round trips of the burst ending (was 29)", async () => {
    const w = aidenWorld({ rttMs: RTT });
    vi.stubGlobal("fetch", w.fetchStub);
    const prepared = prepareAgentInbound(w.supabase, "org");
    await prepared.then((p) => p.prelude); // the burst wait covers this
    // Batch 17: on a virtual clock, so "within N round trips" never races a loaded machine.
    const out = await inVirtualTime(async () => {
      w.t0.at = Date.now();
      return runAgentOnInbound(w.supabase, { ...args, prepared });
    });
    // (This bare workspace brokers no tools, so the answer is handed over —
    // the path to the model call is the same either way.)
    expect(out).toMatchObject({ acted: true, mode: "replying" });
    expect(w.modelCalls[0]!).toBeLessThan(10 * RTT);
  });

  it("the conversation is still read after the burst: a teammate who took over meanwhile wins", async () => {
    const w = aidenWorld({ rttMs: 0, conversation: { assigned_to: "user-1" } });
    vi.stubGlobal("fetch", w.fetchStub);
    const prepared = prepareAgentInbound(w.supabase, "org");
    const out = await runAgentOnInbound(w.supabase, { ...args, prepared });
    expect(out).toEqual({ acted: false, reason: "assigned_to_human" });
    expect(w.modelCalls).toHaveLength(0);
  });

  it("an agent that isn't replying starts nothing: no spend, key or tool reads", async () => {
    const w = aidenWorld({ rttMs: 0 });
    const off = { ...w, supabase: w.supabase };
    const prep = await prepareAgentInbound(
      new Proxy(off.supabase, {
        get(target, prop) {
          if (prop !== "from") return Reflect.get(target, prop);
          return (table: string) => {
            const b = target.from(table) as unknown as Record<string, unknown>;
            if (table !== "ai_agents") return b;
            // mode: draft
            return { ...b, select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "a", mode: "draft" }, error: null }) }) }) }) };
          };
        },
      }),
      "org",
    );
    expect(prep.prelude).toBeNull();
    expect(w.rpcs.map((r) => r.name)).not.toContain("ai_month_spend");
    expect(w.ops.some((o) => o.table === "ai_providers" || o.table === "products")).toBe(false);
  });

  it("unchanged: AI switched off → refused before any model call, even with the reads done early", async () => {
    const w = aidenWorld({ rttMs: 0 });
    vi.stubGlobal("fetch", w.fetchStub);
    const prelude = prepareRun(w.supabase, { organizationId: "org", task: "agent_reply", agentId: "agent-1", useTools: false });
    const out = await executeRun(w.supabase, {
      organizationId: "org",
      task: "agent_reply",
      agentId: "agent-1",
      input: "hi",
      prelude: prelude.then((p) => ({ ...p, aiEnabled: false })),
    });
    expect(out).toMatchObject({ status: "refused", error: "AI is switched off for this workspace." });
    expect(w.modelCalls).toHaveLength(0);
  });

  it("unchanged: over the spending cap → capped before any model call", async () => {
    const w = aidenWorld({ rttMs: 0 });
    vi.stubGlobal("fetch", w.fetchStub);
    const prelude = prepareRun(w.supabase, { organizationId: "org", task: "agent_reply", agentId: "agent-1", useTools: false });
    const out = await executeRun(w.supabase, {
      organizationId: "org",
      task: "agent_reply",
      agentId: "agent-1",
      input: "hi",
      prelude: prelude.then((p) => ({ ...p, cap: { over: true, cap: 10, spent: 10, currency: "INR", misconfigured: false } })),
    });
    expect(out.status).toBe("capped");
    expect(w.modelCalls).toHaveLength(0);
  });

  it("each run records where its time went (ai_runs.metadata.timing_ms)", async () => {
    const w = aidenWorld({ rttMs: 0 });
    vi.stubGlobal("fetch", w.fetchStub);
    await executeRun(w.supabase, { organizationId: "org", task: "agent_reply", agentId: "agent-1", input: "What is your return policy?", useKnowledge: true });
    const row = w.ops.find((o) => o.table === "ai_runs" && o.kind === "insert")!.payload as { metadata: { timing_ms: Record<string, number> } };
    expect(Object.keys(row.metadata.timing_ms)).toEqual(["prelude", "retrieval", "model", "checks"]);
  });

  it("the webhook starts the agent's set-up before the 5 s burst wait, not after it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const w = latencyWorld({ org: "org-ai", rttMs: 0, graphMs: 0, waitingRun: false });
    vi.stubGlobal("fetch", w.fetchStub);
    const done = processWebhookPayload(w.supabase, "ev-ai", inboundPayload({ id: "wamid.q", type: "text", text: { body: "What is your return policy?" } }));
    // Up to 1 s of (fake) time, letting module loading finish between steps.
    for (let i = 0; i < 100 && !w.ops.some((o) => o.table === "ai_agents"); i++) {
      await vi.advanceTimersByTimeAsync(10);
      await new Promise((r) => setImmediate(r));
    }
    const burstRead = (o: { table: string; filters: Array<[string, unknown[]]> }) =>
      o.table === "messages" && o.filters.some(([f, a]) => f === "limit" && a[0] === 30);
    expect(w.ops.some((o) => o.table === "ai_agents")).toBe(true);
    expect(w.ops.some(burstRead)).toBe(false);
    await vi.advanceTimersByTimeAsync(6000);
    await done;
    expect(w.ops.some(burstRead)).toBe(true);
  });
});
