import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakeOp } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";
import {
  PRODUCTS,
  productsIn,
  zooriWorld,
  type Case,
  type ModelCtx,
  type Turn,
} from "./test-support/zoori-replay";

/**
 * Batch 15C — faster product replies.
 *  (1) one model step for a product reply: the customer's own words go
 *      through catalog_search before the first model call (same tool, same
 *      broker, same rules), and the model may send products and close in
 *      that one call; results that don't fit are never shown;
 *  (2) the website's material is read alongside the prelude and the early
 *      search, and a pure product browse doesn't wait for it;
 *  (3) the webhook's pre-AI steps overlap where independent — flows still
 *      win, a person's thread still silences Aiden;
 *  (4a) a code-titled product's readable name prefers its description's own
 *      words when they say more than its materials line;
 *  (4b) no automatic website re-read unless platform_settings says so.
 * The live-calibrated before/after timings are in batch15c-bench.test.ts.
 */

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalogs", "flows_v2"]),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

type Logged = { table: string; kind: string; payload?: unknown };

/** One customer message through runAgentOnInbound in Zoori's world, every query and model call recorded. */
async function answer(
  c: Case,
  opts: {
    model?: string;
    /** Called for each model request before the world answers it; return a Response to answer it yourself. */
    intercept?: (url: string, body: Record<string, unknown>) => Response | undefined;
  } = {},
) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T05:05:00Z") });
  process.env["LOVABLE_API_KEY"] = "test-key";
  const world = zooriWorld(c);
  const logged: Logged[] = [];
  const wrap = (b: Record<string, unknown>, entry: Logged) => {
    for (const k of ["insert", "update", "upsert", "delete"]) {
      const orig = b[k] as ((...a: unknown[]) => unknown) | undefined;
      if (orig)
        b[k] = (...a: unknown[]) => {
          entry.kind = k;
          entry.payload = a[0];
          return orig.apply(b, a);
        };
    }
    return b;
  };
  const supabase = {
    from(t: string) {
      const entry: Logged = { table: t, kind: "select" };
      logged.push(entry);
      const b = world.supabase.from(t) as unknown as Record<string, unknown>;
      if (opts.model && t === "ai_tiers") {
        return {
          ...b,
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  key: "careful",
                  display_name: "Careful",
                  provider: "lovable",
                  model_id: opts.model,
                  is_active: true,
                },
                error: null,
              }),
            }),
          }),
        };
      }
      return wrap(b, entry);
    },
    rpc: (n: string, a: Record<string, unknown>) => world.supabase.rpc(n, a),
  } as unknown as typeof world.supabase;
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/chat/completions") || u.includes("/responses")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const system = JSON.stringify(body["messages"] ?? body["input"] ?? "");
      if (!system.includes("You check whether sentences")) requests.push({ url: u, body });
      const own = opts.intercept?.(u, body);
      if (own) return own;
    } else if (u.endsWith("/embeddings")) requests.push({ url: u, body: {} });
    return world.fetchStub(u, init);
  });
  const { runAgentOnInbound } = await import("./ai-agent.server");
  const outcome = await runAgentOnInbound(
    supabase,
    world.args as Parameters<typeof runAgentOnInbound>[1],
  );
  const run = logged.find(
    (l) =>
      l.table === "ai_runs" &&
      l.kind === "insert" &&
      !((l.payload as Record<string, unknown>)["metadata"] as Record<string, unknown>)?.["purpose"],
  );
  const meta = ((run?.payload as Record<string, unknown> | undefined)?.["metadata"] ??
    {}) as Record<string, unknown>;
  const modelCalls = requests.filter((r) => !r.url.endsWith("/embeddings"));
  return {
    outcome,
    ...world.result(),
    meta,
    logged,
    modelCalls,
    embedded: requests.some((r) => r.url.endsWith("/embeddings")),
    toolsInvoked: logged
      .filter((l) => l.table === "activity_log" && l.kind === "insert")
      .map(
        (l) =>
          ((l.payload as Record<string, unknown>)["details"] as Record<string, unknown>)["tool"],
      ),
  };
}

const idOf = (f: Record<string, unknown>) => String(f["product_id"] ?? f["id"]);
const cap = (f: Record<string, unknown>) =>
  `${String(f["name"] ?? f["title"])} — ${String(f["price"])}\n${String(f["link"] ?? "")}`;

/** A model that uses whatever catalogue result it already has: send + close in one call. */
const oneStep =
  (intro: string, closing: string, count = 2) =>
  (ctx: ModelCtx): Turn => {
    const found = productsIn(ctx.seen);
    if (found.length === 0)
      return { calls: [{ name: "catalog_search", args: { category: "earrings" } }] };
    if (ctx.seen.some((s) => s.name === "send_products")) return { text: "(asked again)" };
    return {
      text: intro,
      calls: [
        {
          name: "send_products",
          args: {
            products: found.slice(0, count).map((f) => ({ product_id: idOf(f), caption: cap(f) })),
            closing: `${closing}\n{"needs_owner": false}`,
          },
        },
      ],
    };
  };

// -------------------------------------------------------------------- (1)
describe("(1) one model step for a product reply", () => {
  it("'earrings dikhao': the first model call already has the catalogue result; it sends and closes in that call", async () => {
    const r = await answer({
      id: "earrings-one-step",
      ask: "earrings dikhao",
      model: oneStep("Ye rahe kuch earrings:", "Kis budget mein dekh rahe hain?"),
    });
    expect(r.modelCalls).toHaveLength(1);
    // The first request carries the early catalog_search call and its result.
    const msgs = r.modelCalls[0]!.body["messages"] as Array<{
      role: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    }>;
    const call = msgs.find((m) => m.tool_calls?.length)!.tool_calls![0]!;
    expect(call.id).toBe("early_catalog_search");
    expect(call.function.name).toBe("catalog_search");
    expect(JSON.parse(call.function.arguments)).toEqual({ query: "earrings dikhao", limit: 5 });
    expect(msgs.find((m) => m.role === "tool")).toBeDefined();
    // The customer gets the model's words, its products, its closing — in its order.
    expect(r.sent.map((s) => s.type)).toEqual(["text", "text", "text", "text"]);
    expect(r.sent[0]!.text).toBe("Ye rahe kuch earrings:");
    expect(r.sent.at(-1)!.text).toBe("Kis budget mein dekh rahe hain?");
    expect(
      r.sent
        .slice(1, -1)
        .every((s) =>
          /Earrings? — ₹[\d,]+\nhttps:\/\/www\.myzoori\.com\/product-detail\//.test(s.text),
        ),
    ).toBe(true);
    expect(r.meta["early_search"]).toMatchObject({
      ran: true,
      used: true,
      reason: "used",
      rows: 2,
      model_searched: 0,
    });
    expect(r.meta["model_calls"]).toBe(1);
    expect(r.meta["closed_in_call"]).toBe(true);
    // One search ran (the early one), through the broker, as the agent.
    expect(r.toolsInvoked).toEqual(["catalog_search", "send_products"]);
  });

  it("the same search the model would make: brokered, 14.1 rings rule, no earrings in a rings browse", async () => {
    const r = await answer({
      id: "rings",
      ask: "rings dikhao",
      model: oneStep("Rings:", "Kaunsa pasand aaya?", 5),
    });
    expect(r.meta["early_search"]).toMatchObject({ used: true });
    const shown = r.sent.slice(1, -1).map((s) => s.text);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.join("\n")).not.toMatch(/ZERN|Earrings/);
  });

  it("the model can still search for itself when the early results don't fit (then it is as today)", async () => {
    const r = await answer({
      id: "own-search",
      ask: "earrings dikhao",
      model: (ctx) => {
        if (ctx.step === 0)
          return {
            calls: [{ name: "catalog_search", args: { category: "earrings", gender: "female" } }],
          };
        return oneStep("Ye rahe:", "Budget?")(ctx);
      },
    });
    expect(r.meta["early_search"]).toMatchObject({ used: true, model_searched: 1 });
    expect(r.toolsInvoked).toEqual(["catalog_search", "catalog_search", "send_products"]);
    expect(r.modelCalls).toHaveLength(2);
    expect(r.sent.at(-1)!.text).toBe("Budget?");
  });

  it("without closing words the model is asked again, as before (2 calls, not 3)", async () => {
    const r = await answer({
      id: "no-closing",
      ask: "earrings dikhao",
      model: (ctx) => {
        if (!ctx.seen.some((s) => s.name === "send_products"))
          return {
            calls: [
              {
                name: "send_products",
                args: {
                  products: productsIn(ctx.seen)
                    .slice(0, 2)
                    .map((f) => ({ product_id: idOf(f), caption: cap(f) })),
                },
              },
            ],
          };
        return { text: 'Kaunsa pasand aaya?\n{"needs_owner": false}' };
      },
    });
    expect(r.modelCalls).toHaveLength(2);
    expect(r.meta["closed_in_call"]).toBeUndefined();
    expect(r.sent.at(-1)!.text).toBe("Kaunsa pasand aaya?");
  });

  it("closing words with a product id that isn't ours: not the end — the model hears about it and is asked again", async () => {
    const r = await answer({
      id: "bad-id",
      ask: "earrings dikhao",
      model: (ctx) => {
        const found = productsIn(ctx.seen);
        if (!ctx.seen.some((s) => s.name === "send_products"))
          return {
            calls: [
              {
                name: "send_products",
                args: {
                  products: [
                    { product_id: idOf(found[0]!), caption: cap(found[0]!) },
                    { product_id: "made-up", caption: "x" },
                  ],
                  closing: "Budget?",
                },
              },
            ],
          };
        return { text: 'Aur kuch?\n{"needs_owner": false}' };
      },
    });
    expect(r.modelCalls).toHaveLength(2);
    expect(r.sent.at(-1)!.text).toBe("Aur kuch?");
  });

  describe("results that don't fit are never shown", () => {
    const noTools = (ctx: ModelCtx): Turn => ({
      text: ctx.seen.length
        ? "(saw a tool result)"
        : 'Somajiguda and Bolarum — let me confirm the timings for you.\n{"needs_owner": true}',
    });
    const firstCallTools = (r: Awaited<ReturnType<typeof answer>>) =>
      (r.modelCalls[0]!.body["messages"] as Array<{ role: string }>).filter(
        (m) => m.role === "tool",
      ).length;

    it("a question the catalogue has nothing for ('showroom timing kya hai'): nothing found, the model sees no search", async () => {
      const r = await answer({ id: "timing", ask: "showroom timing kya hai", model: noTools });
      expect(r.meta["early_search"]).toMatchObject({
        ran: true,
        used: false,
        reason: "nothing_found",
      });
      expect(firstCallTools(r)).toBe(0);
      expect(r.sent.map((s) => s.text).join(" ")).not.toMatch(/saw a tool result/);
    });

    it("a budget, size or code in the words ('tanmaniya under 20k'): the model searches with it itself", async () => {
      const r = await answer({
        id: "budget",
        ask: "tanmaniya under 20k",
        model: (ctx) =>
          ctx.step === 0
            ? {
                calls: [
                  { name: "catalog_search", args: { category: "tanmaniya", max_price: 20000 } },
                ],
              }
            : { text: 'Nothing under ₹20,000 right now.\n{"needs_owner": false}' },
      });
      expect(r.meta["early_search"]).toMatchObject({ used: false, reason: "has_figure" });
      expect(firstCallTools(r)).toBe(0);
    });

    it("a filter the shelf ignored ('rings with emerald'): this catalogue knows the word, the rings found don't carry it", async () => {
      const r = await answer({ id: "emerald", ask: "rings with emerald", model: noTools });
      expect(r.meta["early_search"]).toMatchObject({
        used: false,
        reason: "words_not_covered",
        missing: ["emerald"],
      });
      expect(firstCallTools(r)).toBe(0);
    });

    it("small talk never searches at all", async () => {
      const r = await answer({
        id: "hi",
        ask: "hi",
        model: () => ({ text: 'Hi! How can I help?\n{"needs_owner": false}' }),
      });
      expect(r.toolsInvoked).toEqual([]);
      expect(r.meta["early_search"]).toMatchObject({
        ran: false,
        used: false,
        reason: "small_talk",
      });
    });
  });

  it("a provider that refuses the conversation with the early search in it gets the same question without it", async () => {
    let refused = 0;
    const r = await answer(
      { id: "refused", ask: "earrings dikhao", model: oneStep("Ye rahe:", "Budget?") },
      {
        intercept: (_u, body) => {
          if (JSON.stringify(body).includes("early_catalog_search") && refused === 0) {
            refused += 1;
            return new Response(JSON.stringify({ error: { message: "invalid tool call" } }), {
              status: 400,
            });
          }
          return undefined;
        },
      },
    );
    expect(refused).toBe(1);
    expect(r.meta["early_search"]).toMatchObject({ used: false, reason: "provider_refused" });
    expect(r.status).toBe("ok");
    expect(r.sent.at(-1)!.text).toBe("Budget?");
    // The model searched itself, as before.
    expect(r.toolsInvoked.filter((t) => t === "catalog_search")).toHaveLength(2);
  });

  it("Gemini: the call it didn't make carries the documented thought-signature stand-in", async () => {
    const r = await answer({
      id: "gemini",
      ask: "earrings dikhao",
      model: oneStep("Ye rahe:", "Budget?"),
    });
    const msgs = r.modelCalls[0]!.body["messages"] as Array<{
      tool_calls?: Array<Record<string, unknown>>;
    }>;
    expect(msgs.find((m) => m.tool_calls)!.tool_calls![0]!["extra_content"]).toEqual({
      google: { thought_signature: "skip_thought_signature_validator" },
    });
  });

  it("OpenAI (Responses, as Zoori runs live on gpt-5.4): the early search is a function_call + output before the first call", async () => {
    const sse = (output: unknown[]) =>
      new Response(
        `data: ${JSON.stringify({ type: "response.completed", response: { output, usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`,
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    let firstInput: unknown[] | null = null;
    const r = await answer(
      { id: "openai", ask: "earrings dikhao", model: () => ({ text: "" }) },
      {
        model: "openai/gpt-5.4",
        intercept: (u, body) => {
          if (!u.endsWith("/responses")) return undefined;
          const input = body["input"] as Array<Record<string, unknown>>;
          firstInput ??= input;
          const out = input.find(
            (i) => i["type"] === "function_call_output" && i["call_id"] === "early_catalog_search",
          );
          const facts = (
            JSON.parse(String(out!["output"])) as { data: Array<Record<string, unknown>> }
          ).data;
          return sse([
            {
              type: "function_call",
              call_id: "fc_1",
              name: "send_products",
              arguments: JSON.stringify({
                products: facts.slice(0, 2).map((f) => ({ product_id: idOf(f), caption: cap(f) })),
                closing: 'Kis budget mein?\n{"needs_owner": false}',
              }),
            },
          ]);
        },
      },
    );
    const items = firstInput! as Array<Record<string, unknown>>;
    expect(items.find((i) => i["type"] === "function_call")).toMatchObject({
      call_id: "early_catalog_search",
      name: "catalog_search",
    });
    expect(r.modelCalls).toHaveLength(1);
    expect(r.sent.at(-1)!.text).toBe("Kis budget mein?");
    expect(r.meta["early_search"]).toMatchObject({ used: true });
  });

  it("the tool tells the model about closing; nothing else about the tool changed", async () => {
    const { allAiTools } = await import("./feature-registry");
    const send = allAiTools().find((t) => t.name === "send_products")!;
    const props = (send.parameters as { properties: Record<string, unknown>; required: string[] })
      .properties;
    expect(Object.keys(props)).toEqual(["products", "closing"]);
    expect((send.parameters as { required: string[] }).required).toEqual(["products"]);
  });
});

// -------------------------------------------------------------------- (2)
describe("(2) the website's material is read alongside, never in front", () => {
  async function direct(
    ask: string,
    opts: { knowledge?: "never" | "slow"; prelude?: "held" } = {},
  ) {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T05:05:00Z") });
    process.env["LOVABLE_API_KEY"] = "test-key";
    const world = zooriWorld({ id: "direct", ask, model: oneStep("Ye rahe:", "Budget?") });
    const order: string[] = [];
    let release: () => void = () => {};
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/embeddings")) {
        order.push("embedding");
        if (opts.prelude === "held") release();
      }
      if (
        u.includes("/chat/completions") &&
        !String(init?.body).includes("You check whether sentences")
      )
        order.push("model");
      return world.fetchStub(u, init);
    });
    const ai = await import("./ai-run.server");
    const real = ai.prepareRun(world.supabase, {
      organizationId: world.args.organizationId,
      task: "agent_reply",
      agentId: "agent-zoori",
      actorUserId: null,
      useTools: true,
    });
    let prelude: typeof real = real;
    if (opts.prelude === "held") {
      const held = new Promise<Awaited<typeof real>>((resolve) => {
        release = () => {
          order.push("prelude");
          void real.then(resolve);
        };
        // Never hang: a sequential build would fail the ordering check instead.
        setTimeout(() => release(), 300);
      });
      prelude = Object.assign(held, {
        toolsReady: real.toolsReady!,
        productsReady: real.productsReady!,
      });
    }
    const knowledge =
      opts.knowledge === "never"
        ? new Promise<null>(() => {})
        : opts.knowledge === "slow"
          ? ai
              .matchKnowledge(world.supabase, {
                organizationId: world.args.organizationId,
                agentId: "agent-zoori",
                input: ask,
                merchantChannel: false,
              })
              .then((m) => new Promise<typeof m>((r) => setTimeout(() => r(m), 60)))
          : undefined;
    const runs: Array<Record<string, unknown>> = [];
    const supabase = {
      from: (t: string) => {
        const b = world.supabase.from(t) as unknown as Record<string, unknown>;
        if (t === "ai_runs") {
          const insert = b["insert"] as (p: unknown) => unknown;
          b["insert"] = (p: unknown) => {
            runs.push(p as Record<string, unknown>);
            return insert.call(b, p);
          };
        }
        return b;
      },
      rpc: (n: string, a: Record<string, unknown>) => {
        if (n === "match_knowledge_chunks") order.push("match");
        return world.supabase.rpc(n, a);
      },
    } as unknown as typeof world.supabase;
    const result = await ai.executeRun(supabase, {
      organizationId: world.args.organizationId,
      task: "agent_reply",
      agentId: "agent-zoori",
      conversationId: world.args.conversationId,
      contactId: world.args.contactId,
      input: ask,
      useTools: true,
      useKnowledge: true,
      prelude,
      ...(knowledge ? { lookups: { knowledge } } : {}),
    });
    const meta = (runs.find((r) => !(r["metadata"] as Record<string, unknown>)["purpose"])?.[
      "metadata"
    ] ?? {}) as Record<string, unknown>;
    return { result, order, meta, systems: world.result().systems };
  }

  it("the embedding and the match start while the prelude is still being read", async () => {
    const r = await direct("showroom timing kya hai", { prelude: "held" });
    expect(r.order.indexOf("embedding")).toBeGreaterThanOrEqual(0);
    expect(r.order.indexOf("embedding")).toBeLessThan(r.order.indexOf("prelude"));
    expect(r.order.indexOf("model")).toBeGreaterThan(r.order.indexOf("match"));
  });

  it("a pure product browse with products found doesn't wait for material still being read", async () => {
    const r = await direct("earrings dikhao", { knowledge: "never" });
    expect(r.result.status).toBe("ok");
    expect(r.meta["retrieval"]).toBe("skipped_browse");
    expect(r.meta["early_search"]).toMatchObject({ used: true });
  });

  it("a policy question keeps it: the run waits, and the model (and the guards) get the material", async () => {
    const r = await direct("earrings return policy kya hai", { knowledge: "slow" });
    expect(r.meta["retrieval"]).toBe("waited");
    expect(r.systems[0]).toMatch(/20-Day Returns/);
  });

  it("a figure question keeps it too ('showroom timing kya hai')", async () => {
    const r = await direct("showroom timing kya hai", { knowledge: "slow" });
    expect(["waited", "ready"]).toContain(r.meta["retrieval"]);
  });
});

// -------------------------------------------------------------------- (3)
describe("(3) pre-AI steps overlap; who answers is unchanged", () => {
  const AI_ON =
    (extra: Record<string, unknown> = {}) =>
    (op: FakeOp) => {
      if (op.table === "ai_agents")
        return { data: { id: "agent-1", mode: "replying" }, error: null };
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
      if (op.table === "platform_settings")
        return {
          data: {
            onboarding_whatsapp_account_id: null,
            ai_monthly_cap_amount: 100000,
            ai_cap_currency: "INR",
            ai_markup_multiplier: 3,
          },
          error: null,
        };
      if (op.table === "conversations" && op.kind === "select")
        return {
          data: {
            id: "cv1",
            contact_id: "c1",
            unread_count: 0,
            assigned_to: null,
            needs_human: false,
            last_customer_message_at: new Date().toISOString(),
            whatsapp_account_id: "acc-o15c",
            contacts: { phone: "+919800000001" },
            ...extra,
          },
          error: null,
        };
      return undefined;
    };

  async function deliver(
    msg: Record<string, unknown>,
    opts: {
      waitingRun?: boolean;
      override?: (op: FakeOp) => { data: unknown; error: null; count?: number } | undefined;
    } = {},
  ) {
    const issued: Array<{ table: string; kind: string; columns: string }> = [];
    const w = latencyWorld({
      org: "o15c",
      rttMs: 2,
      graphMs: 0,
      waitingRun: opts.waitingRun ?? false,
      override: (op) => {
        issued.push({ table: op.table, kind: op.kind, columns: String(op.select?.[0] ?? "") });
        return opts.override?.(op);
      },
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (
        u.includes("/chat/completions") ||
        u.includes("/responses") ||
        u.endsWith("/embeddings")
      ) {
        calls.push(u.endsWith("/embeddings") ? "embedding" : "model");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: 'Hello!\n{"needs_owner": false}' } }],
            data: [{ embedding: [0.1] }],
          }),
        );
      }
      return w.fetchStub(url, init);
    });
    process.env["LOVABLE_API_KEY"] = "test-key";
    const { processWebhookPayload } = await import("./whatsapp-webhook.server");
    await processWebhookPayload(w.supabase, `ev-${Math.random()}`, inboundPayload(msg));
    const sentTexts = w.graphSends.map((s) => JSON.stringify(s.body));
    return { w, issued, calls, sentTexts };
  }
  const TEXT = (body: string, id = "wamid.15c") => ({ id, type: "text", text: { body } });

  it("a waiting flow still wins: it answers, and the AI's set-up is never even read", async () => {
    const r = await deliver(
      {
        id: "wamid.tap",
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } },
        context: { id: "wamid.prompt" },
      },
      { waitingRun: true, override: AI_ON() },
    );
    expect(r.sentTexts.join("\n")).toMatch(/Browse our latest picks/);
    expect(r.issued.some((q) => q.table === "ai_agents")).toBe(false);
    expect(r.calls).toEqual([]);
  }, 20_000);

  it("a keyword trigger still wins over Aiden", async () => {
    const r = await deliver(TEXT("menu", "wamid.kw"), { override: AI_ON() });
    expect(r.sentTexts.join("\n")).toMatch(/How can we help/);
    expect(r.calls).toEqual([]);
  }, 20_000);

  it("needs_human silences Aiden: no material read, no search, no model call, nothing sent", async () => {
    const r = await deliver(TEXT("earrings dikhao"), { override: AI_ON({ needs_human: true }) });
    expect(r.calls).toEqual([]);
    expect(r.issued.some((q) => q.table === "activity_log")).toBe(false);
    expect(r.w.graphSends).toEqual([]);
  }, 20_000);

  it("assigned_to silences Aiden the same way", async () => {
    const r = await deliver(TEXT("earrings dikhao"), {
      override: AI_ON({ assigned_to: "user-1" }),
    });
    expect(r.calls).toEqual([]);
    expect(r.w.graphSends).toEqual([]);
  }, 20_000);

  it("something already replied (an automation): Aiden doesn't", async () => {
    const r = await deliver(TEXT("earrings dikhao"), {
      override: (op) => {
        if (
          op.table === "messages" &&
          op.kind === "select" &&
          (op.select?.[1] as { head?: boolean } | undefined)?.head
        )
          return { data: null, error: null, count: 1 };
        return AI_ON()(op);
      },
    });
    expect(r.calls).toEqual([]);
    expect(r.w.graphSends).toEqual([]);
  }, 20_000);

  it("an opted-out contact: the AI's set-up is never read", async () => {
    const r = await deliver(TEXT("earrings dikhao"), {
      override: (op) => {
        if (op.table === "contacts" && op.kind === "upsert")
          return {
            data: { id: "c1", opt_in_status: "opted_out", created_at: "2020-01-01T00:00:00Z" },
            error: null,
          };
        return AI_ON()(op);
      },
    });
    expect(r.issued.some((q) => q.table === "ai_agents")).toBe(false);
    expect(r.calls).toEqual([]);
  }, 20_000);

  it("a text superseded by a later one in the burst stands down (burst coalescing unchanged)", async () => {
    const r = await deliver(TEXT("earrings"), {
      override: (op) => {
        if (
          op.table === "messages" &&
          op.kind === "select" &&
          String(op.select?.[0]).includes("direction, body")
        )
          return {
            data: [
              { id: "m-in", direction: "inbound", body: "earrings" },
              { id: "m-later", direction: "inbound", body: "earrings dikhao" },
            ],
            error: null,
          };
        return AI_ON()(op);
      },
    });
    expect(r.calls).toEqual([]);
    expect(r.w.graphSends).toEqual([]);
  }, 20_000);

  it("when Aiden answers: the agent's set-up is read before automations finish, and automations' reads go out with the message write", async () => {
    const r = await deliver(TEXT("who are you?"), { override: AI_ON() });
    expect(r.calls).toContain("model");
    const at = (pred: (q: { table: string; kind: string; columns: string }) => boolean) =>
      r.issued.findIndex(pred);
    const agentSetup = at((q) => q.table === "ai_agents");
    const repliedCount = at(
      (q) => q.table === "messages" && q.kind === "select" && q.columns === "id",
    );
    const automations = at((q) => q.table === "automations");
    const windowWrite = at((q) => q.table === "conversations" && q.kind === "update");
    expect(agentSetup).toBeGreaterThanOrEqual(0);
    expect(agentSetup).toBeLessThan(repliedCount);
    expect(automations).toBeGreaterThanOrEqual(0);
    expect(automations).toBeLessThan(windowWrite);
  }, 20_000);

  it("a duplicate delivery never reaches Aiden (idempotency unchanged)", async () => {
    const w = latencyWorld({
      org: "o15c-dup",
      rttMs: 1,
      graphMs: 0,
      waitingRun: false,
      duplicate: true,
      override: AI_ON(),
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("/chat/completions")) calls.push("model");
      return w.fetchStub(url, init);
    });
    const { processWebhookPayload } = await import("./whatsapp-webhook.server");
    await processWebhookPayload(w.supabase, "ev-dup-15c", inboundPayload(TEXT("earrings dikhao")));
    expect(calls).toEqual([]);
    expect(w.graphSends).toEqual([]);
  }, 20_000);
});

// ------------------------------------------------------------------- (4a)
describe("(4a) a code-titled product's readable name", () => {
  it("ZERN-0207: the description names the Ruby & Diamond earrings; its Metal line only says Gold, Diamond", async () => {
    const { readableName, productFacts } = await import("./product-facts");
    const zern207 = PRODUCTS.find((p) => p["sku"] === "ZERN-0207")!;
    expect(readableName(zern207)).toBe("Zoori Ruby & Diamond Gold Earrings");
    expect(productFacts(zern207)["name"]).toBe("Zoori Ruby & Diamond Gold Earrings");
  });

  it("the first line wins when it says more than the description's phrase (ZERN-0188), or there is no phrase", async () => {
    const { readableName } = await import("./product-facts");
    // Batch 20: the line's own words in its own order, the shop's category
    // in the singular — no list of metals, stones or product kinds.
    expect(readableName(PRODUCTS.find((p) => p["sku"] === "ZERN-0188")!)).toBe(
      "Gold, Diamond & Pink Sapphire Pear Earring",
    );
    expect(readableName(PRODUCTS.find((p) => p["sku"] === "ZTNM-0030")!)).toBe(
      "Gold, Blue Sap Round & Diamond Tanmaniya",
    );
    expect(
      readableName({ category: "rings", description: "Metal: Gold, Diamond. A lovely piece." }),
    ).toBe("Gold & Diamond Ring");
    // Any business: an apparel shop's coded T-shirt.
    expect(readableName({ category: "T-Shirts", description: "Material: Organic cotton. Fit: Regular." })).toBe(
      "Organic Cotton T-Shirt",
    );
  });

  it("generic: no list of stones in the rule — any business's own words", async () => {
    const { readableName } = await import("./product-facts");
    // The phrase repeats the line's materials and adds its own ("Moonstone"): it wins.
    expect(
      readableName({
        category: "pendants",
        description: "Metal: Silver. Meet the Moonstone Silver Pendant, hand-made.",
      }),
    ).toBe("Moonstone Silver Pendant");
    // A phrase that drops a material the line names: the line wins.
    expect(
      readableName({
        category: "pendants",
        description: "Metal: Silver, Opal. Meet the Moonstone Pendant, hand-made.",
      }),
    ).toBe("Silver & Opal Pendant");
  });
});

// ------------------------------------------------------------------- (4b)
describe("(4b) no automatic website re-read unless platform_settings says so", () => {
  it("missing column, failed read or false: off", async () => {
    const { loadKnowledgeAutoRefresh } = await import("./reading.server");
    const db = (reply: { data: unknown; error: unknown }) =>
      ({
        from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => reply }) }) }),
      }) as never;
    expect(
      await loadKnowledgeAutoRefresh(
        db({ data: null, error: { message: 'column "knowledge_auto_refresh" does not exist' } }),
      ),
    ).toBe(false);
    expect(
      await loadKnowledgeAutoRefresh(db({ data: { knowledge_auto_refresh: false }, error: null })),
    ).toBe(false);
    expect(await loadKnowledgeAutoRefresh(db({ data: null, error: null }))).toBe(false);
    expect(
      await loadKnowledgeAutoRefresh(db({ data: { knowledge_auto_refresh: true }, error: null })),
    ).toBe(true);
  });

  it("the scheduled refresh endpoint does nothing while it is off", async () => {
    process.env["CRON_SECRET"] = "s";
    const queried: string[] = [];
    vi.doMock("@/lib/whatsapp-webhook.server", () => ({
      getServiceClient: () => ({
        from: (t: string) => {
          queried.push(t);
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { knowledge_auto_refresh: false }, error: null }),
              }),
            }),
          };
        },
      }),
    }));
    const { Route } = await import("../routes/api/internal/knowledge-refresh");
    const post = (
      Route.options as unknown as {
        server: { handlers: { POST: (a: { request: Request }) => Promise<Response> } };
      }
    ).server.handlers.POST;
    const res = await post({
      request: new Request("https://x/api/internal/knowledge-refresh", {
        method: "POST",
        headers: { "x-cron-secret": "s" },
      }),
    });
    const body = (await res.json()) as Record<string, unknown>;
    vi.doUnmock("@/lib/whatsapp-webhook.server");
    expect(body).toMatchObject({ skipped: "auto_refresh_off", queued: 0, refreshed: 0 });
    // Only the setting was read: no source was looked at, none queued.
    expect(queried).toEqual(["platform_settings"]);
  });

  it("the merchant screen only promises a refresh while it is on; the migration adds one column, default off", () => {
    const api = readFileSync("src/routes/api/ai/knowledge.ts", "utf8");
    // Batch 16: and only on a paid plan (trials re-read only when asked).
    expect(api).toMatch(/refresh_days: autoRefresh && plan\.paid \?/);
    const screen = readFileSync("src/components/employee/knowledge-manager.tsx", "utf8");
    expect(screen).toMatch(/r\.auto_refresh !== false && r\.refresh_days > 0/);
    const sql = readFileSync(
      "supabase/aidwar-migrations/20261022_knowledge_auto_refresh.sql",
      "utf8",
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS knowledge_auto_refresh boolean NOT NULL DEFAULT false/,
    );
    expect(sql.replace(/--.*$/gm, "").match(/;/g)).toHaveLength(1);
  });
});
