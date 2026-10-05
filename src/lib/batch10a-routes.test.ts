import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 10A, routes:
 *  - /api/cards "send" (inbox Send card): same permission and 24-hour rule as
 *    a typed reply; a card that can't be drawn goes as plain words; nothing
 *    at all when cards are off.
 *  - Campaigns: no card unless one was attached; cards off never sends one.
 *  - Inbox text/template sends (send-message) never touch card code.
 */

const h = vi.hoisted(() => ({
  db: null as null | ReturnType<typeof import("./test-support/fake-db").fakeDb>,
  denied: null as null | string,
  sendCampaignTemplate: vi.fn(async () => ({ error: null, messageId: "msg-1" })),
  graphFetch: vi.fn(async () => ({ ok: true, status: 200, body: { messages: [{ id: "wamid.1" }] } })),
  cardsImported: vi.fn(),
}));

vi.mock("@/lib/whatsapp-api.server", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-api.server")>()),
  requireOrgMember: async () => ({ supabase: h.db!.supabase, organizationId: "org-10a", userId: "u1", role: "agent" }),
  requirePermission: async (_auth: unknown, key: string) =>
    h.denied === key ? Response.json({ error: "You don't have permission." }, { status: 403 }) : null,
  logServerActivity: async () => {},
  graphFetch: h.graphFetch,
}));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({
    connection: { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "t" },
    error: null,
  }),
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/campaigns.server", () => ({
  sendCampaignTemplate: h.sendCampaignTemplate,
  loadSenderContext: async () => ({ accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "t" }),
}));
vi.mock("@/lib/campaign-billing.server", () => ({
  holdCampaign: async () => ({ ok: true }),
  settleCampaignSpend: async () => ({ ok: true }),
}));
vi.mock("@/lib/events.server", () => {
  const noop = async () => {};
  return { emitEvent: noop, recordUsage: noop };
});

import { Route as CardsRoute } from "../routes/api/cards";
import { Route as CampaignWorker } from "../routes/api/internal/campaign-worker";
import { Route as SendMessage } from "../routes/api/whatsapp/send-message";
import * as cardsServer from "./customer-cards.server";

type Post = (a: { request: Request }) => Promise<Response>;
const postOf = (r: unknown) => (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST;

const CARD_URL = "https://render.test/storage/card.png";
let renders: Array<Record<string, unknown>> = [];
let sends: Array<Record<string, unknown>> = [];

function stubFetch(render: "ok" | "down") {
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (String(url).includes("/functions/v1/render-card")) {
      renders.push(body);
      return render === "ok"
        ? new Response(JSON.stringify({ url: CARD_URL }))
        : new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    }
    sends.push(body);
    return new Response(JSON.stringify({ messages: [{ id: `wamid.${sends.length}` }] }));
  });
}

function cardsDb(opts: { cards: boolean; windowOpenAt?: string | null; planStatus?: string }) {
  return fakeDb((op: FakeOp) => {
    if (op.table === "feature_flags") return { data: [{ key: "cards", default_enabled: opts.cards }], error: null };
    if (op.table === "organizations") return { data: { name: "Zoori", branding: {}, plan_status: opts.planStatus ?? "active" }, error: null };
    if (op.table === "conversations")
      return {
        data: {
          id: "cv1",
          contact_id: "c1",
          whatsapp_account_id: "acc",
          last_customer_message_at: opts.windowOpenAt === undefined ? new Date().toISOString() : opts.windowOpenAt,
        },
        error: null,
      };
    if (op.table === "contacts") return { data: { phone: "+919800000001", wa_id: "919800000001" }, error: null };
    if (op.table === "messages" && op.kind === "insert") return { data: { id: "m-out" }, error: null };
    return undefined;
  });
}

const cardsCall = (body: Record<string, unknown>) =>
  postOf(CardsRoute)({
    request: new Request("http://x/api/cards", { method: "POST", body: JSON.stringify({ organization_id: "org-10a", ...body }) }),
  });

const OFFER = { action: "send", conversation_id: "cv1", kind: "customer_offer", vars: { headline: "This weekend", offer: "20% off", code: "FEST20" }, caption: "For you" };

beforeEach(() => {
  renders = [];
  sends = [];
  h.denied = null;
  process.env["AIDWAR_SUPABASE_URL"] = "https://render.test";
  process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"] = "service-key";
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

let n = 0;
/** The card renderer caches by workspace and values: a fresh value per test. */
const fresh = () => ({ ...OFFER, vars: { ...OFFER.vars, headline: `Weekend ${(n += 1)}` } });

describe("inbox Send card (/api/cards send)", () => {
  it("draws the card and sends it into the conversation as a picture, recorded as the teammate's", async () => {
    stubFetch("ok");
    h.db = cardsDb({ cards: true });
    const body = fresh();
    const res = await cardsCall(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sent: "card" });
    expect(renders[0]).toMatchObject({ kind: "customer_offer", vars: { headline: body.vars.headline, code: "FEST20" } });
    expect(sends).toEqual([{ messaging_product: "whatsapp", to: "919800000001", type: "image", image: { link: CARD_URL, caption: "For you" } }]);
    const row = h.db.ops.find((o) => o.table === "messages" && o.kind === "insert")!.payload;
    expect(row).toMatchObject({ conversation_id: "cv1", type: "image", media_url: CARD_URL, sent_by: "u1", metadata: { kind: "card", source: "inbox", card_kind: "customer_offer" } });
  });

  it("render failure → the card's details go as a plain message instead", async () => {
    stubFetch("down");
    h.db = cardsDb({ cards: true });
    const body = fresh();
    const res = await cardsCall(body);
    expect(await res.json()).toMatchObject({ ok: true, sent: "fallback" });
    expect(sends).toEqual([
      { messaging_product: "whatsapp", to: "919800000001", type: "text", text: { body: `For you\n\n${body.vars.headline}\n20% off\nCoupon code: FEST20` } },
    ]);
    expect(h.db.ops.find((o) => o.table === "messages" && o.kind === "insert")!.payload).toMatchObject({ type: "text", sent_by: "u1" });
  });

  it("Product card render failure → the product photo with the details as caption", async () => {
    stubFetch("down");
    h.db = cardsDb({ cards: true });
    const res = await cardsCall({ action: "send", conversation_id: "cv1", kind: "customer_product", vars: { name: `Ring ${(n += 1)}`, price: "₹499", image_url: "https://x.in/ring.jpg" } });
    expect(await res.json()).toMatchObject({ sent: "fallback" });
    expect(sends[0]).toMatchObject({ type: "image", image: { link: "https://x.in/ring.jpg", caption: `Ring ${n}\nPrice: ₹499` } });
  });

  it("outside the 24-hour window: refused, nothing drawn or sent", async () => {
    stubFetch("ok");
    h.db = cardsDb({ cards: true, windowOpenAt: "2020-01-01T00:00:00Z" });
    const res = await cardsCall(fresh());
    expect(res.status).toBe(422);
    expect(renders).toEqual([]);
    expect(sends).toEqual([]);
  });

  it("same permission as sending messages: without inbox.reply, refused", async () => {
    stubFetch("ok");
    h.db = cardsDb({ cards: true });
    h.denied = "inbox.reply";
    expect((await cardsCall(fresh())).status).toBe(403);
    expect(sends).toEqual([]);
  });

  it("cards off: every card action is refused, nothing drawn or sent", async () => {
    stubFetch("ok");
    h.db = cardsDb({ cards: false });
    for (const body of [fresh(), { action: "preview", kind: "customer_offer" }, { action: "save_usage", product_cards: false }]) {
      expect((await cardsCall(body)).status).toBe(403);
    }
    expect(renders).toEqual([]);
    expect(sends).toEqual([]);
    expect(h.db.ops.some((o) => o.kind === "update")).toBe(false);
  });

  it("needs a design and at least one detail", async () => {
    stubFetch("ok");
    h.db = cardsDb({ cards: true });
    expect((await cardsCall({ ...OFFER, kind: "nope" })).status).toBe(400);
    expect((await cardsCall({ ...OFFER, vars: {} })).status).toBe(400);
    expect(sends).toEqual([]);
  });

  it("the Cards page switch is stored on branding, merged over what's there", async () => {
    stubFetch("ok");
    h.db = cardsDb({ cards: true });
    expect((await cardsCall({ action: "save_usage", product_cards: false })).status).toBe(200);
    const update = h.db.ops.find((o) => o.table === "organizations" && o.kind === "update")!;
    expect(update.payload).toEqual({ branding: { product_cards_in_answers: false } });
  });

  it("live preview draws the merchant's values, unmetered", async () => {
    stubFetch("ok");
    h.db = cardsDb({ cards: true });
    const res = await cardsCall({ action: "preview", kind: "customer_offer", vars: { headline: `Preview ${(n += 1)}`, offer: "Buy 1 get 1" } });
    expect(await res.json()).toEqual({ url: CARD_URL });
    expect(renders[0]).toMatchObject({ vars: { headline: `Preview ${n}`, offer: "Buy 1 get 1", validity: "", code: "" } });
    expect(h.db.ops.some((o) => o.table === "ai_usage")).toBe(false);
  });
});

// ------------------------------------------------------------------ campaigns

const recipients = [{ id: "r1", contact_id: "c1", phone: "+919800000001", resolved_variables: { "1": "Asha" } }];

async function runCampaign(sendSettings: Record<string, unknown>, cards: boolean) {
  const db = fakeDb(
    (op) => {
      if (op.table === "campaigns" && op.kind === "select")
        return {
          data: [{ id: "camp", organization_id: "org-10a", whatsapp_account_id: "acc", status: "sending", template_name: "promo", template_language: "en", send_settings: sendSettings }],
          error: null,
        };
      if (op.table === "contacts") return { data: { opt_in_status: "opted_in" }, error: null };
      if (op.table === "campaign_recipients" && op.kind === "select") return { data: null, error: null, count: 1 } as never;
      if (op.table === "feature_flags") return { data: [{ key: "cards", default_enabled: cards }], error: null };
      if (op.table === "conversations") return { data: { id: "cv1", last_customer_message_at: new Date().toISOString() }, error: null };
      return undefined;
    },
    (call) => (call.name === "claim_campaign_recipients" ? { data: recipients, error: null } : undefined),
  );
  h.db = db;
  process.env["CRON_SECRET"] = "s";
  const res = await postOf(CampaignWorker)({ request: new Request("http://x", { method: "POST", headers: { "x-cron-secret": "s" } }) });
  expect(res.status).toBe(200);
  return db;
}

describe("campaigns: a card only when one was attached", () => {
  beforeEach(() => h.sendCampaignTemplate.mockClear());

  it("unchanged: a campaign without a card sends the template only and never looks at cards", async () => {
    stubFetch("ok");
    const send = vi.spyOn(cardsServer, "sendCardToContact");
    const enabled = vi.spyOn(cardsServer, "cardsEnabled");
    const db = await runCampaign({}, true);
    expect(h.sendCampaignTemplate).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(enabled).not.toHaveBeenCalled();
    expect(renders).toEqual([]);
    expect(sends).toEqual([]);
    expect(db.ops.some((o) => o.table === "feature_flags")).toBe(false);
  });

  it("card attached but cards off: the template goes, no card", async () => {
    stubFetch("ok");
    await runCampaign({ card: { kind: "customer_offer", vars: { headline: "Hi {{1}}", code: "FEST20" } } }, false);
    expect(h.sendCampaignTemplate).toHaveBeenCalledTimes(1);
    expect(renders).toEqual([]);
    expect(sends).toEqual([]);
  });

  it("card attached and cards on: the card follows the template with the contact's own details", async () => {
    stubFetch("ok");
    await runCampaign({ card: { kind: "customer_offer", vars: { headline: `Hi {{1}} ${(n += 1)}`, code: "FEST20" } } }, true);
    expect(renders[0]).toMatchObject({ kind: "customer_offer", vars: { headline: `Hi Asha ${n}` } });
    expect(sends).toEqual([{ messaging_product: "whatsapp", to: "+919800000001", type: "image", image: { link: CARD_URL, caption: "promo" } }]);
  });
});

// ------------------------------------------------------------------ inbox text unchanged

describe("unchanged: inbox text and template sends never touch cards", () => {
  beforeEach(() => h.graphFetch.mockClear());

  it("a text reply goes exactly as before", async () => {
    stubFetch("ok");
    const send = vi.spyOn(cardsServer, "sendCardToContact");
    const fallback = vi.spyOn(cardsServer, "sendCardOrFallback");
    h.db = fakeDb((op) => {
      if (op.table === "conversations" && op.kind === "select")
        return { data: { id: "cv1", contact_id: "c1", whatsapp_account_id: "acc", last_customer_message_at: new Date().toISOString() }, error: null };
      if (op.table === "contacts") return { data: { phone: "+919800000001", wa_id: "919800000001", opt_in_status: "opted_in" }, error: null };
      if (op.table === "messages") return { data: { id: "m1", status: "pending" }, error: null };
      return undefined;
    });
    const res = await postOf(SendMessage)({
      request: new Request("http://x", { method: "POST", body: JSON.stringify({ organization_id: "org-10a", conversation_id: "cv1", message_type: "text", body: "hello" }) }),
    });
    expect(res.status).toBe(200);
    expect(h.graphFetch).toHaveBeenCalledTimes(1);
    expect((h.graphFetch.mock.calls[0] as unknown[])[2]).toMatchObject({ body: { type: "text", text: { body: "hello" } } });
    expect(send).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
    expect(renders).toEqual([]);
    expect(h.db.ops.some((o) => o.table === "feature_flags")).toBe(false);
  });
});
