import { fakeDb, type FakeOp, type FakeRpc } from "./fake-db";

/**
 * Test-only: a fake database where every query costs one simulated round trip
 * (`rttMs`) and a fake Graph API that costs `graphMs`. The flow in the live
 * test (keyword "menu" → buttons; tap "Shop" → text) is modelled with the
 * published graph it actually used. Measures how long after the payload
 * starts processing the customer-facing Graph send begins.
 */
export const MENU_GRAPH = {
  meta: {},
  nodes: [
    { id: "start", type: "start", data: {} },
    {
      id: "menu",
      type: "buttons",
      data: {
        text: "Hi {{name}}! How can we help?",
        buttons: [
          { id: "b1", title: "Shop" },
          { id: "b2", title: "Track order" },
        ],
      },
    },
    { id: "shop", type: "text", data: { text: "Browse our latest picks on our website." } },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "e0", source: "start", target: "menu", sourceHandle: "next" },
    { id: "e1", source: "menu", target: "shop", sourceHandle: "b1" },
    { id: "e4", source: "shop", target: "end", sourceHandle: "next" },
  ],
};

type Reply = { data: unknown; error: { code?: string; message: string } | null };

export function latencyWorld(opts: {
  org: string;
  rttMs: number;
  graphMs: number;
  /** The contact's run: waiting on the menu buttons, or none (keyword start). */
  waitingRun: boolean;
  /** Meta redelivered a message we already stored. */
  duplicate?: boolean;
}) {
  const t0 = { at: 0 };
  const graphSends: Array<{ at: number; body: Record<string, unknown> }> = [];
  const account = {
    id: `acc-${opts.org}`,
    organization_id: opts.org,
    waba_id: "waba",
    phone_number_id: "pn",
    display_phone_number: "911111111111",
    status: "active",
    is_default: true,
  };
  const run = {
    id: `run-${opts.org}`,
    organization_id: opts.org,
    flow_id: "flow-1",
    version_id: "ver-1",
    contact_id: "c1",
    conversation_id: "cv1",
    current_node_id: "menu",
    variables: {},
    status: "waiting",
    waiting_for: "reply",
    wake_at: new Date(Date.now() + 3600_000).toISOString(),
    steps: 2,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const reply = (op: FakeOp): Reply | undefined => {
    const t = op.table;
    if (t === "platform_settings") return { data: { onboarding_whatsapp_account_id: null }, error: null };
    if (t === "whatsapp_accounts") return { data: account, error: null };
    if (t === "whatsapp_credentials") return { data: { access_token: "tok" }, error: null };
    if (t === "contacts" && op.kind === "upsert")
      return { data: { id: "c1", opt_in_status: "unknown", created_at: "2020-01-01T00:00:00Z" }, error: null };
    if (t === "contacts") return { data: { name: "Asha", phone: "+919800000001", wa_id: "919800000001", attributes: {}, opt_in_status: "unknown" }, error: null };
    if (t === "conversations" && op.kind === "select")
      return {
        data: {
          id: "cv1",
          contact_id: "c1",
          unread_count: 0,
          last_customer_message_at: new Date().toISOString(),
          whatsapp_account_id: account.id,
          contacts: { phone: "+919800000001" },
        },
        error: null,
      };
    if (t === "messages" && op.kind === "upsert") return { data: opts.duplicate ? [] : [{ id: "m-in" }], error: null };
    if (t === "messages" && op.kind === "insert") return { data: { id: "m-out" }, error: null };
    if (t === "feature_flags") return { data: [{ key: "flows_v2", default_enabled: true }], error: null };
    if (t === "flow_runs" && op.kind === "select") return { data: opts.waitingRun ? [run] : [], error: null };
    if (t === "flow_runs" && op.kind === "update") return { data: [{ id: run.id }], error: null };
    if (t === "flow_runs" && op.kind === "insert")
      return { data: { ...run, status: "running", waiting_for: null, current_node_id: "start", steps: 0 }, error: null };
    if (t === "flow_versions") return { data: { id: "ver-1", graph: MENU_GRAPH }, error: null };
    if (t === "flows") return { data: { whatsapp_account_id: null }, error: null };
    if (t === "flow_triggers")
      return {
        data: [
          {
            id: "8ea5aa7c-6a2a-4f7d-bb85-000000000000",
            flow_id: "flow-1",
            kind: "keyword",
            config: { keywords: ["menu"], match: "exact" },
            flows: { whatsapp_account_id: null },
          },
        ],
        error: null,
      };
    if (t === "flow_run_events") return { data: null, error: null };
    return undefined;
  };
  const slow = <T>(value: T) => new Promise<T>((r) => setTimeout(() => r(value), opts.rttMs));
  const db = fakeDb(
    (op) => slow(reply(op) ?? { data: null, error: null }) as unknown as Reply,
    (call: FakeRpc) => slow({ data: call.name === "bump_campaign_counters" ? null : null, error: null }) as unknown as Reply,
  );
  const fetchStub = async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    // Read receipts / typing dots are not the customer's reply.
    if (String(url).includes("graph.facebook.com") && !body["status"]) {
      graphSends.push({ at: Date.now() - t0.at, body });
    }
    await new Promise((r) => setTimeout(r, opts.graphMs));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${graphSends.length}` }] }), { status: 200 });
  };
  return { ...db, t0, graphSends, fetchStub };
}

export function inboundPayload(msg: Record<string, unknown>) {
  return {
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "pn", display_phone_number: "911111111111" },
              contacts: [{ wa_id: "919800000001", profile: { name: "Asha" } }],
              messages: [{ from: "919800000001", timestamp: String(Math.floor(Date.now() / 1000)), ...msg }],
            },
          },
        ],
      },
    ],
  };
}
