import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 70 — the Meta Pixel and the Conversions API for AiDwar's own ads.
 * Fakes only: fbq, the page (window / document / localStorage), fetch (Graph)
 * and the in-memory database. Nothing reaches Meta, a live database,
 * WhatsApp or Cashfree, and no real token exists anywhere here.
 */

const h = vi.hoisted(() => ({ db: null as null | { supabase: unknown } }));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/billing-notify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./billing-notify.server")>()),
  resolvePlatformOrg: async () => "org-platform",
}));
vi.mock("@/lib/billing-statement.server", () => ({
  buildStatementLines: async () => [],
  planFeeRoiSnapshot: async () => null,
}));

import {
  META_PIXEL_ID,
  hashedUserData,
  isContactHref,
  metaCapiStatusText,
  metaEventId,
  normalizeEmail,
  normalizeFirstName,
  normalizeMetaPhone,
  pixelZone,
  safeParams,
  sha256Hex,
} from "./meta-events";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
const OWNER = "5c0f1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const FAKE_TOKEN = "TEST-not-a-real-token";

// ------------------------------------------------------------------ the page

type FakePage = {
  store: Map<string, string>;
  fbqCalls: unknown[][];
  scripts: string[];
  fetches: { url: string; body: Record<string, unknown> }[];
  setPath: (p: string) => void;
  clickListeners: ((e: { target: unknown }) => void)[];
};

function fakePage(path = "/"): FakePage {
  const page: FakePage = {
    store: new Map(),
    fbqCalls: [],
    scripts: [],
    fetches: [],
    setPath: () => undefined,
    clickListeners: [],
  };
  const location = { pathname: path, search: "", href: `https://aidwar.in${path}` };
  page.setPath = (p) => {
    location.pathname = p;
    location.href = `https://aidwar.in${p}`;
  };
  const localStorage = {
    getItem: (k: string) => page.store.get(k) ?? null,
    setItem: (k: string, v: string) => void page.store.set(k, v),
    removeItem: (k: string) => void page.store.delete(k),
  };
  const win = {
    location,
    localStorage,
    sessionStorage: localStorage,
    addEventListener: () => undefined,
    requestIdleCallback: (cb: () => void) => cb(),
  } as unknown as Window & { fbq?: unknown };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    readyState: "complete",
    head: {
      appendChild: (el: { src: string }) => {
        page.scripts.push(el.src);
        // What fbevents.js does once loaded: drain the queue into our record.
        const fbq = (win as { fbq?: { queue?: unknown[][]; callMethod?: unknown } }).fbq;
        if (fbq) {
          page.fbqCalls.push(...(fbq.queue ?? []));
          fbq.queue = [];
          fbq.callMethod = (...args: unknown[]) => page.fbqCalls.push(args);
        }
      },
    },
    createElement: () => ({ async: false, src: "" }),
    querySelector: (sel: string) => (page.scripts.some((s) => sel.includes(s)) ? {} : null),
    addEventListener: (_t: string, fn: (e: { target: unknown }) => void) =>
      page.clickListeners.push(fn),
    removeEventListener: () => undefined,
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    page.fetches.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true, meta: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return page;
}

/** Every fbq call, after the queue has been drained (the script has "loaded"). */
const allFbq = (page: FakePage) => {
  const fbq = (window as { fbq?: { queue?: unknown[][] } }).fbq;
  return [...page.fbqCalls, ...(fbq?.queue ?? [])];
};
const tracked = (page: FakePage) => allFbq(page).filter((c) => c[0] === "track");

async function pixel() {
  vi.resetModules();
  return import("./meta-pixel");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("(browser) consent: nothing before Accept, never after Decline, choice remembered", () => {
  it("no choice yet: no pixel, no fbq, no script, no relay", async () => {
    const page = fakePage("/pricing");
    const m = await pixel();
    m.pageChanged("/pricing");
    expect(m.track("Lead", metaEventId("Lead", "x1234567"))).toBe(false);
    expect((window as { fbq?: unknown }).fbq).toBeUndefined();
    expect(page.scripts).toEqual([]);
    expect(page.fetches).toEqual([]);
  });

  it("Decline: never loads, and the choice is remembered on the next visit", async () => {
    const page = fakePage("/pricing");
    let m = await pixel();
    m.writeConsent("declined");
    m.pageChanged("/pricing");
    m = await pixel(); // a later visit
    expect(m.readConsent()).toBe("declined");
    m.pageChanged("/");
    expect((window as { fbq?: unknown }).fbq).toBeUndefined();
    expect(page.scripts).toEqual([]);
  });

  it("Accept: autoConfig off, init without advanced matching, one async script, PageView", async () => {
    const page = fakePage("/");
    const m = await pixel();
    m.writeConsent("accepted");
    m.pageChanged("/");
    expect(page.scripts).toEqual(["https://connect.facebook.net/en_US/fbevents.js"]);
    const calls = allFbq(page);
    expect(calls[0]).toEqual(["set", "autoConfig", false, META_PIXEL_ID]);
    expect(calls[1]).toEqual(["init", META_PIXEL_ID]); // no 3rd argument: no advanced matching
    expect(tracked(page).map((c) => c[1])).toEqual(["PageView"]);
    expect(m.readConsent()).toBe("accepted");
  });
});

describe("(browser) where it runs", () => {
  it("never on /app working pages or /admin; quiet on /login, onboarding and billing", () => {
    for (const p of [
      "/app",
      "/app/inbox",
      "/app/contacts",
      "/app/campaigns",
      "/app/flows/v2/x",
      "/app/templates",
      "/admin",
      "/admin/billing",
    ])
      expect(pixelZone(p), p).toBeNull();
    for (const p of ["/login", "/app/start", "/app/billing"]) expect(pixelZone(p), p).toBe("quiet");
    for (const p of [
      "/",
      "/pricing",
      "/demo",
      "/developers",
      "/developers/api",
      "/signup",
      "/privacy",
    ])
      expect(pixelZone(p), p).toBe("public");
  });

  it("no fbq call on /app/* working pages or /admin/*, even with consent", async () => {
    const page = fakePage("/app/inbox");
    const m = await pixel();
    m.writeConsent("accepted");
    for (const p of ["/app/inbox", "/app/contacts", "/admin/billing"]) {
      page.setPath(p);
      m.pageChanged(p);
      expect(m.track("Purchase", metaEventId("Purchase", "pay-1"), { value: 1 })).toBe(false);
      m.contactClicked("mailto:support@aidwar.in", p);
    }
    expect((window as { fbq?: unknown }).fbq).toBeUndefined();
    expect(page.scripts).toEqual([]);
    expect(page.fetches).toEqual([]);
  });

  it("/login and onboarding/billing get no PageView", async () => {
    const page = fakePage("/login");
    const m = await pixel();
    m.writeConsent("accepted");
    m.pageChanged("/login");
    page.setPath("/app/billing");
    m.pageChanged("/app/billing");
    expect(tracked(page)).toEqual([]);
  });
});

describe("(browser) events", () => {
  it("PageView on each public route change; ViewContent (+ server copy, same id) on pricing / developers", async () => {
    const page = fakePage("/");
    const m = await pixel();
    m.writeConsent("accepted");
    for (const p of ["/", "/pricing", "/developers/api"]) {
      page.setPath(p);
      m.pageChanged(p);
    }
    const t = tracked(page);
    expect(t.filter((c) => c[1] === "PageView")).toHaveLength(3);
    const views = t.filter((c) => c[1] === "ViewContent");
    expect(views.map((c) => c[2])).toEqual([
      { content_name: "Pricing" },
      { content_name: "Developers" },
    ]);
    const relayed = page.fetches.filter((f) => f.url === "/api/public/meta-event");
    expect(relayed.map((f) => f.body["event_id"])).toEqual(
      views.map((c) => (c[3] as { eventID: string }).eventID),
    );
    expect(relayed.every((f) => f.body["consent"] === true)).toBe(true);
  });

  it("Contact on our email / phone / WhatsApp links on public pages", async () => {
    const page = fakePage("/pricing");
    const m = await pixel();
    m.writeConsent("accepted");
    m.contactClicked("mailto:support@aidwar.in?subject=AiDwar%20Enterprise", "/pricing");
    m.contactClicked("/signup", "/pricing");
    expect(tracked(page).map((c) => c[1])).toEqual(["Contact"]);
    expect(isContactHref("https://wa.me/919999999999")).toBe(true);
    expect(isContactHref("tel:+911234567890")).toBe(true);
    expect(isContactHref("https://aidwar.in/pricing")).toBe(false);
  });

  it("no parameter but value, currency, predicted_ltv and a page name ever reaches fbq", async () => {
    const page = fakePage("/demo");
    const m = await pixel();
    m.writeConsent("accepted");
    m.track("Lead", metaEventId("Lead", "abc12345"), {
      value: 0,
      email: "owner@zoori.test",
      phone: "+918121310333",
      name: "Asha",
      workspace: "ZOORI Jewels",
      content_name: "Demo",
    });
    const params = tracked(page)[0]![2] as Record<string, unknown>;
    expect(Object.keys(params).sort()).toEqual(["content_name", "currency", "value"]);
    expect(JSON.stringify(allFbq(page))).not.toMatch(/zoori|8121310333|Asha/i);
  });

  it("Subscribe / Purchase fire once per payment, even after a reload", async () => {
    const page = fakePage("/app/billing");
    let m = await pixel();
    m.writeConsent("accepted");
    const meta = {
      event: "Subscribe" as const,
      event_id: metaEventId("Subscribe", "pay-1"),
      params: { value: 4999, currency: "INR" as const, predicted_ltv: 59988 },
    };
    expect(m.fireFromServer(meta)).toBe(true);
    expect(m.fireFromServer(meta)).toBe(false);
    m = await pixel(); // reload: the same browser storage, a fresh page
    expect(m.fireFromServer(meta)).toBe(false);
    const subs = tracked(page).filter((c) => c[1] === "Subscribe");
    expect(subs).toHaveLength(1);
    expect(subs[0]![3]).toEqual({ eventID: "Subscribe.pay-1" });
  });

  it("debug flag: logged to the console, the pixel never loads", async () => {
    const page = fakePage("/");
    const m = await pixel();
    m.writeConsent("accepted");
    page.store.set(m.DEBUG_KEY, "1");
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    m.pageChanged("/pricing");
    expect(page.scripts).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "[meta-pixel]",
      "PageView",
      expect.objectContaining({ eventID: expect.any(String) }),
    );
  });
});

// ---------------------------------------------------------------- the server

type Graph = { url: string; body: Record<string, unknown> };

function world(
  extra: Record<string, Row[]> = {},
): MemoryDb & { graph: Graph[]; users: Map<string, Row> } {
  const graph: Graph[] = [];
  const users = new Map<string, Row>([
    [
      OWNER,
      {
        id: OWNER,
        email: "  Vinay.Kumar@Example.COM ",
        created_at: new Date(Date.now() - 60_000).toISOString(),
        user_metadata: { phone: "81213 10333" },
      },
    ],
  ]);
  const db = memoryDb({
    organizations: [
      {
        id: ORG,
        name: "ZOORI Jewels",
        plan_version_id: "pv-growth",
        plan_status: "active",
        created_at: new Date().toISOString(),
      },
    ],
    organization_members: [
      { organization_id: ORG, user_id: OWNER, role: "owner", created_at: "2026-11-01T00:00:00Z" },
    ],
    profiles: [{ id: OWNER, full_name: "Vinay Kumar", phone: null }],
    plan_versions: [
      { id: "pv-starter", price_monthly: 2499 },
      { id: "pv-growth", price_monthly: 4999 },
    ],
    organization_billing_settings: [
      { organization_id: ORG, plan_fee_override: null, limits_override: {} },
    ],
    // A merchant's customer: must never appear in anything sent to Meta.
    contacts: [{ id: "c-1", organization_id: ORG, name: "Priya Customer", phone: "+919000000001" }],
    activity_log: [],
    payments: [],
    invoices: [],
    ...extra,
  });
  Object.assign(db.supabase as object, {
    auth: {
      admin: { getUserById: async (id: string) => ({ data: { user: users.get(id) ?? null } }) },
    },
  });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    graph.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) });
    return new Response(JSON.stringify({ events_received: 1 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  h.db = { supabase: db.supabase };
  return Object.assign(db, { graph, users });
}

const ownersRequest = () =>
  new Request("https://aidwar.in/api/public/meta-event", {
    method: "POST",
    headers: {
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "Mozilla/5.0 test",
      cookie: "_fbp=fb.1.1700000000000.123456789; _fbc=fb.1.1700000000000.AbCdEf; sb-auth=secret",
      referer: "https://aidwar.in/app/start",
    },
  });

describe("(server) hashing per Meta's spec, known vectors", () => {
  it("email, phone (Batch 66 rule), first name, external id", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(normalizeEmail("  Test@Example.com ")).toBe("test@example.com");
    expect(await sha256Hex("test@example.com")).toBe(
      "973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b",
    );
    expect(normalizeMetaPhone("81213 10333")).toBe("918121310333");
    expect(normalizeMetaPhone("+91 81213-10333")).toBe("918121310333");
    expect(await sha256Hex("918121310333")).toBe(
      "b74c1c5b12476eb824cbd1070e0a3b1bc175633e4f940ed87ac2ca191b45ada9",
    );
    expect(normalizeFirstName("  Vinay Kumar")).toBe("vinay");
    expect(await sha256Hex("vinay")).toBe(
      "8c11949fd243dc12aabffc7d86cefe693e67e95db168875e08e37024e04536f1",
    );
    expect(await hashedUserData({ email: null, phone: "12", firstName: "", userId: null })).toEqual(
      {},
    );
  });

  it("only allowed parameters, INR, finite money", () => {
    expect(
      safeParams({ value: "4999", predicted_ltv: 59988, email: "x@y.z", currency: "USD" }),
    ).toEqual({
      value: 4999,
      predicted_ltv: 59988,
      currency: "INR",
    });
    expect(safeParams({ value: -1, content_name: "<script>" })).toEqual({});
  });
});

describe("(server) the Conversions API sender", () => {
  beforeEach(async () => {
    const { resetMetaCapiForTests } = await import("./meta-capi.server");
    resetMetaCapiForTests();
  });

  it("token missing: nothing sent, no crash, logged once", async () => {
    const w = world();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { sendMetaEvent, queueMetaEvent } = await import("./meta-capi.server");
    expect(await sendMetaEvent(w.supabase, { event: "Lead", eventId: "Lead.abcdefgh" }, {})).toBe(
      "token_missing",
    );
    await queueMetaEvent(w.supabase, { event: "Lead", eventId: "Lead.abcdefgh" });
    expect(w.graph).toEqual([]);
    expect(log.mock.calls.filter((c) => String(c[0]).includes("token_missing"))).toHaveLength(1);
  });

  it("StartTrial for the owner: hashed em/ph/fn/external_id, request facts, same id, token only in the body", async () => {
    vi.stubEnv("META_CAPI_TOKEN", FAKE_TOKEN);
    vi.stubEnv("META_CAPI_TEST_CODE", "TEST123");
    const w = world();
    const { sendMetaEvent } = await import("./meta-capi.server");
    const out = await sendMetaEvent(w.supabase, {
      event: "StartTrial",
      eventId: metaEventId("StartTrial", ORG),
      params: { value: 0, currency: "INR", predicted_ltv: 29994 },
      userId: OWNER,
      request: ownersRequest(),
      sourceUrl: "https://aidwar.in/app/start",
      once: true,
    });
    expect(out).toBe("sent");
    expect(w.graph).toHaveLength(1);
    const { url, body } = w.graph[0]!;
    expect(url).toBe(`https://graph.facebook.com/v25.0/${META_PIXEL_ID}/events`);
    expect(url).not.toContain(FAKE_TOKEN);
    expect(body["access_token"]).toBe(FAKE_TOKEN);
    expect(body["test_event_code"]).toBe("TEST123");
    const event = (body["data"] as Row[])[0]!;
    expect(event).toMatchObject({
      event_name: "StartTrial",
      event_id: `StartTrial.${ORG.replace(/-/g, "-")}`,
      action_source: "website",
      event_source_url: "https://aidwar.in/app/start",
      custom_data: { value: 0, currency: "INR", predicted_ltv: 29994 },
    });
    // Batch 72: + ln (last name) and country (from a +91 number), both hashed.
    expect(event["user_data"]).toEqual({
      em: [sha("vinay.kumar@example.com")],
      ph: [sha("918121310333")],
      fn: [sha("vinay")],
      ln: [sha("kumar")],
      country: [sha("in")],
      external_id: [sha(OWNER)],
      client_ip_address: "203.0.113.7",
      client_user_agent: "Mozilla/5.0 test",
      fbp: "fb.1.1700000000000.123456789",
      fbc: "fb.1.1700000000000.AbCdEf",
    });
    // No merchant / customer data, and no other cookie.
    const sent = JSON.stringify(body);
    expect(sent).not.toMatch(/Priya|9000000001|ZOORI|sb-auth|secret|Vinay|8121310333/i);
  });

  it("opt-out respected: a user with meta_share_opt_out is never sent", async () => {
    vi.stubEnv("META_CAPI_TOKEN", FAKE_TOKEN);
    const w = world();
    w.users.get(OWNER)!["user_metadata"] = { meta_share_opt_out: true };
    const { sendMetaEvent, metaWorkspaceFirst } = await import("./meta-capi.server");
    expect(
      await sendMetaEvent(w.supabase, {
        event: "StartTrial",
        eventId: "StartTrial.abcdefgh1",
        userId: OWNER,
      }),
    ).toBe("opted_out");
    await metaWorkspaceFirst(w.supabase, ORG, "WhatsAppConnected"); // via the owner
    expect(w.graph).toEqual([]);
  });

  it("once per workspace: the 'First' events go once, however often they happen", async () => {
    vi.stubEnv("META_CAPI_TOKEN", FAKE_TOKEN);
    const w = world();
    const { emitEvent } = await import("./events.server");
    for (let i = 0; i < 3; i += 1)
      await emitEvent(w.supabase, "whatsapp.connected", {
        organizationId: ORG,
        entityType: "whatsapp_account",
        properties: { whatsapp_account_id: "wa-1" },
      });
    await emitEvent(w.supabase, "campaign.completed", {
      organizationId: ORG,
      entityType: "campaign",
      properties: { campaign_id: "c0", sent_count: 0 },
    });
    await emitEvent(w.supabase, "campaign.completed", {
      organizationId: ORG,
      entityType: "campaign",
      properties: { campaign_id: "c1", sent_count: 12 },
    });
    await emitEvent(w.supabase, "campaign.completed", {
      organizationId: ORG,
      entityType: "campaign",
      properties: { campaign_id: "c2", sent_count: 40 },
    });
    const names = w.graph.map((g) => (g.body["data"] as Row[])[0]!["event_name"]);
    expect(names).toEqual(["WhatsAppConnected", "FirstCampaignSent"]);
    const campaign = (w.graph[1]!.body["data"] as Row[])[0]!;
    // The campaign worker's request is not the owner's: no ip / user agent.
    expect(campaign["action_source"]).toBe("system_generated");
    expect(campaign["user_data"]).not.toHaveProperty("client_ip_address");
    const { metaWorkspaceFirst } = await import("./meta-capi.server");
    await metaWorkspaceFirst(w.supabase, ORG, "FirstFlowActivated");
    await metaWorkspaceFirst(w.supabase, ORG, "FirstFlowActivated");
    await metaWorkspaceFirst(w.supabase, ORG, "AidenEnabled");
    expect(w.graph.map((g) => (g.body["data"] as Row[])[0]!["event_name"]).slice(2)).toEqual([
      "FirstFlowActivated",
      "AidenEnabled",
    ]);
  });

  it("PlanUpgraded only for a move up from a paid plan", async () => {
    vi.stubEnv("META_CAPI_TOKEN", FAKE_TOKEN);
    const w = world();
    const { metaPlanChanged } = await import("./meta-capi.server");
    await metaPlanChanged(w.supabase, ORG, null, "pv-growth"); // first plan: Subscribe, not an upgrade
    await metaPlanChanged(w.supabase, ORG, "pv-growth", "pv-starter"); // down
    await metaPlanChanged(w.supabase, ORG, "pv-starter", "pv-growth"); // up
    await metaPlanChanged(w.supabase, ORG, "pv-starter", "pv-growth"); // the same change again
    expect(w.graph).toHaveLength(1);
    expect((w.graph[0]!.body["data"] as Row[])[0]).toMatchObject({
      event_name: "PlanUpgraded",
      action_source: "system_generated",
      custom_data: { value: 4999, currency: "INR" },
    });
  });

  it("Subscribe on every confirmed plan payment (a Batch 68 offline record too), once, same id as the browser", async () => {
    vi.stubEnv("META_CAPI_TOKEN", FAKE_TOKEN);
    const PAY = "11111111-2222-4333-8444-555555555555";
    const w = world({
      invoices: [
        {
          id: "inv-1",
          organization_id: ORG,
          purpose: "plan_fee",
          kind: "invoice",
          status: "issued",
          total: 4999,
          amount_paid: 0,
          period_start: "2026-11-10",
        },
      ],
      payments: [
        {
          id: PAY,
          organization_id: ORG,
          provider: "manual",
          method: "bank_transfer",
          purpose: "plan_fee",
          amount: 5000,
          currency: "INR",
          status: "created",
          raw: { invoice_id: "inv-1", gross_amount: 5000, reference: "631500744741" },
        },
      ],
    });
    const { settlePayment } = await import("./billing.server");
    const facts = {
      paise: 500000,
      status: "captured",
      currency: "INR",
      method: "bank_transfer",
      methodDetail: "631500744741",
      orderId: null,
    };
    await settlePayment(w.supabase, PAY, null, { source: "test" }, facts);
    await settlePayment(w.supabase, PAY, null, { source: "test" }, facts); // a retry: already paid
    expect(w.rows("payments")[0]!["status"]).toBe("paid");
    expect(w.graph).toHaveLength(1);
    const event = (w.graph[0]!.body["data"] as Row[])[0]!;
    expect(event).toMatchObject({
      event_name: "Subscribe",
      event_id: `Subscribe.${PAY}`,
      action_source: "system_generated",
      custom_data: { value: 5000, currency: "INR", predicted_ltv: 4999 * 12 },
    });
    // A Super Admin / webhook request is never the owner's: no ip, user agent or cookies.
    // Batch 72: + ln and country, hashed.
    expect(Object.keys(event["user_data"] as Row).sort()).toEqual([
      "country",
      "em",
      "external_id",
      "fn",
      "ln",
      "ph",
    ]);

    // The browser asks what to fire: exactly the same name, id and value.
    const { Route } = await import("@/routes/api/public/meta-event");
    const POST = (
      Route as unknown as {
        options: {
          server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> };
        };
      }
    ).options.server.handlers["POST"]!;
    const res = await POST({
      request: new Request("https://aidwar.in/api/public/meta-event", {
        method: "POST",
        body: JSON.stringify({ event: "payment", payment_id: PAY }),
      }),
    });
    expect(((await res.json()) as Row)["meta"]).toEqual({
      event: "Subscribe",
      event_id: `Subscribe.${PAY}`,
      params: { value: 5000, currency: "INR", predicted_ltv: 59988 },
    });
    expect(w.graph).toHaveLength(1); // that lookup sends nothing
  });

  it("Purchase on a confirmed credit top-up, once per payment", async () => {
    vi.stubEnv("META_CAPI_TOKEN", FAKE_TOKEN);
    const PAY = "22222222-2222-4333-8444-555555555555";
    const w = world({
      payments: [
        {
          id: PAY,
          organization_id: ORG,
          provider: "cashfree",
          purpose: "credit_purchase",
          amount: 2000,
          currency: "INR",
          status: "created",
          raw: { gross_amount: 2000, pack_amount: 2000, bonus: 0 },
        },
      ],
      wallet_ledger: [],
    });
    Object.assign(w.supabase as object, {
      rpc: async () => ({ data: "ledger-1", error: null }),
    });
    const { settlePayment } = await import("./billing.server");
    const facts = {
      paise: 200000,
      status: "captured",
      currency: "INR",
      method: "upi",
      methodDetail: null,
      orderId: PAY,
    };
    await settlePayment(w.supabase, PAY, "cf-1", {}, facts);
    await settlePayment(w.supabase, PAY, "cf-1", {}, facts);
    expect(w.graph).toHaveLength(1);
    expect((w.graph[0]!.body["data"] as Row[])[0]).toMatchObject({
      event_name: "Purchase",
      event_id: `Purchase.${PAY}`,
      custom_data: { value: 2000, currency: "INR" },
    });
  });

  it("InitiateCheckout: the server's id and value are what the browser fires", async () => {
    vi.stubEnv("META_CAPI_TOKEN", FAKE_TOKEN);
    const PAY = "33333333-2222-4333-8444-555555555555";
    const w = world({
      payments: [
        {
          id: PAY,
          organization_id: ORG,
          purpose: "plan_fee",
          amount: 4999,
          status: "pending",
          raw: { gross_amount: 4999 },
        },
      ],
    });
    const { metaCheckoutStarted } = await import("./meta-capi.server");
    const meta = await metaCheckoutStarted(w.supabase, {
      paymentId: PAY,
      userId: OWNER,
      request: ownersRequest(),
    });
    expect(meta).toEqual({
      event: "InitiateCheckout",
      event_id: `InitiateCheckout.${PAY}`,
      params: { value: 4999, currency: "INR" },
    });
    const event = (w.graph[0]!.body["data"] as Row[])[0]!;
    expect(event["event_id"]).toBe(meta!.event_id);
    expect(event["custom_data"]).toEqual(meta!.params);
  });

  it("the relay: ViewContent / Contact only with consent; CompleteRegistration only for a new account", async () => {
    vi.stubEnv("META_CAPI_TOKEN", FAKE_TOKEN);
    const w = world();
    const { Route } = await import("@/routes/api/public/meta-event");
    const POST = (
      Route as unknown as {
        options: {
          server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> };
        };
      }
    ).options.server.handlers["POST"]!;
    const call = (body: Row) =>
      POST({
        request: new Request("https://aidwar.in/api/public/meta-event", {
          method: "POST",
          headers: { "user-agent": "Mozilla/5.0 test", "x-forwarded-for": "203.0.113.9" },
          body: JSON.stringify(body),
        }),
      });
    await call({
      event: "ViewContent",
      event_id: "ViewContent.abcdef12",
      content_name: "Pricing",
      url: "https://aidwar.in/pricing",
    });
    expect(w.graph).toHaveLength(0); // no consent flag
    await call({
      event: "ViewContent",
      event_id: "ViewContent.abcdef12",
      content_name: "Pricing",
      consent: true,
      url: "https://evil.example/x",
    });
    expect(w.graph).toHaveLength(0); // not our page
    await call({
      event: "ViewContent",
      event_id: "ViewContent.abcdef12",
      content_name: "Pricing",
      consent: true,
      url: "https://aidwar.in/pricing?utm=1",
    });
    expect(w.graph).toHaveLength(1);
    expect((w.graph[0]!.body["data"] as Row[])[0]).toMatchObject({
      event_name: "ViewContent",
      event_id: "ViewContent.abcdef12",
      event_source_url: "https://aidwar.in/pricing",
      custom_data: { content_name: "Pricing" },
    });
    expect((w.graph[0]!.body["data"] as Row[])[0]!["user_data"] as Row).not.toHaveProperty("em");

    await call({ event: "CompleteRegistration", user_id: OWNER, url: "https://aidwar.in/signup" });
    // Batch 78: sign-up sends CompleteRegistration only — "Lead" means a
    // verified WhatsApp number (/start), so sign-up no longer sends one.
    expect(w.graph).toHaveLength(2);
    expect((w.graph[1]!.body["data"] as Row[])[0]).toMatchObject({
      event_name: "CompleteRegistration",
      event_id: `CompleteRegistration.${OWNER}`,
    });
    // An old account (or a made-up id) is never sent.
    w.users.get(OWNER)!["created_at"] = new Date(Date.now() - 3600_000).toISOString();
    await call({ event: "CompleteRegistration", user_id: OWNER });
    await call({ event: "CompleteRegistration", user_id: "99999999-2222-4333-8444-555555555555" });
    expect(w.graph).toHaveLength(2);
  });
});

describe("(server) Super Admin's status line, portability", () => {
  it("token missing / connected + last send / last error; never the token", async () => {
    const w = world();
    const { metaCapiStatus, sendMetaEvent } = await import("./meta-capi.server");
    const missing = await metaCapiStatus(w.supabase, {});
    expect(metaCapiStatusText(missing)).toBe(
      "Meta Conversions API: token missing (add the META_CAPI_TOKEN secret).",
    );
    const env = { META_CAPI_TOKEN: FAKE_TOKEN };
    await sendMetaEvent(w.supabase, { event: "Lead", eventId: "Lead.abcdefgh" }, env);
    const ok = await metaCapiStatus(w.supabase, env);
    expect(ok).toMatchObject({
      token: "connected",
      last_ok_at: expect.any(String),
      last_error: null,
    });
    expect(metaCapiStatusText(ok)).toMatch(/^Meta Conversions API: connected · last send ok at /);
    expect(JSON.stringify(ok)).not.toContain(FAKE_TOKEN);

    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({ error: { code: 190, message: "Invalid OAuth access token" } }),
          { status: 400 },
        ),
    );
    // A later failure (one second on, so the newest row is the error).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 1000));
    await sendMetaEvent(w.supabase, { event: "Lead", eventId: "Lead.bcdefghi" }, env);
    vi.useRealTimers();
    const bad = await metaCapiStatus(w.supabase, env);
    expect(bad.last_error).toMatchObject({ code: 190, event: "Lead" });
    expect(metaCapiStatusText(bad)).toMatch(/last error 190 \(Lead\)/);
  });

  it("the token is read only from META_CAPI_TOKEN in server code, never in the client bundle", () => {
    const server = readFileSync("src/lib/meta-capi.server.ts", "utf8");
    expect(server).toContain('env["META_CAPI_TOKEN"]');
    for (const f of [
      "src/lib/meta-pixel.ts",
      "src/lib/meta-events.ts",
      "src/components/meta-pixel-runtime.tsx",
      "src/components/admin/meta-capi-status.tsx",
      "src/components/settings/meta-sharing-card.tsx",
    ])
      expect(readFileSync(f, "utf8"), f).not.toMatch(
        /process\.env|import\(\s*"@\/lib\/meta-capi\.server"|from "@\/lib\/meta-capi\.server"|env\["META_CAPI_TOKEN"\]/,
      );
    // The pixel id lives in one constant.
    const ids = [
      "src/lib/meta-pixel.ts",
      "src/lib/meta-capi.server.ts",
      "src/components/meta-pixel-runtime.tsx",
    ].filter((f) => readFileSync(f, "utf8").includes("1601012231234080"));
    expect(ids).toEqual([]);
  });

  it("settlePayment calls the Meta hook only after the payment is marked paid, in all three branches", () => {
    const billing = readFileSync("src/lib/billing.server.ts", "utf8");
    const hooks = [
      ...billing.matchAll(
        /await markPaidNow\(\);\n(?:.*\n){0,1}\s*(?:\/\/.*\n\s*)?await metaSettled\(/g,
      ),
    ];
    expect(hooks).toHaveLength(3);
  });
});
