import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp, type FakeRpc } from "./test-support/fake-db";
import { inboundPayload, latencyWorld } from "./test-support/latency-world";

/**
 * Batch 10B — resilience.
 *  (1) AI backup provider: on a credit/quota/5xx/unreachable primary, a run
 *      continues on Anthropic (ANTHROPIC_API_KEY) and/or OpenAI
 *      (OPENAI_API_KEY) with the same prompt, tools and guards; ai_runs records
 *      who answered (provider/model + metadata.provider) and the cost. No
 *      backup key → exactly as before. Embeddings fall back only to OpenAI's
 *      own text-embedding-3-small (same vector space).
 *  (2) Alerts: credit/quota trouble or a backup answering → one activity_log
 *      row + one admin WhatsApp notice per hour; /admin shows a banner.
 *  (3) Security advisor migration (file only; applied by hand).
 *  (4) Speed: the number lookup runs during the event store; COD reads stay
 *      off the reply path when the text can't be a COD answer.
 *
 * Harness (one query = one round trip, six connections, warm, measured from
 * the moment Meta's POST arrives to the first WhatsApp send):
 *                            before   after
 *   button tap → reply       6.1      5.1 RTT
 *   keyword → first prompt   7.2      6.1 RTT
 * Per stage (RTT):  store+number 2 → 1 (overlapped) · contact 1 · message 1 ·
 * guards 0 · flow_routed 1 (tap) / 2 (keyword) · send_start 1 — the last two
 * are inside the flow engine and unchanged here.
 */

vi.mock("@/lib/ai-tools.server", async (importOriginal) => {
  const real = await importOriginal<typeof import("./ai-tools.server")>();
  const tool = {
    name: "catalog_search",
    description: "browse",
    parameters: {
      type: "object",
      properties: { category: { type: "string" } },
      required: [],
      additionalProperties: false,
    },
    feature: "catalog",
    access: "read",
  };
  return {
    ...real,
    brokerTools: async () => [tool],
    invokeTool: async (_ctx: unknown, name: string, args: Record<string, unknown>) => {
      toolRuns.push(name);
      return {
        ok: true,
        found: true,
        data: [{ title: "Petal Band", price: 16805 }],
        latencyMs: 1,
        activityLogId: null,
        arguments: args,
        resultSummary: {},
      };
    },
  };
});
const toolRuns: string[] = [];

import { embedTexts, executeRun, ANSWER_POLICY } from "./ai-run.server";
import {
  BACKUP_RATES_INR,
  ProviderHttpError,
  ProviderStreamCut,
  backupRoutes,
  outageOf,
  reportProviderTrouble,
  resetProviderAlertThrottle,
  safeToolId,
} from "./ai-fallback.server";
import { activeProviderAlert, PROVIDER_ALERT_FRESH_MS } from "./ai-provider-alert";
import { BILLING_TEMPLATES, drainBillingNotifications } from "./billing-notify.server";
import { transcribeAudio } from "./ai-media.server";
import { acceptWebhook, processWebhookPayload } from "./whatsapp-webhook.server";

const ENV_KEYS = [
  "LOVABLE_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "AI_BACKUP_ORDER",
  "ANTHROPIC_BACKUP_MODEL",
  "OPENAI_BACKUP_MODEL",
  "PLATFORM_ORG_ID",
  "BILLING_ADMIN_WHATSAPP",
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["LOVABLE_API_KEY"] = "gateway-key";
  resetProviderAlertThrottle();
  toolRuns.length = 0;
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------ AI harness

function aiWorld(opts: { byoa?: boolean; recentAlert?: boolean } = {}) {
  return fakeDb(
    (op: FakeOp) => {
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
          data: { ai_monthly_cap_amount: 100000, ai_cap_currency: "INR", ai_markup_multiplier: 3 },
          error: null,
        };
      if (op.table === "ai_tiers")
        return {
          data: {
            key: "everyday",
            display_name: "Everyday",
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
      if (op.table === "ai_providers" && opts.byoa)
        return {
          data: { vault_secret_name: "own", provider: "lovable", model: null },
          error: null,
        };
      if (op.table === "products" && op.kind === "select")
        return { data: null, error: null, count: 0 } as never;
      if (op.table === "ai_runs" && op.kind === "insert")
        return { data: { id: "run-1" }, error: null };
      if (op.table === "activity_log" && op.kind === "select")
        return { data: opts.recentAlert ? [{ id: "a1" }] : [], error: null };
      return undefined;
    },
    (call: FakeRpc) => {
      if (call.name === "match_knowledge_chunks")
        return {
          data: [
            {
              document_id: "d1",
              source_type: "website",
              source_name: "site",
              source_ref: "https://x/faq",
              title: "Rings",
              text: "The Petal Band is a gold ring.",
              similarity: 0.5,
            },
          ],
          error: null,
        };
      if (call.name === "ai_month_spend" || call.name === "platform_ai_month_spend")
        return { data: 0, error: null };
      if (call.name === "record_ai_tool_calls")
        return { data: (call.args["p_calls"] as unknown[]).length, error: null };
      if (call.name === "read_vault_secret") return { data: "own-key", error: null };
      return undefined;
    },
  );
}

type Seen = { url: string; body: Record<string, unknown>; headers: Record<string, string> };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const anthropicMessage = (
  content: unknown[],
  usage = { input_tokens: 1000, output_tokens: 100 },
  stop = "end_turn",
) =>
  json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage,
  });
const openAiStream = (text: string) =>
  new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
        usage: { input_tokens: 800, output_tokens: 60 },
      },
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

/** Routes each request by host; records them all. */
function stubProviders(handlers: {
  gateway?: (body: Record<string, unknown>, n: number) => Response;
  anthropic?: (body: Record<string, unknown>, n: number) => Response;
  openai?: (body: Record<string, unknown>, n: number, url: string) => Response;
}) {
  const seen: Seen[] = [];
  const count = { gateway: 0, anthropic: 0, openai: 0 };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = init?.body ?? (input instanceof Request ? await input.text() : "{}");
    const body =
      typeof raw === "string" && raw.startsWith("{")
        ? (JSON.parse(raw) as Record<string, unknown>)
        : {};
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).forEach(
      (v, k) => (headers[k] = v),
    );
    seen.push({ url, body, headers });
    if (url.endsWith("/embeddings") && url.includes("gateway"))
      return json({ data: [{ embedding: [0.1, 0.2] }] });
    if (url.includes("ai.gateway.lovable.dev"))
      return handlers.gateway
        ? handlers.gateway(body, count.gateway++)
        : json({ choices: [{ message: { content: "gateway answer" } }] });
    if (url.includes("api.anthropic.com"))
      return handlers.anthropic ? handlers.anthropic(body, count.anthropic++) : json({}, 500);
    if (url.includes("api.openai.com"))
      return handlers.openai ? handlers.openai(body, count.openai++, url) : json({}, 500);
    return json({});
  });
  return { seen, count };
}

const run = (
  db: ReturnType<typeof aiWorld>,
  input = "Is the Petal Band gold?",
  extra: Partial<Parameters<typeof executeRun>[1]> = {},
) =>
  executeRun(db.supabase, {
    organizationId: "org",
    task: "agent_reply",
    tier: "everyday",
    conversationId: "conv-1",
    contactId: "c1",
    input,
    system: "You answer on behalf of this business.",
    useKnowledge: true,
    ...extra,
  });
const runRow = (db: ReturnType<typeof aiWorld>) =>
  db.ops.find((o) => o.table === "ai_runs" && o.kind === "insert")!.payload as Record<
    string,
    unknown
  > & { metadata: Record<string, unknown> };
const CREDIT_402 = () => json({ error: { message: "Payment required: out of credits" } }, 402);

// ------------------------------------------------------------------ (1)
describe("(1) no backup key: exactly as before", () => {
  it("a 402 is the same error, only the gateway is called, the row says lovable", async () => {
    const db = aiWorld();
    const { seen } = stubProviders({ gateway: CREDIT_402 });
    const out = await run(db);
    expect(out.status).toBe("error");
    expect(out.error).toBe("This workspace has run out of AI credit.");
    expect(seen.some((s) => s.url.includes("anthropic") || s.url.includes("openai.com"))).toBe(
      false,
    );
    const row = runRow(db);
    expect(row["provider"]).toBe("lovable");
    expect(row.metadata["provider"]).toBe("lovable");
    expect(row.metadata["fallback"]).toBeUndefined();
  });

  it("a normal answer is unchanged and records metadata.provider", async () => {
    const db = aiWorld();
    stubProviders({
      gateway: () =>
        json({
          choices: [{ message: { content: "Yes, it is a gold ring." } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
    });
    const out = await run(db);
    expect(out.status).toBe("ok");
    expect(out.output).toBe("Yes, it is a gold ring.");
    expect(out.provider).toBe("lovable");
    expect(runRow(db).metadata["provider"]).toBe("lovable");
  });

  it("no gateway key and no backup: the same 'no working connection' error, nothing called", async () => {
    delete process.env["LOVABLE_API_KEY"];
    const db = aiWorld();
    const { seen } = stubProviders({});
    const out = await run(db);
    expect(out.status).toBe("error");
    expect(out.error).toMatch(/has no working connection behind it/);
    expect(seen).toHaveLength(0);
  });
});

describe("(1) Anthropic backup", () => {
  beforeEach(() => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
  });

  it("out of credit → the same prompt, policy and tools go to Claude; the row records anthropic and its cost", async () => {
    const db = aiWorld();
    const { seen } = stubProviders({
      gateway: CREDIT_402,
      anthropic: () =>
        anthropicMessage([{ type: "text", text: "Yes, the Petal Band is a gold ring." }]),
    });
    const out = await run(db, "Is the Petal Band gold?", { useTools: true });
    expect(out.status).toBe("ok");
    expect(out.output).toBe("Yes, the Petal Band is a gold ring.");
    expect(out.provider).toBe("anthropic");
    expect(out.model).toBe("claude-opus-5-5");

    const call = seen.find((s) => s.url.includes("api.anthropic.com"))!;
    expect(call.url).toMatch(/\/v1\/messages/);
    expect(call.headers["x-api-key"]).toBe("sk-ant-test");
    expect(call.body["model"]).toBe("claude-opus-5-5");
    // The same system prompt the gateway got: material + answer policy.
    const gatewaySystem = String(
      (seen[1]!.body["messages"] as Array<{ content: unknown }>)[0]!.content,
    );
    expect(call.body["system"]).toBe(gatewaySystem);
    expect(String(call.body["system"])).toContain(ANSWER_POLICY);
    expect(String(call.body["system"])).toContain("The Petal Band is a gold ring.");
    expect((call.body["tools"] as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "catalog_search",
    ]);
    expect(call.body["messages"]).toEqual([{ role: "user", content: "Is the Petal Band gold?" }]);
    // Refusal fallback stays on (server-side), effort kept low for chat.
    expect(call.body["fallbacks"]).toBe("default");
    expect(call.headers["anthropic-beta"]).toContain("server-side-fallback-2026-07-01");
    expect(call.body["output_config"]).toEqual({ effort: "low" });

    const row = runRow(db);
    expect(row["provider"]).toBe("anthropic");
    expect(row["model"]).toBe("claude-opus-5-5");
    expect(row.metadata["provider"]).toBe("anthropic");
    expect(row.metadata["fallback"]).toMatchObject({
      from_provider: "lovable",
      from_model: "google/gemini-3.6-flash",
      reason: "credit",
      status: 402,
    });
    const rate = BACKUP_RATES_INR["anthropic:claude-opus-5-5"]!;
    const cost = (1000 * rate.input + 100 * rate.output) / 1e6;
    expect(row["cost_amount"]).toBeCloseTo(cost, 6);
    expect(row["cost_source"]).toBe("rate_card");
    expect(row["billed_amount"]).toBeCloseTo(cost * 3, 6);
    expect(row["input_tokens"]).toBe(1000);
  });

  it("the guards still run on the backup's answer (a price the material never gave is removed)", async () => {
    const db = aiWorld();
    stubProviders({
      gateway: () => json({ error: "upstream" }, 503),
      anthropic: () =>
        anthropicMessage([{ type: "text", text: "The Petal Band is a gold ring. It costs ₹999." }]),
    });
    const out = await run(db, "Tell me about the Petal Band");
    expect(out.provider).toBe("anthropic");
    expect(out.output).not.toContain("999");
    expect(out.needsOwner || out.status === "escalated").toBe(true);
  });

  it("a failure mid-way keeps the tool results: Claude gets the tool_use/tool_result turn, the tool never runs twice", async () => {
    const db = aiWorld();
    const { seen } = stubProviders({
      gateway: (_b, n) =>
        n === 0
          ? json({
              choices: [
                {
                  message: {
                    content: "",
                    tool_calls: [
                      {
                        id: "call:1",
                        type: "function",
                        function: { name: "catalog_search", arguments: '{"category":"rings"}' },
                      },
                    ],
                  },
                },
              ],
            })
          : json({ error: { message: "quota exceeded for this key" } }, 429),
      anthropic: () =>
        anthropicMessage([{ type: "text", text: "We have the Petal Band in gold." }]),
    });
    const out = await run(db, "Show me rings", { useTools: true });
    expect(out.status).toBe("ok");
    expect(out.output).toBe("We have the Petal Band in gold.");
    expect(toolRuns).toEqual(["catalog_search"]);
    expect(out.toolCalls).toHaveLength(1);
    const call = seen.find((s) => s.url.includes("api.anthropic.com"))!;
    const msgs = call.body["messages"] as Array<{ role: string; content: unknown }>;
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: safeToolId("call:1", 0),
          name: "catalog_search",
          input: { category: "rings" },
        },
      ],
    });
    expect(msgs[2]!.role).toBe("user");
    expect((msgs[2]!.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "call_1",
    });
    expect(runRow(db).metadata["fallback"]).toMatchObject({ reason: "credit", status: 429 });
  });

  it("Claude asking for a tool: it runs, and its result goes back as a tool_result", async () => {
    const db = aiWorld();
    const { seen } = stubProviders({
      gateway: CREDIT_402,
      anthropic: (_b, n) =>
        n === 0
          ? anthropicMessage(
              [
                {
                  type: "tool_use",
                  id: "toolu_1",
                  name: "catalog_search",
                  input: { category: "rings" },
                },
              ],
              undefined,
              "tool_use",
            )
          : anthropicMessage([{ type: "text", text: "The Petal Band is in stock." }]),
    });
    const out = await run(db, "Any rings?", { useTools: true });
    expect(out.output).toBe("The Petal Band is in stock.");
    expect(toolRuns).toEqual(["catalog_search"]);
    const second = seen.filter((s) => s.url.includes("api.anthropic.com"))[1]!;
    const msgs = second.body["messages"] as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(msgs.at(-1)!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1" });
    expect(runRow(db)["input_tokens"]).toBe(2000);
  });

  it("not an outage (a bad request) → no fallback, the error as before", async () => {
    const db = aiWorld();
    const { seen } = stubProviders({ gateway: () => json({ error: "bad" }, 400) });
    const out = await run(db);
    expect(out.status).toBe("error");
    expect(seen.some((s) => s.url.includes("anthropic"))).toBe(false);
    expect(runRow(db).metadata["fallback"]).toBeUndefined();
  });

  it("a workspace on its own account (BYOA) never falls back onto the platform's backup", async () => {
    const db = aiWorld({ byoa: true });
    const { seen } = stubProviders({ gateway: CREDIT_402 });
    const out = await run(db);
    expect(out.status).toBe("error");
    expect(seen.some((s) => s.url.includes("anthropic"))).toBe(false);
  });

  it("no gateway key: the backup answers", async () => {
    delete process.env["LOVABLE_API_KEY"];
    const db = aiWorld();
    stubProviders({
      anthropic: () => anthropicMessage([{ type: "text", text: "Yes, it is gold." }]),
    });
    const out = await run(db, "Is it gold?", { useKnowledge: false });
    expect(out.status).toBe("ok");
    expect(out.provider).toBe("anthropic");
    expect(runRow(db).metadata["fallback"]).toMatchObject({ reason: "no_key" });
  });

  it("a picture is sent to Claude as an image block", async () => {
    const db = aiWorld();
    const { seen } = stubProviders({
      gateway: CREDIT_402,
      anthropic: () => anthropicMessage([{ type: "text", text: "A gold ring." }]),
    });
    await run(db, "Describe this picture.", {
      useKnowledge: false,
      imageDataUrl: "data:image/png;base64,AAAA",
      billingExempt: true,
      metadata: { purpose: "customer_image" },
    });
    const call = seen.find((s) => s.url.includes("api.anthropic.com"))!;
    const content = (
      call.body["messages"] as Array<{ content: Array<Record<string, unknown>> }>
    )[0]!.content;
    expect(content[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAAA" },
    });
  });
});

describe("(1) OpenAI backup, and the order between backups", () => {
  it("only OPENAI_API_KEY: a 503 goes to OpenAI's Responses API (gpt-5.4-mini for everyday)", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    const db = aiWorld();
    const { seen } = stubProviders({
      gateway: () => json({ error: "down" }, 503),
      openai: () => openAiStream("Yes, it is a gold ring."),
    });
    const out = await run(db);
    expect(out.output).toBe("Yes, it is a gold ring.");
    expect(out.provider).toBe("openai");
    const call = seen.find((s) => s.url.includes("api.openai.com"))!;
    expect(call.url).toBe("https://api.openai.com/v1/responses");
    expect(call.body["model"]).toBe("gpt-5.4-mini");
    expect(call.headers["authorization"]).toBe("Bearer sk-openai");
    const row = runRow(db);
    expect(row.metadata["fallback"]).toMatchObject({ reason: "server", status: 503 });
    const rate = BACKUP_RATES_INR["openai:gpt-5.4-mini"]!;
    expect(row["cost_amount"]).toBeCloseTo((800 * rate.input + 60 * rate.output) / 1e6, 6);
  });

  it("Claude overloaded too → OpenAI answers; both attempts are on the row", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant";
    process.env["OPENAI_API_KEY"] = "sk-openai";
    const db = aiWorld();
    stubProviders({
      gateway: CREDIT_402,
      anthropic: () =>
        json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, 529, {
          "retry-after-ms": "1",
        }),
      openai: () => openAiStream("Gold, yes."),
    });
    const out = await run(db);
    expect(out.provider).toBe("openai");
    expect((runRow(db).metadata["fallback"] as { attempts: unknown[] }).attempts).toEqual([
      { provider: "anthropic", model: "claude-opus-5-5", ok: false, kind: "server" },
      { provider: "openai", model: "gpt-5.4-mini", ok: true },
    ]);
  });

  it("every backup down → the error is returned, the run is still recorded", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    const db = aiWorld();
    stubProviders({
      gateway: CREDIT_402,
      openai: () => json({ error: { message: "insufficient_quota" } }, 429),
    });
    const out = await run(db);
    expect(out.status).toBe("error");
    expect(runRow(db)["status"]).toBe("error");
  });

  it("backupRoutes: order, keys and model overrides", () => {
    expect(backupRoutes("everyday", {})).toEqual([]);
    expect(
      backupRoutes("careful", { OPENAI_API_KEY: "o", ANTHROPIC_API_KEY: "a" }).map(
        (r) => `${r.provider}:${r.model}`,
      ),
    ).toEqual(["anthropic:claude-opus-5-5", "openai:gpt-5.4"]);
    expect(
      backupRoutes("everyday", {
        OPENAI_API_KEY: "o",
        ANTHROPIC_API_KEY: "a",
        AI_BACKUP_ORDER: "openai,anthropic",
        ANTHROPIC_BACKUP_MODEL: "claude-sonnet-5-5",
      }).map((r) => `${r.provider}:${r.model}`),
    ).toEqual(["openai:gpt-5.4-mini", "anthropic:claude-sonnet-5-5"]);
  });

  it("outageOf: credit, quota, 5xx, cut streams and network errors qualify; client errors don't", () => {
    expect(outageOf(new ProviderHttpError("x", 402, ""))).toEqual({ kind: "credit", status: 402 });
    expect(outageOf(new ProviderHttpError("x", 403, '{"type":"credit_limit"}'))).toEqual({
      kind: "credit",
      status: 403,
    });
    expect(outageOf(new ProviderHttpError("x", 403, "forbidden"))).toBeNull();
    expect(outageOf(new ProviderHttpError("x", 429, "insufficient_quota"))).toEqual({
      kind: "credit",
      status: 429,
    });
    expect(outageOf(new ProviderHttpError("x", 429, "slow down"))).toEqual({
      kind: "rate_limit",
      status: 429,
    });
    expect(outageOf(new ProviderHttpError("x", 502, ""))).toEqual({ kind: "server", status: 502 });
    expect(outageOf(new ProviderHttpError("x", 400, ""))).toBeNull();
    expect(outageOf(new ProviderHttpError("x", 401, ""))).toBeNull();
    expect(outageOf(new ProviderStreamCut())).toEqual({ kind: "server", status: null });
    expect(outageOf(new TypeError("fetch failed"))).toEqual({ kind: "network", status: null });
    expect(outageOf(new Error("anything else"))).toBeNull();
    // The words a merchant sees are unchanged.
    expect(new ProviderStreamCut().message).toBe("The AI stopped before it finished answering.");
  });
});

describe("(1) embeddings stay in the same vector space", () => {
  it("gateway out of credit + OPENAI_API_KEY → OpenAI's own text-embedding-3-small", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push(`${url} ${JSON.parse(String(init.body)).model}`);
      if (url.includes("gateway")) return json({ error: "credits" }, 402);
      return json({ data: [{ embedding: [0.5] }] });
    });
    expect(await embedTexts(["hello"])).toEqual([[0.5]]);
    expect(seen).toEqual([
      "https://ai.gateway.lovable.dev/v1/embeddings openai/text-embedding-3-small",
      "https://api.openai.com/v1/embeddings text-embedding-3-small",
    ]);
  });

  it("only ANTHROPIC_API_KEY (no embeddings there): the gateway's error, as before", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant";
    vi.stubGlobal("fetch", async () => json({ error: "credits" }, 402));
    await expect(embedTexts(["hello"])).rejects.toThrow("This workspace has run out of AI credit.");
  });

  it("unchanged: a healthy gateway is the only call; a bad request is never retried elsewhere", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return url.includes("gateway") && urls.length > 1
        ? json({ error: "bad" }, 400)
        : json({ data: [{ embedding: [1] }] });
    });
    await embedTexts(["a"]);
    await expect(embedTexts(["b"])).rejects.toThrow();
    expect(urls.every((u) => u.includes("gateway"))).toBe(true);
  });
});

describe("(1) voice notes", () => {
  it("the gateway failing → the OPENAI_API_KEY transcription is tried last", async () => {
    process.env["OPENAI_API_KEY"] = "sk-openai";
    const db = fakeDb(() => undefined);
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return url.includes("gateway")
        ? json({ error: "credits" }, 402)
        : json({ text: "hello there" });
    });
    const out = await transcribeAudio(db.supabase, "org", new Uint8Array([1, 2]), "audio/ogg");
    expect(out.text).toBe("hello there");
    expect(urls).toEqual([
      "https://ai.gateway.lovable.dev/v1/audio/transcriptions",
      "https://api.openai.com/v1/audio/transcriptions",
    ]);
  });

  it("unchanged without the key: only the gateway, and its error", async () => {
    const db = fakeDb(() => undefined);
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return json({ error: "credits" }, 402);
    });
    const out = await transcribeAudio(db.supabase, "org", new Uint8Array([1]), "audio/ogg");
    expect(out.text).toBeNull();
    expect(urls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ (2)
describe("(2) the platform owner is told, at most once an hour", () => {
  const inserts = (db: ReturnType<typeof aiWorld>, table: string) =>
    db.ops.filter((o) => o.table === table && o.kind === "insert");

  it("out of credit with no backup: one activity row + one admin WhatsApp notice; the next failure adds none", async () => {
    const db = aiWorld();
    stubProviders({ gateway: CREDIT_402 });
    await run(db);
    await run(db);
    const activity = inserts(db, "activity_log");
    expect(activity).toHaveLength(1);
    expect(activity[0]!.payload).toMatchObject({
      organization_id: null,
      action: "ai_provider_alert",
      details: {
        provider: "lovable",
        kind: "credit",
        status: 402,
        served_by: null,
        backup_configured: false,
        headline: "Lovable AI gateway is out of credit or quota",
      },
    });
    const notice = inserts(db, "billing_notifications");
    expect(notice).toHaveLength(1);
    expect(notice[0]!.payload).toMatchObject({
      audience: "admin",
      kind: "ai_provider_alert",
      channel: "whatsapp",
      organization_id: null,
    });
  });

  it("a backup answering raises it too (with who answered)", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant";
    const db = aiWorld();
    stubProviders({
      gateway: () => json({ error: "down" }, 500),
      anthropic: () => anthropicMessage([{ type: "text", text: "Gold." }]),
    });
    await run(db);
    expect(inserts(db, "activity_log")[0]!.payload).toMatchObject({
      details: {
        served_by: "anthropic",
        kind: "server",
        detail: "Aiden is answering on the anthropic backup",
      },
    });
  });

  it("a plain rate limit with no backup is not an alert (it passes on its own)", async () => {
    const db = aiWorld();
    stubProviders({ gateway: () => json({ error: "slow down" }, 429) });
    await run(db);
    expect(inserts(db, "activity_log")).toHaveLength(0);
  });

  it("another server already raised it this hour → nothing new", async () => {
    const db = aiWorld({ recentAlert: true });
    expect(
      await reportProviderTrouble(db.supabase, {
        provider: "lovable",
        model: "m",
        outage: { kind: "credit", status: 402 },
        servedBy: null,
        backupConfigured: false,
        task: "agent_reply",
        organizationId: "org",
        error: "x",
      }),
    ).toBe(false);
    expect(inserts(db, "activity_log")).toHaveLength(0);
  });

  it("the banner shows the latest alert for 90 minutes, then clears itself", () => {
    const row = { created_at: new Date(1_000_000).toISOString(), details: { headline: "h" } };
    expect(activeProviderAlert([row], 1_000_000 + 60_000)).toBe(row);
    expect(activeProviderAlert([row], 1_000_000 + PROVIDER_ALERT_FRESH_MS + 1)).toBeNull();
    expect(activeProviderAlert([], 1_000_000)).toBeNull();
  });

  it("the WhatsApp notice goes to BILLING_ADMIN_WHATSAPP as the admin_ai_provider_alert template", async () => {
    process.env["PLATFORM_ORG_ID"] = "plat";
    process.env["BILLING_ADMIN_WHATSAPP"] = "+919811111111";
    const spec = BILLING_TEMPLATES.find((t) => t.name === "admin_ai_provider_alert")!;
    // Meta rejects a body that starts or ends with a variable.
    expect(spec.body.trim().startsWith("{{")).toBe(false);
    expect(spec.body.trim().endsWith("}}")).toBe(false);
    const db = fakeDb((op) => {
      if (op.table === "billing_notifications" && op.kind === "select")
        return {
          data: [
            {
              id: "n1",
              organization_id: null,
              audience: "admin",
              kind: "ai_provider_alert",
              channel: "whatsapp",
              recipient: null,
              status: "queued",
              payload: {
                headline: "Lovable AI gateway is out of credit or quota",
                detail: "no backup key is set, so Aiden replies are failing",
                link: "https://aidwar.in/admin/ai",
              },
            },
          ],
          error: null,
        };
      if (op.table === "whatsapp_accounts")
        return {
          data: [
            {
              id: "acc",
              organization_id: "plat",
              waba_id: "w",
              phone_number_id: "pn",
              display_phone_number: "91",
              status: "active",
              is_default: true,
            },
          ],
          error: null,
        };
      if (op.table === "whatsapp_credentials")
        return { data: { access_token: "tok" }, error: null };
      if (op.table === "contacts") return { data: [], error: null };
      if (op.table === "message_templates")
        return {
          data: { name: "admin_ai_provider_alert", language: "en", status: "APPROVED" },
          error: null,
        };
      return undefined;
    });
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return json({ messages: [{ id: "wamid.1" }] });
    });
    const counts = await drainBillingNotifications(db.supabase);
    expect(counts.sent).toBe(1);
    expect(sent[0]).toMatchObject({
      to: "+919811111111",
      template: {
        name: "admin_ai_provider_alert",
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Lovable AI gateway is out of credit or quota" },
              { type: "text", text: "no backup key is set, so Aiden replies are failing" },
              { type: "text", text: "https://aidwar.in/admin/ai" },
            ],
          },
        ],
      },
    });
  });
});

// ------------------------------------------------------------------ (3)
describe("(3) security advisor migration (file only — applied by hand)", () => {
  const sql = readFileSync(
    new URL("../../supabase/aidwar-migrations/20261014_security_advisor.sql", import.meta.url),
    "utf8",
  );
  const generator = readFileSync(
    new URL("../../scripts/sync-feature-registry.ts", import.meta.url),
    "utf8",
  );

  it("the drift view runs with the reader's rights and is service-role only; guarded for re-runs", () => {
    expect(sql).toContain("ALTER VIEW public.feature_registry_drift SET (security_invoker = true)");
    expect(sql).toContain(
      "REVOKE ALL ON public.feature_registry_drift FROM PUBLIC, anon, authenticated",
    );
    expect(sql).toContain("GRANT SELECT ON public.feature_registry_drift TO service_role");
    expect(sql).toContain("to_regclass('public.feature_registry_drift') IS NOT NULL");
  });

  it("only trigger functions lose anon/authenticated EXECUTE (each checked to return trigger)", () => {
    for (const fn of [
      "trg_ai_agent_mode_guard",
      "trg_ai_runs_welcome_credits",
      "trg_org_defaults_on_insert",
      "trg_org_plan_assigned_before",
      "guard_org_markup",
      "trg_guard_org_privileged_columns",
    ]) {
      expect(sql).toContain(`'${fn}'`);
    }
    expect(sql).toContain("p.prorettype = 'trigger'::regtype");
    expect(sql).toContain(
      "REVOKE EXECUTE ON FUNCTION public.%I() FROM PUBLIC, anon, authenticated",
    );
    // Nothing the app calls: no RPC function is touched, no data is changed.
    const code = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(
      /invitation_preview|has_org_role|is_super_admin|match_knowledge_chunks/,
    );
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE)\s+(INTO|public\.|FROM)/i);
  });

  it("future registry syncs keep the view security_invoker and off the public API", () => {
    expect(generator).toContain(
      "create or replace view public.feature_registry_drift with (security_invoker = true) as",
    );
    expect(generator).not.toContain(
      "grant select on public.feature_registry_drift to authenticated",
    );
  });
});

// ------------------------------------------------------------------ (4)
const RTT = 40;
const GRAPH = 120;
const TAP = {
  id: "wamid.tap",
  type: "interactive",
  interactive: { type: "button_reply", button_reply: { id: "menu:b1", title: "Shop" } },
  context: { id: "wamid.prompt" },
};
const KEYWORD = { id: "wamid.kw", type: "text", text: { body: "menu" } };

async function arrive(
  org: string,
  waitingRun: boolean,
  msg: Record<string, unknown>,
  opts: {
    signatureValid?: boolean;
    payload?: Record<string, unknown>;
    override?: Parameters<typeof latencyWorld>[0]["override"];
  } = {},
) {
  const w = latencyWorld({
    org,
    rttMs: RTT,
    graphMs: GRAPH,
    waitingRun,
    maxConcurrent: 6,
    override: (op) =>
      opts.override?.(op) ??
      (op.table === "webhook_events" && op.kind === "insert"
        ? { data: { id: `ev-${org}`, received_at: new Date().toISOString() }, error: null }
        : undefined),
  });
  vi.stubGlobal("fetch", w.fetchStub);
  w.t0.at = Date.now();
  await acceptWebhook(w.supabase, {
    rawBody: JSON.stringify(opts.payload ?? inboundPayload(msg)),
    signatureValid: opts.signatureValid ?? true,
    waitUntil: null,
  });
  const close = w.ops.find((o) => o.table === "webhook_events" && o.kind === "update")?.payload as
    | { timing?: Record<string, unknown> & { messages?: Array<{ ms: Record<string, number> }> } }
    | undefined;
  return { w, timing: close?.timing };
}

describe("(4) speed: the number is looked up while the event is stored", () => {
  it("warm-up (module loading is not part of any budget)", { timeout: 15_000 }, async () => {
    await arrive("b10-warm", true, TAP);
    await arrive("b10-warm2", false, KEYWORD);
  });

  it("a button tap's reply starts within 5.5 round trips of Meta's POST (before: 6.1)", async () => {
    const { w, timing } = await arrive("b10-tap", true, TAP);
    expect(w.graphSends).toHaveLength(1);
    expect((w.graphSends[0]!.body["text"] as { body: string }).body).toBe(
      "Browse our latest picks on our website.",
    );
    expect(w.graphSends[0]!.at).toBeLessThan(5.5 * RTT);
    expect(timing?.["prefetched"]).toBe(true);
    expect(Number(timing?.["account_ms"])).toBeLessThan(RTT / 2);
  });

  it("a keyword's first prompt starts within 6.5 round trips (before: 7.2)", async () => {
    const { w } = await arrive("b10-kw", false, KEYWORD);
    expect(w.graphSends).toHaveLength(1);
    expect(w.graphSends[0]!.body["type"]).toBe("interactive");
    expect(w.graphSends[0]!.at).toBeLessThan(6.5 * RTT);
  });

  it("the number read starts with the event insert, and is the only number read", async () => {
    const { w } = await arrive("b10-order", true, TAP);
    const insert = w.starts.find((s) => s.table === "webhook_events" && s.kind === "insert")!;
    const account = w.starts.find((s) => s.table === "whatsapp_accounts")!;
    expect(Math.abs(account.at - insert.at)).toBeLessThan(RTT / 2);
    expect(w.ops.filter((o) => o.table === "whatsapp_accounts")).toHaveLength(1);
    // Nothing is written before the event is stored.
    const firstWrite = w.starts.find((s) => s.kind !== "select" && s.table !== "webhook_events");
    expect(firstWrite!.at).toBeGreaterThanOrEqual(insert.at + RTT);
  });

  it("unchanged: an unsigned payload reads nothing early (and isn't processed)", async () => {
    const { w } = await arrive("b10-unsigned", true, TAP, { signatureValid: false });
    expect(w.ops.some((o) => o.table === "whatsapp_accounts")).toBe(false);
    expect(w.graphSends).toHaveLength(0);
  });

  it("unchanged: a status-only payload gets no early reads", async () => {
    const { w } = await arrive("b10-status", false, TAP, {
      payload: {
        entry: [
          {
            id: "waba",
            changes: [
              {
                field: "messages",
                value: {
                  metadata: { phone_number_id: "pn" },
                  statuses: [{ id: "wamid.x", status: "delivered", timestamp: "1" }],
                },
              },
            ],
          },
        ],
      },
    });
    const insert = w.starts.find((s) => s.table === "webhook_events" && s.kind === "insert")!;
    expect(
      w.starts.filter((s) => s.at < insert.at + RTT * 0.75 && s.table !== "webhook_events"),
    ).toHaveLength(0);
  });

  it("an early read that fails falls back to the plain read, and the reply still goes", async () => {
    let first = true;
    const { w } = await arrive("b10-prefail", true, TAP, {
      override: (op) => {
        if (op.table === "whatsapp_accounts" && first) {
          first = false;
          return { data: null, error: { code: "PGRST200", message: "embed failed" } };
        }
        return undefined;
      },
    });
    expect(w.ops.filter((o) => o.table === "whatsapp_accounts")).toHaveLength(2);
    expect(w.graphSends).toHaveLength(1);
  });

  it("unchanged: a redelivered message is never answered twice; STOP still opts out", async () => {
    const dupe = latencyWorld({
      org: "b10-dupe",
      rttMs: RTT,
      graphMs: GRAPH,
      waitingRun: true,
      duplicate: true,
      maxConcurrent: 6,
      override: (op) =>
        op.table === "webhook_events" && op.kind === "insert"
          ? { data: { id: "ev-d", received_at: new Date().toISOString() }, error: null }
          : undefined,
    });
    vi.stubGlobal("fetch", dupe.fetchStub);
    await acceptWebhook(dupe.supabase, {
      rawBody: JSON.stringify(inboundPayload(TAP)),
      signatureValid: true,
      waitUntil: null,
    });
    expect(dupe.graphSends).toHaveLength(0);

    const { w } = await arrive("b10-stop", true, {
      id: "wamid.stop",
      type: "text",
      text: { body: "STOP" },
    });
    expect(w.ops.find((o) => o.table === "contacts" && o.kind === "update")?.payload).toMatchObject(
      { opt_in_status: "opted_out" },
    );
    expect(
      w.ops.some(
        (o) =>
          o.table === "flow_runs" &&
          o.kind === "update" &&
          (o.payload as { status?: string }).status === "running",
      ),
    ).toBe(false);
  });
});

describe("(4) speed: cash-on-delivery reads stay off a reply they can't affect", () => {
  const PENDING = {
    id: "cod-1",
    organization_id: "o",
    order_id: "ord-1",
    contact_id: "c1",
    status: "pending",
    asked_at: new Date().toISOString(),
  };
  const codOverride = (op: FakeOp) =>
    op.table === "cod_confirmations" && op.kind === "select"
      ? { data: { ...PENDING }, error: null }
      : undefined;

  it("'Shop' can't settle an ask: no COD read before the send; the text is still saved on the open ask, after the reply, before the event closes", async () => {
    const { w } = await arrive("b10-cod-text", true, TAP, { override: codOverride });
    expect(w.graphSends).toHaveLength(1);
    const codRead = w.starts.find((s) => s.table === "cod_confirmations" && s.kind === "select")!;
    expect(codRead.at).toBeGreaterThan(w.graphSends[0]!.at);
    const save = w.ops.find((o) => o.table === "cod_confirmations" && o.kind === "update")!;
    expect(save.payload).toEqual({ response_raw: "Shop | menu:b1" });
    const opIndex = (pred: (o: FakeOp) => boolean) => w.ops.findIndex(pred);
    expect(opIndex((o) => o === save)).toBeLessThan(
      opIndex((o) => o.table === "webhook_events" && o.kind === "update"),
    );
  });

  it("unchanged: 'Yes, confirm' still settles the ask before any flow runs, and nothing else replies", async () => {
    const { w } = await arrive(
      "b10-cod-yes",
      true,
      {
        id: "wamid.yes",
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "cod_yes", title: "Yes, confirm" },
        },
      },
      { override: codOverride },
    );
    const settled = w.ops.find(
      (o) =>
        o.table === "cod_confirmations" &&
        o.kind === "update" &&
        (o.payload as { status?: string }).status === "confirmed",
    );
    expect(settled).toBeTruthy();
    expect(w.ops.some((o) => o.table === "flow_runs" && o.kind === "update")).toBe(false);
    expect(w.graphSends).toHaveLength(0);
  });

  it("unchanged: processing without the early reads (reprocess path) still answers", async () => {
    const w = latencyWorld({
      org: "b10-reprocess",
      rttMs: RTT,
      graphMs: GRAPH,
      waitingRun: true,
      maxConcurrent: 6,
    });
    vi.stubGlobal("fetch", w.fetchStub);
    await processWebhookPayload(w.supabase, "ev-r", inboundPayload(TAP), new Date().toISOString());
    expect(w.graphSends).toHaveLength(1);
  });
});
