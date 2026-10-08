import { describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";
import { memoryDb } from "./test-support/memory-db";
import { INSTRUCTIONS, ORG, PRODUCTS } from "./test-support/zoori-replay";

/**
 * Batch 15C speed bench (opt-in): the two live Zoori messages of 7 Oct
 * 05:05 UTC replayed end to end — WhatsApp webhook → pre-AI steps → Aiden →
 * WhatsApp sends — through processWebhookPayload, with every database read,
 * embedding, model call and send slowed to the live figures
 * (webhook_events.timing + ai_runs.metadata.timing_ms of those two events):
 *
 *   "earrings dikhao"          received → first message 23.8 s
 *       pre-AI 3.0 s · prelude 0.6 · retrieval 3.1 · model 12.1 (3 calls) · send 2.1
 *   "showroom timing kya hai"  received → first message 11.8 s
 *       pre-AI 3.4 s · prelude 1.25 · retrieval 1.3 · model 3.3 (1 call)
 *
 *   database round trip        120 ms (contact upsert 650, message write 300)
 *   automations read           280 ms / 1,250 ms (the two events)
 *   embedding                  900 ms
 *   material match            2,200 ms / 400 ms ("earrings": the live 3.1 s
 *                              retrieval incl. its on-demand page read)
 *   model call               4,000 ms / 3,300 ms (gpt-5.4: 12.1 s over 3 calls; 3.3 s)
 *   WhatsApp send              520 ms
 *
 * The model is scripted the same on both builds: it uses the catalogue
 * result it has, sends the products, and closes in the same call when the
 * tool lets it (send_products' `closing`, this branch) — otherwise it is
 * asked again for its closing words, as live.
 *
 * Times are scaled down by BENCH_SCALE (default 5) and scaled back up in the
 * report. The file uses only what main has: run it on main and on this
 * branch to compare:
 *   BENCH=1 bunx vitest run src/lib/batch15c-bench.test.ts --silent=false
 */

const SCALE = Number(process.env["BENCH_SCALE"] ?? 5);
const s = (ms: number) => ms / SCALE;

vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["ai_features", "catalogs"]),
}));

type Event = {
  id: string;
  ask: string;
  automationsMs: number;
  matchMs: number;
  modelMs: number;
  /** The material the match returns. */
  chunks: Array<{ title: string; text: string }>;
};

const EVENTS: Event[] = [
  {
    id: "earrings",
    ask: "earrings dikhao",
    automationsMs: 280,
    matchMs: 2200,
    modelMs: 4000,
    chunks: [],
  },
  {
    id: "showroom",
    ask: "showroom timing kya hai",
    automationsMs: 1250,
    matchMs: 400,
    modelMs: 3300,
    chunks: [
      {
        title: "Contact MyZoori | Visit our showrooms",
        text: "Our showrooms in Somajiguda and Bolarum are open 11 AM to 9 PM, all days of the week.",
      },
    ],
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every query waits its round trip before it answers. */
function slowed<T extends object>(builder: T, ms: () => number): T {
  const proxy: T = new Proxy(builder, {
    get(target, prop, receiver) {
      if (prop === "then") {
        return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
          sleep(s(ms())).then(() => (target as unknown as PromiseLike<unknown>).then(res, rej));
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out === target ? proxy : out;
      };
    },
  });
  return proxy;
}

function world(e: Event) {
  const now = new Date().toISOString();
  const account = {
    id: "acc-zoori",
    organization_id: ORG,
    waba_id: "waba",
    phone_number_id: "pn",
    display_phone_number: "911111111111",
    status: "active",
    is_default: true,
  };
  const inbound = {
    id: "m-in",
    direction: "inbound",
    body: e.ask,
    detected_language: null,
    created_at: now,
  };
  const runs: Array<Record<string, unknown>> = [];
  const reply = (op: FakeOp) => {
    const t = op.table;
    if (t === "whatsapp_accounts")
      return {
        data: { ...account, organizations: { lead_source_markers: [], opt_out_keywords: [] } },
        error: null,
      };
    if (t === "whatsapp_credentials") return { data: { access_token: "tok" }, error: null };
    if (t === "platform_settings")
      return {
        data: {
          onboarding_whatsapp_account_id: null,
          ai_monthly_cap_amount: 100000,
          ai_cap_currency: "INR",
          ai_markup_multiplier: 3,
          ai_burst_wait_ms: Math.round(s(1000)),
          on_demand_read: false,
        },
        error: null,
      };
    if (t === "contacts" && op.kind === "upsert")
      return {
        data: { id: "c1", opt_in_status: "unknown", created_at: "2020-01-01T00:00:00Z" },
        error: null,
      };
    if (t === "contacts")
      return {
        data: {
          name: "Tester",
          phone: "+919800000099",
          wa_id: "919800000099",
          opt_in_status: "unknown",
        },
        error: null,
      };
    if (t === "conversations" && op.kind === "select")
      return {
        data: {
          id: "cv1",
          contact_id: "c1",
          unread_count: 0,
          assigned_to: null,
          needs_human: false,
          status: "open",
          last_customer_message_at: now,
          whatsapp_account_id: account.id,
          contacts: { phone: "+919800000099", name: "Tester" },
        },
        error: null,
      };
    if (t === "messages" && op.kind === "upsert") return { data: [{ id: "m-in" }], error: null };
    if (t === "messages" && op.kind === "insert")
      return { data: { id: `m-out-${Math.random()}` }, error: null };
    if (t === "messages" && op.kind === "select") return { data: [inbound], error: null, count: 0 };
    if (t === "flow_runs") return { data: [], error: null };
    if (t === "flow_triggers") return { data: [], error: null };
    if (t === "automations") return { data: [], error: null };
    if (t === "organizations") return { data: { timezone: "Asia/Kolkata" }, error: null };
    if (t === "ai_agents") return { data: { id: "agent-zoori", mode: "replying" }, error: null };
    if (t === "organization_ai_settings")
      return {
        data: {
          ai_enabled: true,
          ai_monthly_cap_amount: 1000,
          currency: "INR",
          ai_markup_multiplier: 3,
          agent_role: "ai_agent",
        },
        error: null,
      };
    if (t === "role_permissions")
      return {
        data: [{ permission_key: "ai.use" }, { permission_key: "catalog.view" }],
        error: null,
      };
    if (t === "ai_tiers")
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
    if (t === "ai_models")
      return {
        data: { supports_tools: true, is_available: true, is_deprecated: false },
        error: null,
      };
    if (t === "ai_instructions") return { data: INSTRUCTIONS, error: null };
    if (t === "ai_runs" && op.kind === "insert") {
      runs.push(op.payload as Record<string, unknown>);
      return { data: { id: `run-${runs.length}` }, error: null };
    }
    if (t === "ai_runs") return { data: [], error: null };
    return undefined;
  };
  const fake = fakeDb(reply, (call) => {
    if (call.name === "match_knowledge_chunks")
      return {
        data: e.chunks.map((c, i) => ({
          document_id: `doc-${i}`,
          source_type: "website",
          source_name: "myzoori.com",
          source_ref: "https://www.myzoori.com/contact-us",
          title: c.title,
          text: c.text,
          similarity: 0.6,
        })),
        error: null,
      };
    if (call.name === "record_ai_tool_calls")
      return { data: (call.args["p_calls"] as unknown[]).length, error: null };
    if (call.name === "ai_month_spend" || call.name === "platform_ai_month_spend")
      return { data: 0, error: null };
    return undefined;
  });
  const mem = memoryDb({ products: PRODUCTS });
  const latency = (t: string, kind: () => string) => () => {
    if (t === "contacts" && kind() === "upsert") return 650;
    if (t === "messages" && kind() === "upsert") return 300;
    if (t === "automations") return e.automationsMs;
    return 120;
  };
  const supabase = {
    from(t: string) {
      const b = (t === "products"
        ? mem.supabase.from(t)
        : fake.supabase.from(t)) as unknown as Record<string, unknown>;
      let kind = "select";
      for (const k of ["insert", "update", "upsert", "delete"]) {
        const orig = b[k] as ((...a: unknown[]) => unknown) | undefined;
        if (orig)
          b[k] = (...a: unknown[]) => {
            kind = k;
            return orig.apply(b, a);
          };
      }
      return slowed(
        b,
        latency(t, () => kind),
      );
    },
    rpc: (n: string, a: Record<string, unknown>) =>
      sleep(s(n === "match_knowledge_chunks" ? e.matchMs : 120)).then(() =>
        fake.supabase.rpc(n, a),
      ),
  } as unknown as ReturnType<typeof fakeDb>["supabase"];
  return { supabase, runs };
}

/** The scripted model: uses the catalogue result it has; closes in the same call when the tool allows. */
function modelTurn(e: Event, body: Record<string, unknown>) {
  const messages = body["messages"] as Array<{
    role: string;
    content: unknown;
    tool_calls?: Array<{ id: string; function: { name: string } }>;
  }>;
  const tools = (body["tools"] ?? []) as Array<{
    function: { name: string; parameters?: { properties?: Record<string, unknown> } };
  }>;
  const send = tools.find((t) => t.function.name === "send_products");
  const canClose = Boolean(send?.function.parameters?.properties?.["closing"]);
  const names = new Map<string, string>();
  for (const m of messages) for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function.name);
  const seen = messages
    .filter((m) => m.role === "tool")
    .map((m) => ({
      name: names.get((m as { tool_call_id?: string }).tool_call_id ?? "") ?? "",
      data: (JSON.parse(String(m.content)) as { data?: unknown }).data,
    }));
  const call = (name: string, args: Record<string, unknown>) => ({
    role: "assistant",
    content: "",
    tool_calls: [
      {
        id: `call-${messages.length}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  });
  if (e.id === "showroom")
    return {
      role: "assistant",
      content:
        'Our showrooms are open 11 AM to 9 PM, all days of the week.\nWhich one is closer to you?\n{"needs_owner": false}',
    };
  const found = [...seen].reverse().find((x) => x.name === "catalog_search")?.data;
  // Live, 05:05: catalog_search {limit 3, category earrings} → send_products ×3 → closing.
  if (!Array.isArray(found)) return call("catalog_search", { limit: 3, category: "earrings" });
  if (!seen.some((x) => x.name === "send_products")) {
    const products = (found as Array<Record<string, unknown>>).slice(0, 3).map((f) => ({
      product_id: String(f["product_id"] ?? f["id"]),
      caption: `${String(f["name"] ?? f["title"])} — ${typeof f["price"] === "string" ? f["price"] : `₹${Math.round(Number(f["price"]))}`}\n${String(f["link"] ?? f["product_url"] ?? "")}`,
    }));
    return call("send_products", {
      products,
      ...(canClose ? { closing: 'Kis budget mein dekh rahe hain?\n{"needs_owner": false}' } : {}),
    });
  }
  return { role: "assistant", content: 'Kis budget mein dekh rahe hain?\n{"needs_owner": false}' };
}

async function replay(e: Event) {
  vi.resetModules();
  process.env["LOVABLE_API_KEY"] = "bench-key";
  process.env["AIDWAR_SUPABASE_URL"] = "https://bench.supabase.co";
  process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = "bench";
  const w = world(e);
  const t0 = Date.now();
  const at: { firstSend?: number; lastSend?: number } = {};
  let modelCalls = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (u.endsWith("/embeddings")) {
      await sleep(s(900));
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }));
    }
    if (u.includes("/chat/completions")) {
      const system = String((body["messages"] as Array<{ content: unknown }>)[0]?.content ?? "");
      if (system.startsWith("You check whether sentences"))
        return new Response(
          JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answers: [] }) } }] }),
        );
      modelCalls += 1;
      await sleep(s(e.modelMs));
      return new Response(
        JSON.stringify({
          choices: [{ message: modelTurn(e, body) }],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
    }
    if (u.includes("graph.facebook.com")) {
      if (body["status"]) return new Response("{}"); // read receipt / typing dots
      await sleep(s(520));
      const now = Date.now() - t0;
      at.firstSend ??= now;
      at.lastSend = now;
      return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${now}` }] }));
    }
    if (u.includes("/rest/v1/")) {
      await sleep(s(120));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}");
  });
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  const { processWebhookPayload } = await import("./whatsapp-webhook.server");
  await processWebhookPayload(
    w.supabase,
    `ev-${e.id}`,
    {
      entry: [
        {
          id: "waba",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn", display_phone_number: "911111111111" },
                contacts: [{ wa_id: "919800000099", profile: { name: "Tester" } }],
                messages: [
                  {
                    from: "919800000099",
                    id: `wamid.${e.id}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: "text",
                    text: { body: e.ask },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    new Date(t0).toISOString(),
  );
  log.mockRestore();
  vi.unstubAllGlobals();
  const timing = lines
    .map((l) => (l.startsWith("{") ? (JSON.parse(l) as Record<string, unknown>) : null))
    .find((j) => j?.["scope"] === "webhook_timing");
  const marks = (timing?.["stages"] ?? {}) as Record<string, number>;
  const run = w.runs.find((r) => !(r["metadata"] as Record<string, unknown>)["purpose"]);
  const meta = (run?.["metadata"] ?? {}) as Record<string, unknown>;
  const tm = (meta["timing_ms"] ?? {}) as Record<string, number>;
  const up = (ms?: number) =>
    ms === undefined || ms === null ? null : Math.round((ms * SCALE) / 100) / 10;
  const preAi = marks["ai_gates"];
  return {
    event: e.ask,
    pre_ai_s: up(preAi),
    contact_s: up(marks["contact"]),
    stored_s: up((marks["message_stored"] ?? 0) - (marks["contact"] ?? 0)),
    flows_s: up((marks["flows"] ?? 0) - (marks["guards_done"] ?? marks["message_stored"] ?? 0)),
    automations_s: up((marks["automations"] ?? 0) - (marks["flows"] ?? 0)),
    burst_s: up((marks["burst"] ?? 0) - (marks["automations"] ?? 0)),
    gates_s: up((marks["ai_gates"] ?? 0) - (marks["burst"] ?? 0)),
    ai_run_s: up((marks["ai_run"] ?? 0) - (marks["ai_gates"] ?? 0)),
    prelude_s: up(tm["prelude"]),
    early_search_s: up(tm["early_search"]),
    retrieval_s: up(tm["retrieval"]),
    model_s: up(tm["model"]),
    model_calls: modelCalls,
    first_send_s: up(at.firstSend),
    last_send_s: up(at.lastSend),
    done_s: up(marks["ai_done"]),
  };
}

describe.runIf(process.env["BENCH"])("bench: the two 7 Oct Zoori messages, end to end", () => {
  it("per stage, seconds (live-calibrated)", async () => {
    const out: Array<Awaited<ReturnType<typeof replay>>> = [];
    for (const e of EVENTS) for (let i = 0; i < 3; i++) out.push(await replay(e));
    for (const r of out) process.stdout.write(`BENCH ${JSON.stringify(r)}\n`);
    expect(out.every((r) => r.first_send_s !== null)).toBe(true);
  }, 300_000);
});
