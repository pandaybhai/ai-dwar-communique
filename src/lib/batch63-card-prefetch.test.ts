import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb } from "./test-support/memory-db";

/**
 * Batch 63 (E): a per-customer send_card after a button tap took ~8.6 s
 * (render ~3 s, then upload/send), because the card could only be drawn at
 * the send step. Now a run waiting at buttons/list draws the card its
 * options lead straight to, so the tap only sends. Measured here with fakes:
 * render-card answers after RENDER_MS, WhatsApp's image send after SEND_MS.
 */

const RENDER_MS = 300; // stands for the ~3 s render
const SEND_MS = 40;

const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
const CONTACT = "c0000000-0000-4000-8000-000000000001";
const CONV = "c0000000-0000-4000-8000-0000000000c1";

const h = vi.hoisted(() => ({
  db: null as unknown,
  metered: [] as string[],
  images: [] as Array<{ url: string; at: number }>,
  rendered: new Set<string>(),
  renders: 0,
}));

vi.mock("@/lib/ai-tools.server", () => ({
  enabledFlags: async () => new Set(["flows_v2", "cards"]),
}));
vi.mock("@/lib/feature-flags.server", () => ({
  enabledFlags: async () => new Set(["flows_v2", "cards"]),
}));
vi.mock("@/lib/flows.server", () => ({
  loadSendSettings: async () => ({ timezone: "Asia/Kolkata", quietHoursEnabled: false }),
}));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({
    connection: {
      phoneNumberId: "pn-1",
      accessToken: "tok",
      accountId: "acc-1",
      wabaId: "waba-1",
      organizationId: ORG,
    },
  }),
}));
vi.mock("@/lib/service-text.server", () => ({
  sendServiceButtons: async () => ({ ok: true, error: null, messageId: "m-btns" }),
  sendServiceList: async () => ({ ok: true, error: null, messageId: "m-list" }),
  sendServiceText: async () => ({ ok: true, error: null, messageId: "m-text" }),
  sendServiceImage: async (_db: unknown, a: { imageUrl: string }) => {
    await new Promise((r) => setTimeout(r, SEND_MS));
    h.images.push({ url: a.imageUrl, at: performance.now() });
    return { ok: true, error: null, messageId: "m-card" };
  },
}));
vi.mock("@/lib/ai-run.server", () => ({
  meterAiUsage: async (_db: unknown, _org: string, task: string) => {
    h.metered.push(task);
  },
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db }));
vi.mock("@/lib/card-usage-alert.server", () => ({ checkCardUsageAlarm: async () => false }));
vi.mock("@/lib/events.server", () => ({ emitEvent: () => Promise.resolve(undefined) }));

const graph = {
  nodes: [
    { id: "start", type: "start", data: {} },
    {
      id: "btns",
      type: "buttons",
      data: {
        text: "Which card?",
        variable: "choice",
        buttons: [
          { id: "fam", title: "Fam Card" },
          { id: "later", title: "Later" },
        ],
      },
    },
    {
      id: "card",
      type: "send_card",
      data: {
        kind: "customer_offer",
        vars: {
          headline: "Hi {{contact.name}}",
          offer: "Your {{choice}}",
          validity: "Till Sunday",
          code: "FAM10",
        },
        caption: "Here it is",
        fallback_text: "Your Fam Card",
      },
    },
    { id: "end", type: "end", data: {} },
  ],
  edges: [
    { id: "e1", source: "start", sourceHandle: "next", target: "btns" },
    { id: "e2", source: "btns", sourceHandle: "fam", target: "card" },
    { id: "e3", source: "btns", sourceHandle: "later", target: "end" },
    { id: "e4", source: "card", sourceHandle: "next", target: "end" },
  ],
};

function world(): MemoryDb {
  const db = memoryDb({
    flow_versions: [
      {
        id: "ver-1",
        flow_id: "flow-1",
        organization_id: ORG,
        status: "published",
        graph,
        flows: { config: {} },
      },
    ],
    flows: [{ id: "flow-1", organization_id: ORG, whatsapp_account_id: null, config: {} }],
    conversations: [
      {
        id: CONV,
        organization_id: ORG,
        contact_id: CONTACT,
        status: "open",
        assigned_to: null,
        whatsapp_account_id: "acc-1",
        last_customer_message_at: new Date().toISOString(),
      },
    ],
    contacts: [
      {
        id: CONTACT,
        organization_id: ORG,
        name: "Asha",
        phone: "+919812345678",
        wa_id: "919812345678",
        opt_in_status: "opted_in",
        attributes: {},
        contact_tags: [],
      },
    ],
    organizations: [{ id: ORG, name: "ZOORI Jewels INDIA", branding: {} }],
  });
  h.db = db.supabase;
  return db;
}

function stubRenderer() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if (init?.method === "HEAD") {
        const key = decodeURIComponent(u.split("/onboarding-cards/")[1] ?? "").replace(
          /\.png$/,
          "",
        );
        const hit = [...h.rendered].some((k) => k.replace(/[^a-zA-Z0-9/_-]/g, "_") === key);
        return new Response(null, {
          status: hit ? 200 : 404,
          headers: hit ? { "content-type": "image/png" } : {},
        });
      }
      if (u.endsWith("/functions/v1/render-card")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { cacheKey: string };
        h.renders += 1;
        await new Promise((r) => setTimeout(r, RENDER_MS));
        h.rendered.add(body.cacheKey);
        return Response.json({ url: `https://cdn.test/${encodeURIComponent(body.cacheKey)}.png` });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}

/** Start the run (the customer gets the buttons), then tap "Fam Card"; ms from the tap to the card going out. */
async function startThenTap(db: MemoryDb, beforeTap?: () => void) {
  const { startRun, handleInboundForRuns } = await import("./flow-engine.server");
  await startRun(db.supabase, {
    organizationId: ORG,
    flowId: "flow-1",
    contactId: CONTACT,
    conversationId: CONV,
    fromCustomerMessage: true,
    extras: {
      inboundAt: new Date().toISOString(),
      conversation: { id: CONV, whatsappAccountId: "acc-1" },
    },
  });
  const waiting = db.rows("flow_runs")[0]!;
  expect([waiting["status"], waiting["current_node_id"]]).toEqual(["waiting", "btns"]);
  beforeTap?.();
  const tapAt = performance.now();
  const taken = await handleInboundForRuns(db.supabase, {
    organizationId: ORG,
    contactId: CONTACT,
    conversationId: CONV,
    body: "Fam Card",
    replyId: "btns:fam",
    inboundAt: new Date().toISOString(),
    conversation: { id: CONV, whatsappAccountId: "acc-1" },
  });
  expect(taken.consumed).toBe(true);
  expect(h.images).toHaveLength(1);
  return { ms: h.images[0]!.at - tapAt, url: h.images[0]!.url };
}

beforeEach(() => {
  vi.resetModules();
  process.env["AIDWAR_SUPABASE_URL"] = "https://db.test";
  process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = "service";
  h.metered = [];
  h.images = [];
  h.rendered = new Set();
  h.renders = 0;
  stubRenderer();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@/lib/card-prefetch.server");
});

describe("card prefetch: the tap only sends", () => {
  it("before (no prefetch): the tap waits for the whole render, then the send", async () => {
    vi.doMock("@/lib/card-prefetch.server", () => ({
      prefetchCardsAfter: async () => 0,
      holdPrefetch: () => undefined,
      settlePrefetch: async () => undefined,
    }));
    const before = await startThenTap(world());
    console.log(
      `[batch63] tap → card sent without prefetch: ${before.ms.toFixed(0)} ms (render ${RENDER_MS} + send ${SEND_MS})`,
    );
    expect(before.ms).toBeGreaterThanOrEqual(RENDER_MS);
    expect(h.renders).toBe(1);
    expect(h.metered).toEqual(["card_render"]);
  });

  it("after: the card is drawn while the buttons wait; the tap sends in about the send time alone, metered once", async () => {
    const after = await startThenTap(world());
    console.log(
      `[batch63] tap → card sent with prefetch: ${after.ms.toFixed(0)} ms (send ${SEND_MS})`,
    );
    expect(after.ms).toBeLessThan(RENDER_MS / 2);
    expect(after.ms).toBeGreaterThanOrEqual(SEND_MS - 5);
    // One real render (the prefetch); the tap's send reused it.
    expect(h.renders).toBe(1);
    expect(h.metered).toEqual(["card_render"]);
    // It is the card for the tap's answer: {{choice}} = "Fam Card".
    expect(decodeURIComponent(after.url)).toContain("customer_offer");
  });

  it("a value that changed after the prefetch is drawn afresh — the prefetched picture is never sent", async () => {
    const db = world();
    let prefetchedKey = "";
    const changed = await startThenTap(db, () => {
      prefetchedKey = [...h.rendered][0]!;
      db.rows("contacts")[0]!["name"] = "Asha Rao"; // {{contact.name}} is on the card
    });
    expect(prefetchedKey).not.toBe("");
    expect(decodeURIComponent(changed.url)).not.toContain(prefetchedKey);
    expect(h.renders).toBe(2);
    expect(h.metered).toEqual(["card_render", "card_render"]);
  });
});

describe("what is prefetched", () => {
  it("only options whose output goes straight to a Send card, with the tap's answer filled in", async () => {
    const { cardsAfterChoice } = await import("./card-prefetch.server");
    const ctx = {
      vars: {},
      contact: { name: "Asha", phone: "", attributes: {} },
      tags: [],
      now: new Date(),
      timezone: "Asia/Kolkata",
    };
    const cards = cardsAfterChoice(graph as never, graph.nodes[1] as never, ctx);
    expect(cards).toEqual([
      {
        handle: "fam",
        kind: "customer_offer",
        vars: {
          headline: "Hi Asha",
          offer: "Your Fam Card",
          validity: "Till Sunday",
          code: "FAM10",
        },
      },
    ]);
    // A step that isn't buttons/list prefetches nothing.
    expect(cardsAfterChoice(graph as never, graph.nodes[2] as never, ctx)).toEqual([]);
  });

  it("nothing is drawn with the window closed, no number, or cards off", async () => {
    const { prefetchCardsAfter } = await import("./card-prefetch.server");
    const db = world();
    const ctx = {
      vars: {},
      contact: { name: "Asha", phone: "", attributes: {} },
      tags: [],
      now: new Date(),
      timezone: "Asia/Kolkata",
    };
    const base = { organizationId: ORG, graph: graph as never, node: graph.nodes[1] as never, ctx };
    expect(
      await prefetchCardsAfter(db.supabase, { ...base, windowOpen: false, connected: true }),
    ).toBe(0);
    expect(
      await prefetchCardsAfter(db.supabase, { ...base, windowOpen: true, connected: false }),
    ).toBe(0);
    expect(h.renders).toBe(0);
  });
});
