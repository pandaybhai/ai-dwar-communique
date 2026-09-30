import { fakeDb, type FakeOp, type FakeRpc } from "./fake-db";

/**
 * Test-only: a replying Aiden workspace where every query costs one simulated
 * round trip. The model and embeddings are stubbed; `modelAt` records when the
 * first model call leaves (ms after t0).
 */
export function aidenWorld(opts: { rttMs: number; conversation?: Record<string, unknown> }) {
  const t0 = { at: 0 };
  const modelCalls: number[] = [];
  const reply = (op: FakeOp) => {
    const t = op.table;
    if (t === "ai_agents") return { data: { id: "agent-1", mode: "replying" }, error: null };
    if (t === "feature_flags") return { data: [{ key: "ai_features", default_enabled: true }], error: null };
    if (t === "organization_ai_settings")
      return { data: { ai_enabled: true, ai_monthly_cap_amount: 1000, currency: "INR", ai_markup_multiplier: 3 }, error: null };
    if (t === "platform_settings") return { data: { ai_monthly_cap_amount: 100000, ai_cap_currency: "INR", ai_markup_multiplier: 3 }, error: null };
    if (t === "conversations")
      return {
        data: { assigned_to: null, needs_human: false, last_customer_message_at: new Date().toISOString(), status: "open", contact_id: "c1", ...(opts.conversation ?? {}) },
        error: null,
      };
    if (t === "messages") return { data: [{ direction: "inbound", body: "What is your return policy?", created_at: new Date().toISOString() }], error: null };
    if (t === "ai_tiers") return { data: { key: "everyday", display_name: "Everyday", provider: "lovable", model_id: "google/gemini-3.6-flash", is_active: true }, error: null };
    if (t === "ai_models") return { data: { supports_tools: true, is_available: true, is_deprecated: false }, error: null };
    if (t === "ai_runs" && op.kind === "insert") return { data: { id: "run-1" }, error: null };
    if (t === "ai_runs") return { data: [], error: null };
    return undefined;
  };
  const rpc = (call: FakeRpc) => {
    if (call.name === "match_knowledge_chunks")
      return { data: [{ document_id: "d1", source_type: "website", source_name: "site", source_ref: "https://x/faq", title: "FAQ", text: "We offer 20-day returns, no questions asked.", similarity: 0.5 }], error: null };
    if (call.name === "ai_month_spend" || call.name === "platform_ai_month_spend") return { data: 0, error: null };
    return undefined;
  };
  const slow = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), opts.rttMs));
  const db = fakeDb(
    (op) => slow(reply(op) ?? { data: null, error: null }) as never,
    (call) => slow(rpc(call) ?? { data: null, error: null }) as never,
  );
  const fetchStub = async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/embeddings")) {
      await new Promise((r) => setTimeout(r, opts.rttMs));
      return new Response(JSON.stringify({ data: [{ embedding: [0.1] }] }));
    }
    if (String(url).includes("graph.facebook.com")) return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }));
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: Array<{ content: unknown }> };
    const system = String(body.messages?.[0]?.content ?? "");
    if (!system.startsWith("You check whether")) modelCalls.push(Date.now() - t0.at);
    const content = system.startsWith("You check whether")
      ? JSON.stringify({ answers: ["yes"] })
      : 'We offer 20-day returns, no questions asked.\n{"needs_owner": false}';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  };
  return { ...db, t0, modelCalls, fetchStub };
}
