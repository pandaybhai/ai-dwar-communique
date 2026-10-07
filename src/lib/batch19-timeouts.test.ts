import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp, type FakeRpc } from "./test-support/fake-db";

/**
 * Batch 19 item 5 — every outside call gives up after a set time (one shared
 * helper, outsideFetch, with a default per target) and a timeout is handled
 * like an unreachable host: logged, and for AI calls the existing backup
 * model takes over. Healthy calls are unchanged.
 */

vi.mock("@/lib/ai-tools.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ai-tools.server")>()),
  brokerTools: async () => [],
}));

import { OUTSIDE_CALL_TIMEOUT_MS, OutsideCallTimeout, outsideFetch, type OutsideTarget } from "./outside-call.server";
import { outageOf } from "./ai-fallback.server";
import { embedTexts, executeRun } from "./ai-run.server";
import { fetchMetaMedia, transcribeAudio } from "./ai-media.server";
import { graphFetch } from "./whatsapp-api.server";
import { createPaymentLink } from "./razorpay.server";
import { exchangeGoogleCode, verifyRazorpayKeys } from "./flow-connections.server";
import { shopifyRest } from "./shopify.server";

const SHORT = 40;
const saved = { ...OUTSIDE_CALL_TIMEOUT_MS };
const ENV_KEYS = ["LOVABLE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AI_BACKUP_ORDER", "ANTHROPIC_BACKUP_MODEL", "OPENAI_BACKUP_MODEL", "PLATFORM_ORG_ID", "BILLING_ADMIN_WHATSAPP"];
const savedEnv: Record<string, string | undefined> = {};
let warnings: string[] = [];

beforeEach(() => {
  // Every target times out fast here; the defaults are checked on their own.
  for (const k of Object.keys(OUTSIDE_CALL_TIMEOUT_MS)) (OUTSIDE_CALL_TIMEOUT_MS as Record<string, number>)[k] = SHORT;
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  warnings = [];
  vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => void warnings.push(a.map(String).join(" ")));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  Object.assign(OUTSIDE_CALL_TIMEOUT_MS, saved);
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: string | URL | Request) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
/** A request that never answers — until its signal aborts, as fetch() does. */
const hang = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")));
  });
/** Headers now, then a body that stalls (and errors on abort, as fetch's does). */
function stalledBody(init?: RequestInit, first = '{"a":') {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(first));
      init?.signal?.addEventListener("abort", () => c.error(new DOMException("This operation was aborted", "AbortError")));
    },
  });
  return new Response(body, { status: 200 });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the helper
describe("5. outsideFetch", () => {
  it("healthy: the response is the same — status, headers, body — and nothing is logged", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"ok":true}', { status: 201, headers: { "x-id": "7" } }));
    const res = await outsideFetch("meta", "https://graph.facebook.com/v25.0/me");
    expect(res.status).toBe(201);
    expect(res.headers.get("x-id")).toBe("7");
    expect(await res.json()).toEqual({ ok: true });
    expect(warnings).toEqual([]);
  });

  it("no answer: OutsideCallTimeout (a TypeError, like an unreachable host), logged with target and host", async () => {
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => hang(init));
    const started = Date.now();
    const error = await outsideFetch("razorpay", "https://api.razorpay.com/v1/x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutsideCallTimeout);
    expect(error).toBeInstanceOf(TypeError);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(warnings.join("\n")).toContain('"target":"razorpay"');
    expect(warnings.join("\n")).toContain('"host":"api.razorpay.com"');
  });

  it("a body that stalls times out too, as OutsideCallTimeout", async () => {
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => stalledBody(init));
    const res = await outsideFetch("shopify", "https://shop.example/admin/api/x.json");
    await expect(res.json()).rejects.toBeInstanceOf(OutsideCallTimeout);
  });

  it("idle: a long stream that keeps talking is never cut; headersOnly: the body is not timed", async () => {
    const chunked = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(c) {
            for (let i = 0; i < 6; i += 1) {
              await sleep(15);
              c.enqueue(new TextEncoder().encode(`${i}`));
            }
            c.close();
          },
        }),
      );
    vi.stubGlobal("fetch", async () => chunked());
    const idle = await outsideFetch("ai_stream", "https://ai.gateway.lovable.dev/v1/responses", {}, { idle: true, timeoutMs: 40 });
    expect(await idle.text()).toBe("012345");
    const streamed = await outsideFetch("meta_media", "https://lookaside.fbsbx.com/x", {}, { headersOnly: true, timeoutMs: 40 });
    expect(await streamed.text()).toBe("012345");
  });

  it("a timeout counts as an outage (unreachable), so the AI backup takes over", () => {
    expect(outageOf(new OutsideCallTimeout("ai", 120_000))).toEqual({ kind: "network", status: null });
  });

  it("defaults: generous, and every outside target has one", () => {
    const want: OutsideTarget[] = ["ai", "ai_stream", "embeddings", "transcription", "meta", "meta_media", "razorpay", "google", "shopify"];
    expect(Object.keys(saved).sort()).toEqual([...want].sort());
    for (const ms of Object.values(saved)) {
      expect(ms).toBeGreaterThanOrEqual(15_000);
      expect(ms).toBeLessThanOrEqual(180_000);
    }
    // The Anthropic backup client's own timeout; the primary never waits longer.
    expect(saved.ai).toBe(120_000);
  });
});

// ------------------------------------------------------------ AI falls back
function aiWorld() {
  return fakeDb(
    (op: FakeOp) => {
      if (op.table === "organization_ai_settings") return { data: { ai_enabled: true, ai_monthly_cap_amount: 1000, currency: "INR", ai_markup_multiplier: 3 }, error: null };
      if (op.table === "platform_settings") return { data: { ai_monthly_cap_amount: 100000, ai_cap_currency: "INR", ai_markup_multiplier: 3 }, error: null };
      if (op.table === "ai_tiers") return { data: { key: "everyday", display_name: "Everyday", provider: "lovable", model_id: "google/gemini-3.6-flash", is_active: true }, error: null };
      if (op.table === "ai_models") return { data: { supports_tools: true, is_available: true, is_deprecated: false }, error: null };
      if (op.table === "products" && op.kind === "select") return { data: null, error: null, count: 0 } as never;
      if (op.table === "ai_runs" && op.kind === "insert") return { data: { id: "run-1" }, error: null };
      if (op.table === "activity_log" && op.kind === "select") return { data: [{ id: "recent" }], error: null };
      return undefined;
    },
    (call: FakeRpc) => {
      if (call.name === "match_knowledge_chunks") return { data: [], error: null };
      if (call.name === "ai_month_spend" || call.name === "platform_ai_month_spend") return { data: 0, error: null };
      if (call.name === "record_ai_tool_calls") return { data: 0, error: null };
      return undefined;
    },
  );
}

describe("5. AI calls: a timeout is an outage and the backup answers", () => {
  it("the gateway never answers → Claude (ANTHROPIC_API_KEY) answers the same run; the row says why", async () => {
    process.env["LOVABLE_API_KEY"] = "gateway-key";
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-test";
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      hosts.push(new URL(url).host);
      if (url.includes("/embeddings")) return json({ data: [{ embedding: [0.1] }] });
      if (url.includes("ai.gateway.lovable.dev")) return hang(init);
      return json({ id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [{ type: "text", text: "Yes, it is gold." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
    });
    const db = aiWorld();
    const out = await executeRun(db.supabase, { organizationId: "org", task: "agent_reply", tier: "everyday", conversationId: "conv-1", contactId: "c1", input: "Is it gold?", system: "You answer.", useKnowledge: true });
    expect(out.status).toBe("ok");
    expect(out.output).toBe("Yes, it is gold.");
    expect(out.provider).toBe("anthropic");
    expect(hosts).toContain("api.anthropic.com");
    const row = db.ops.find((o) => o.table === "ai_runs" && o.kind === "insert")!.payload as { metadata: Record<string, unknown> };
    expect(row.metadata["fallback"]).toMatchObject({ reason: "network", status: null });
    expect(warnings.join("\n")).toContain('"target":"ai"');
  });

  it("unchanged: no backup key → the same 'unreachable' failure as before, never a hang", async () => {
    process.env["LOVABLE_API_KEY"] = "gateway-key";
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
      urlOf(input).includes("/embeddings") ? json({ data: [{ embedding: [0.1] }] }) : hang(init),
    );
    const out = await executeRun(aiWorld().supabase, { organizationId: "org", task: "agent_reply", tier: "everyday", conversationId: "conv-1", contactId: "c1", input: "Hi", system: "You answer.", useKnowledge: false });
    expect(out.status).toBe("error");
  });

  it("embeddings: the gateway never answers + OPENAI_API_KEY → OpenAI's own text-embedding-3-small", async () => {
    process.env["LOVABLE_API_KEY"] = "gateway-key";
    process.env["OPENAI_API_KEY"] = "sk-openai";
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      seen.push(url);
      return url.includes("gateway") ? hang(init) : json({ data: [{ embedding: [0.5] }] });
    });
    expect(await embedTexts(["hello"])).toEqual([[0.5]]);
    expect(seen).toEqual(["https://ai.gateway.lovable.dev/v1/embeddings", "https://api.openai.com/v1/embeddings"]);
  });

  it("voice notes: the gateway never answers → the OPENAI_API_KEY transcription is tried", async () => {
    process.env["LOVABLE_API_KEY"] = "gateway-key";
    process.env["OPENAI_API_KEY"] = "sk-openai";
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
      urlOf(input).includes("gateway") ? hang(init) : json({ text: "hello there" }),
    );
    const out = await transcribeAudio(fakeDb(() => undefined).supabase, "org", new Uint8Array([1, 2]), "audio/ogg");
    expect(out.text).toBe("hello there");
  });
});

// ----------------------------------------------------- every other outside call
describe("5. Meta, Razorpay, Google, Shopify, media: a timeout ends the call like an unreachable host", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit) => hang(init));
  });

  it("Meta Graph (graphFetch)", async () => {
    await expect(graphFetch("123/messages", "token", { method: "POST", body: {} })).rejects.toBeInstanceOf(OutsideCallTimeout);
  });
  it("Meta media download (fetchMetaMedia)", async () => {
    await expect(fetchMetaMedia("media-1", "token")).rejects.toBeInstanceOf(OutsideCallTimeout);
  });
  it("Razorpay payment link: the usual 'couldn't reach' answer", async () => {
    const out = await createPaymentLink(
      { keyId: "k", keySecret: "s" } as never,
      { amount: 100, currency: "INR", description: "x", reference: "r", customer: {}, callbackUrl: "https://x", notes: {} } as never,
    );
    expect(out).toEqual({ link: null, error: "We couldn't reach the payment provider. Please try again." });
  });
  it("Razorpay keys check (flow connections)", async () => {
    await expect(verifyRazorpayKeys("k", "s")).rejects.toBeInstanceOf(OutsideCallTimeout);
  });
  it("Google sign-in (flow connections)", async () => {
    await expect(exchangeGoogleCode("https://app.example", "code")).rejects.toBeInstanceOf(OutsideCallTimeout);
  });
  it("Shopify REST", async () => {
    await expect(shopifyRest({ shopDomain: "shop.myshopify.com", accessToken: "t", path: "products.json" })).rejects.toBeInstanceOf(OutsideCallTimeout);
  });

  it("no bare fetch() is left at any of the listed call sites", () => {
    const files = [
      "ai-run.server.ts",
      "whatsapp-api.server.ts",
      "service-text.server.ts",
      "whatsapp-webhook.server.ts",
      "billing-notify.server.ts",
      "wa-forms.server.ts",
      "razorpay.server.ts",
      "flow-connections.server.ts",
      "shopify.server.ts",
      "ai-media.server.ts",
      "merchant-channel.server.ts",
      "../routes/api/whatsapp/media/$id.ts",
    ];
    for (const f of files) {
      const src = readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
      expect({ f, bare: src.match(/(?<![\w.])fetch\(/g) ?? [] }).toEqual({ f, bare: [] });
      expect(src).toContain("outsideFetch(");
    }
  });
});
