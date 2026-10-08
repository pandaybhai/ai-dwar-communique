import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { zooriWorld, type Case, type Replay } from "./test-support/zoori-replay";

/**
 * Batch 27 — a customer is never left in silence (Aiden side).
 *
 *  H2  a run that errors, is capped, or throws: filed under Unanswered,
 *      "Waiting for you" (needs_human) with the staff alert, and the
 *      workspace's own hand-over line — never words written in code.
 *  M1  the live reply's first model call gives up after ~20 s (then the
 *      backup takes over); every other call keeps its 120 s.
 *  M11 a policy sentence the check couldn't decide is treated as unsupported.
 *
 * Same Zoori world as the Batch 14 replay — only the model is scripted.
 */

const h = vi.hoisted(() => ({
  throwAnswer: false,
  alerts: [] as Array<Record<string, unknown>>,
  calls: [] as Array<{ target: string; url: string; options: Record<string, unknown> }>,
}));

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalog"]),
}));
vi.mock("@/lib/ai-tools.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ai-tools.server")>();
  const { allAiTools } = await import("./feature-registry");
  const offered = () =>
    allAiTools()
      .filter((t) => t.name === "catalog_search" || t.name === "send_products")
      .map(({ flag_key: _flag, ...tool }) => tool);
  return {
    ...real,
    brokerTools: async () => offered(),
    invokeTool: async (ctx: Parameters<typeof real.invokeTool>[0], name: string, args: Record<string, unknown>) => {
      const tool = offered().find((t) => t.name === name)!;
      const out = await real.AI_TOOL_HANDLERS[tool.handler]!({ ...ctx, brokered: true }, args);
      return { ...out, latencyMs: 1, activityLogId: null, arguments: args, resultSummary: real.summarise(out) };
    },
  };
});
vi.mock("@/lib/ai-tasks.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ai-tasks.server")>();
  return {
    ...real,
    agentAnswer: (async (...a: Parameters<typeof real.agentAnswer>) => {
      if (h.throwAnswer) throw new Error("the answer run fell over");
      return real.agentAnswer(...a);
    }) as typeof real.agentAnswer,
  };
});
vi.mock("@/lib/handoff-alerts.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./handoff-alerts.server")>();
  return {
    ...real,
    sendHandoffAlert: async (_db: unknown, args: Record<string, unknown>) => {
      h.alerts.push(args);
      return { whatsapp: [], email: null, refused: [] };
    },
  };
});
vi.mock("@/lib/outside-call.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./outside-call.server")>();
  return {
    ...real,
    outsideFetch: (target: Parameters<typeof real.outsideFetch>[0], url: string | URL, init?: RequestInit, options: Record<string, unknown> = {}) => {
      h.calls.push({ target, url: String(url), options });
      return real.outsideFetch(target, url, init, options);
    },
  };
});

beforeAll(() => {
  process.env["LOVABLE_API_KEY"] = "test-key";
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  h.throwAnswer = false;
  h.alerts.length = 0;
  h.calls.length = 0;
});

type Opts = {
  /** This month's AI spend (the cap is 1000). */
  spent?: number;
  /** Answer a model request (by its system prompt) before the Zoori script does. */
  intercept?: (system: string) => Response | undefined;
};

async function replay(c: Case, opts: Opts = {}) {
  const world = zooriWorld(c);
  const supabase = {
    from: (t: string) => world.supabase.from(t),
    rpc: (n: string, a: Record<string, unknown>) =>
      opts.spent !== undefined && n === "ai_month_spend" ? Promise.resolve({ data: opts.spent, error: null }) : world.supabase.rpc(n, a),
  } as unknown as typeof world.supabase;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (opts.intercept && String(url).includes("/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content?: unknown }> };
      const own = opts.intercept(String(body.messages?.[0]?.content ?? ""));
      if (own) return own;
    }
    return world.fetchStub(url, init);
  });
  const { runAgentOnInbound } = await import("./ai-agent.server");
  const outcome = (await runAgentOnInbound(supabase, world.args as Parameters<typeof runAgentOnInbound>[1])) as unknown as Record<string, unknown>;
  vi.unstubAllGlobals();
  const { handoverMessage } = await import("./ai-tasks.server");
  return { r: world.result() as Replay, outcome, handover: await handoverMessage(supabase, "agent-zoori") };
}

const ASK: Case = { id: "b27", ask: "do you have silver anklets?", model: () => ({ text: "We have a few — want to see them?" }) };
const badRequest = () => new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });

describe("H2: Aiden's run breaks or hits the limit → a person is told, the customer isn't left in silence", () => {
  it("a capped run files a gap, sets Waiting for you and alerts the staff", async () => {
    const { r, outcome, handover } = await replay(ASK, { spent: 5000 });
    expect(r.status).toBe("capped");
    expect(outcome).toMatchObject({ acted: true, sent: false, status: "capped" });
    expect(r.gapFiled).toBe(true);
    expect(r.handedOff).toBe(true);
    expect(h.alerts).toEqual([expect.objectContaining({ reason: "ai_capped", question: ASK.ask })]);
    // The workspace's own hand-over line (its instructions, else the configured default).
    expect(handover.trim()).not.toBe("");
    expect(r.sent.map((s) => s.text)).toEqual([handover]);
  });

  it("an errored run (the model refused the request): the same", async () => {
    const { r, outcome } = await replay(ASK, { intercept: (system) => (system.startsWith("You check") ? undefined : badRequest()) });
    expect(r.status).toBe("error");
    expect(outcome).toMatchObject({ sent: false, status: "error" });
    expect(r.gapFiled).toBe(true);
    expect(r.handedOff).toBe(true);
    expect(h.alerts).toEqual([expect.objectContaining({ reason: "ai_error" })]);
    expect(r.sent).toHaveLength(1);
  });

  it("the answer run throws: the same, nothing escapes to the webhook", async () => {
    h.throwAnswer = true;
    const { r, outcome } = await replay(ASK);
    expect(outcome).toMatchObject({ acted: true, sent: false, status: "error" });
    expect(r.gapFiled).toBe(true);
    expect(r.handedOff).toBe(true);
    expect(h.alerts).toEqual([expect.objectContaining({ reason: "ai_error" })]);
  });

  it("unchanged: a good answer goes out, no hand-off, no alert", async () => {
    const { r } = await replay(ASK);
    expect(r.status).toBe("ok");
    expect(r.handedOff ?? false).toBe(false);
    expect(h.alerts).toEqual([]);
    expect(r.sent.map((s) => s.text)).toEqual(["We have a few — want to see them?"]);
  });

  it("unchanged (Batch 16): nothing to say is filed, but Aiden stays on — no hand-off", async () => {
    const { r } = await replay({ ...ASK, model: () => ({ text: '{"needs_owner": true}' }) });
    expect(r.gapFiled).toBe(true);
    expect(r.handedOff ?? false).toBe(false);
    expect(h.alerts).toEqual([]);
  });
});

describe("M1: the live reply's first model call has a ~20 s limit; the rest keep 120 s", () => {
  it("first answer call: timeoutMs 20 s; the tool-result step and the policy check: the defaults", async () => {
    const { LIVE_FIRST_CALL_TIMEOUT_MS } = await import("./ai-agent.server");
    expect(LIVE_FIRST_CALL_TIMEOUT_MS).toBe(20_000);
    await replay({
      id: "b27-m1",
      ask: "silver rings",
      model: ({ step }) =>
        step === 0 ? { calls: [{ name: "catalog_search", args: { query: "silver rings" } }] } : { text: "Here you go." },
    });
    const model = h.calls.filter((c) => c.url.endsWith("/chat/completions"));
    expect(model.length).toBeGreaterThanOrEqual(2);
    expect(model[0]!.options).toEqual({ timeoutMs: LIVE_FIRST_CALL_TIMEOUT_MS });
    for (const later of model.slice(1)) expect(later.options).toEqual({});
  });

  it("a call that hangs past its limit fails as unreachable — which hands the run to the backup", async () => {
    const real = await vi.importActual<typeof import("./outside-call.server")>("./outside-call.server");
    const { outageOf } = await import("./ai-fallback.server");
    vi.stubGlobal("fetch", (_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const failure = await real.outsideFetch("ai", "https://ai.test/chat/completions", {}, { timeoutMs: 30 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(real.OutsideCallTimeout);
    expect(outageOf(failure)).toEqual({ kind: "network", status: null });
  });
});

describe("M11: a policy sentence the check couldn't decide is not sent as fact", () => {
  const SHIPPING: Case = {
    id: "b27-m11",
    ask: "how do you send orders?",
    model: () => ({ text: 'We ship every order with our own courier partner.\n{"needs_owner": false}' }),
  };
  const failCheck = (system: string) =>
    system.startsWith("You check whether sentences") || system.startsWith("You edit a shop assistant") ? badRequest() : undefined;

  it("the check failed: the claim goes (the configured promise line), the question is filed", async () => {
    const { r } = await replay(SHIPPING, { intercept: failCheck });
    expect(r.sent.map((s) => s.text)).toEqual(["Let me confirm that for you."]);
    expect(r.gapFiled).toBe(true);
  });

  it("the check answered nothing for it: the same", async () => {
    const { r } = await replay(SHIPPING, {
      intercept: (system) =>
        system.startsWith("You check whether sentences")
          ? new Response(JSON.stringify({ choices: [{ message: { content: '{"answers": []}' } }] }))
          : system.startsWith("You edit a shop assistant")
            ? badRequest()
            : undefined,
    });
    expect(r.sent.map((s) => s.text)).toEqual(["Let me confirm that for you."]);
  });

  it("unchanged: a sentence the check says yes to goes as written", async () => {
    const { r } = await replay(SHIPPING, {
      intercept: (system) =>
        system.startsWith("You check whether sentences")
          ? new Response(JSON.stringify({ choices: [{ message: { content: '{"answers": ["yes"]}' } }] }))
          : undefined,
    });
    expect(r.sent.map((s) => s.text)).toEqual(["We ship every order with our own courier partner."]);
  });
});
