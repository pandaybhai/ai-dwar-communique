import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 82 — /199: pay ₹199 for 30 days of AiDwar Basic; our team calls to set
 * it up and convert. Fakes only: the database is in memory, Cashfree's order
 * call is a stub that records what it was asked to charge, Graph is a stub.
 * Nothing reaches live Meta, Cashfree, WhatsApp or the database.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  orders: [] as Array<Record<string, unknown>>,
  request: null as Request | null,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/permissions.server", () => ({ hasPermission: async () => true }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => h.request }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: unknown; to: string }) => (
    <a href={to}>{children as never}</a>
  ),
  useNavigate: () => async () => undefined,
}));
vi.mock("@/lib/cashfree.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cashfree.server")>()),
  cashfreeConfig: () => ({ env: "sandbox", clientId: "test", clientSecret: "test", baseUrl: "x" }),
}));
vi.mock("@/lib/cashfree-billing.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cashfree-billing.server")>()),
  orderCustomer: async () => ({
    id: "c",
    name: "Asha",
    email: "a@example.com",
    phone: "9812345670",
  }),
  startCashfreeOrder: async (_s: unknown, _c: unknown, input: Record<string, unknown>) => {
    h.orders.push(input);
    return { checkout: { payment_session_id: "s", mode: "sandbox" }, url: "/pay/x" };
  },
}));

import {
  AFTER_30_DAYS,
  HERO_199,
  OFFER_USED_199,
  ORDER_199,
  PRICE_BLOCK_199,
  STICKY_199,
  SUCCESS_199,
} from "./page-199";
import { PAGE_199, introCheck199, startCheckoutPayment } from "./checkout-999.server";
import { nextPeriodEnd } from "./plan-period.server";
import { accessBanner, daysLeft, phoneLast4, sortRenewals } from "./renewals";

const PLATFORM = "00000000-0000-4000-8000-00000000aaaa";
const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG = "33333333-3333-4333-8333-333333333333";
const OTHER_OWNER = "44444444-4444-4444-8444-444444444444";
const ADMIN = "66666666-6666-4666-8666-666666666666";
const BASIC_V = "55555555-5555-4555-8555-555555555555";
/** The checkout route's first step (a request field, not an activity action). */
const LEAD_STEP = "lead";

beforeEach(() => {
  vi.stubEnv("PLATFORM_ORG_ID", PLATFORM);
  vi.stubEnv("META_CAPI_TOKEN", "TEST-not-a-real-token");
  vi.stubEnv("META_CAPI_TEST_CODE", "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  h.orders = [];
  h.request = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function world(extra: Record<string, Row[]> = {}): MemoryDb {
  const db = memoryDb(
    {
      plans: [
        {
          key: "basic",
          name: "Basic",
          is_active: true,
          is_public: false,
          plan_versions: [
            {
              id: BASIC_V,
              price_monthly: 999,
              currency: "INR",
              limits: {},
              highlights: [],
              features: ["billing", "cashfree_billing", "meta_direct_billing"],
              is_current: true,
            },
          ],
        },
      ],
      organizations: [
        { id: ORG, name: "Asha Jewellers", plan_status: "trial", plan_version_id: null },
        { id: OTHER_ORG, name: "Old Shop", plan_status: "active", billing_account_id: "ba-old" },
      ],
      organization_members: [
        { organization_id: ORG, user_id: OWNER, role: "owner", created_at: "2026-11-19T00:00:00Z" },
        {
          organization_id: OTHER_ORG,
          user_id: OTHER_OWNER,
          role: "owner",
          created_at: "2026-10-01T00:00:00Z",
        },
        { organization_id: ORG, user_id: ADMIN, role: "owner", created_at: "2026-11-19T00:00:01Z" },
      ],
      profiles: [
        { id: OWNER, email: "asha@example.com", full_name: "Asha Rao", phone: "+919812345670" },
        {
          id: OTHER_OWNER,
          email: "old@example.com",
          full_name: "Ravi Kumar",
          phone: "+919000011111",
        },
        { id: ADMIN, email: "vinay@example.com", full_name: "Vinay", is_super_admin: true },
      ],
      billing_accounts: [{ id: "ba-old", billing_whatsapp: "+919000022222" }],
      platform_settings: [{ id: true, gst_registered: false }],
      payments: [],
      demo_leads: [],
      activity_log: [],
      meta_capi_log: [],
      ...extra,
    },
    {},
  );
  Object.assign(db.supabase as object, {
    auth: {
      admin: {
        getUserById: async (id: string) => ({
          data: { user: { id, email: "asha@example.com", created_at: "2026-11-19T00:00:00Z" } },
        }),
      },
    },
  });
  h.db = { supabase: db.supabase };
  return db;
}

const paidPayment = (org: string, raw: Row = {}): Row => ({
  id: `paid-${org}`,
  organization_id: org,
  purpose: "plan_fee",
  status: "paid",
  amount: 999,
  paid_at: "2026-10-05T10:00:00Z",
  raw,
});

/* =========================================================== the offer === */

describe("₹199 is set on the server, once per number and workspace", () => {
  it("a new workspace and number: the Cashfree order is ₹199, raw says the offer, list price and the check", async () => {
    const w = world();
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: null,
      phone: "98123 45670",
      page: PAGE_199,
    });
    expect(out.ok).toBe(true);
    const pay = w.rows("payments")[0]!;
    expect(pay).toMatchObject({ amount: 199, purpose: "plan_fee", provider: "cashfree" });
    expect(pay["raw"]).toMatchObject({
      source: "landing_199",
      offer: "paid_trial_199",
      list_price: 999,
      intro_check: "eligible",
      plan_version_id: BASIC_V,
      gross_amount: 199, // no GST: gst_registered false
    });
    expect(h.orders[0]).toMatchObject({ gross: 199 });
    expect(String(h.orders[0]!["note"])).toContain("30 days (₹199 offer)");
    // The plan's own price is untouched (₹999 for every later choice).
    expect((w.rows("plans")[0]!["plan_versions"] as Row[])[0]!["price_monthly"]).toBe(999);
  });

  it("an amount sent by the browser is ignored: the route has no amount field, the server decides", async () => {
    const w = world();
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: null,
      phone: "98123 45670",
      page: PAGE_199,
      // anything a browser might add
      ...({ amount: 1, price: 1, gross: 1 } as Record<string, unknown>),
    });
    expect(out.ok).toBe(true);
    expect(w.rows("payments")[0]!["amount"]).toBe(199);
    const route = readFileSync("src/routes/api/public/checkout-199.ts", "utf8");
    expect(route).not.toMatch(/body\["(amount|price|gross)"\]/);
  });

  it("a workspace that already paid: no order, the offer-used answer, nothing created", async () => {
    const w = world({ payments: [paidPayment(ORG)] });
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: null,
      phone: "98123 45670",
      page: PAGE_199,
    });
    expect(out).toEqual({
      ok: false,
      status: 409,
      code: "offer_used",
      error: OFFER_USED_199,
    });
    expect(w.rows("payments")).toHaveLength(1); // only the old one
    expect(h.orders).toHaveLength(0);
  });

  it("the same number with a new email and a new workspace: offer used (phone_paid) — no ₹999 fallback", async () => {
    // The number paid before as another workspace's owner.
    const w = world({
      payments: [paidPayment(OTHER_ORG)],
      profiles: [
        { id: OWNER, email: "new@example.com", full_name: "Asha", phone: "+919812345670" },
        { id: OTHER_OWNER, email: "old@example.com", full_name: "Ravi", phone: "+919812345670" },
      ],
    });
    expect(
      await introCheck199(w.supabase as never, { organizationId: ORG, phone: "98123 45670" }),
    ).toBe("phone_paid");
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: null,
      phone: "98123 45670",
      page: PAGE_199,
    });
    expect(out).toMatchObject({ ok: false, code: "offer_used" });
    expect(h.orders).toHaveLength(0);
    expect(w.rows("payments").filter((p) => p["organization_id"] === ORG)).toHaveLength(0);
  });

  it("'paid before' is a paid lead, an owner's phone or a billing WhatsApp — and +91 / 0 / spaces all match", async () => {
    const lead = world({
      demo_leads: [
        { id: "l1", phone: "+919812345670", source: "landing_999", paid_at: "2026-11-01" },
      ],
    });
    for (const typed of ["+91 98123 45670", "098123 45670", "9812345670", "98123-45670"]) {
      expect(
        await introCheck199(lead.supabase as never, { organizationId: null, phone: typed }),
        typed,
      ).toBe("phone_paid");
    }
    const billing = world({ payments: [paidPayment(OTHER_ORG)] });
    expect(
      await introCheck199(billing.supabase as never, {
        organizationId: null,
        phone: "90000 22222",
      }),
    ).toBe("phone_paid");
    // A paid lead or workspace for another number doesn't count; an unpaid one neither.
    const fresh = world({
      demo_leads: [{ id: "l2", phone: "+919812345670", source: "landing_999", paid_at: null }],
    });
    expect(
      await introCheck199(fresh.supabase as never, { organizationId: ORG, phone: "98123 45670" }),
    ).toBe("eligible");
  });

  it("the Super Admin ₹1 test works on /199 (even from a workspace that paid); anyone else is refused", async () => {
    const w = world({ payments: [paidPayment(ORG)] });
    const refused = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: null,
      phone: "98123 45670",
      page: PAGE_199,
      adminTestPrice: 1,
    });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    const admin = await startCheckoutPayment(w.supabase as never, {
      userId: ADMIN,
      leadId: null,
      phone: "90000 00001",
      organizationId: ORG,
      page: PAGE_199,
      adminTestPrice: 1,
    });
    expect(admin.ok).toBe(true);
    const pay = w.rows("payments").at(-1)!;
    expect(pay).toMatchObject({ amount: 1 });
    expect(pay["raw"]).toMatchObject({ admin_test: true, source: "landing_199" });
    expect(h.orders.at(-1)).toMatchObject({ gross: 1 });
  });

  it("the route: a used number is told right after its lead is saved (the team still has the lead)", async () => {
    const w = world({
      demo_leads: [
        { id: "l1", phone: "+919812345670", source: "landing_999", paid_at: "2026-11-01" },
      ],
    });
    vi.stubEnv("START_LEAD_SECRET", "test-secret-not-real-0123456789abcdef");
    const { Route } = await import("@/routes/api/public/checkout-199");
    const post = (
      Route.options as unknown as {
        server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> };
      }
    ).server.handlers["POST"]!;
    const res = await post({
      request: new Request("https://aidwar.in/api/public/checkout-199", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: LEAD_STEP, phone: "098123 45670", name: "Asha Rao" }),
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: OFFER_USED_199, code: "offer_used" });
    const saved = w.rows("demo_leads").find((l) => l["source"] === "landing_199");
    expect(saved).toMatchObject({ phone: "+919812345670", landing_path: "/199" });
  });
});

/* ======================================================= the checkout === */

describe("the /199 checkout sheet", () => {
  it("summary 'AiDwar Basic · 30 days · Total today ₹199', Pay ₹199, the offer-used screen, the success line", () => {
    expect(ORDER_199).toMatchObject({
      title: "AiDwar Basic",
      line: "30 days",
      total: "Total today ₹199",
      pay: "Pay ₹199",
    });
    const sheet = readFileSync("src/components/p199/checkout-199.tsx", "utf8");
    expect(sheet).toContain("{ORDER.title} · {ORDER.line}");
    expect(sheet).toContain("Total today ₹{price}");
    expect(sheet).toContain("const price = adminTestPrice === 1 ? 1 : 199;");
    expect(sheet).toContain('"/api/public/checkout-199"');
    expect(sheet).not.toContain('"/api/public/checkout-999"');
    expect(sheet).toContain('data-testid="offer-used"');
    expect(sheet).toContain("{SUCCESS_199}");
    expect(SUCCESS_199).toBe(
      "Done! Our team will call you within 1 hour to set up AiDwar on your WhatsApp.",
    );
    // Set-password flow as /999, then into the app.
    expect(sheet).toContain("resetPasswordForEmail");
    expect(sheet).toContain('navigate({ to: "/app/start"');
    // No Lead from /199's account.
    expect(sheet).toContain('pixel.trackRegistration(userId, phone, "landing_199")');
  });

  it("runCheckout: the server's offer_used (lead step or pay step) becomes the offer-used screen — no gateway", async () => {
    const { runCheckout } = await import("./checkout-999-flow");
    const base = {
      session: async () => ({ userId: OWNER, token: "t" }),
      account: async () => ({ status: "error" as const, error: "x" }),
      signInWithToken: async () => null,
      createWorkspace: async () => ({ orgId: ORG }),
      openGateway: vi.fn(async () => ({ error: null })),
      confirm: async () => "paid" as const,
    };
    const values = { phone: "98123 45670", name: "Asha Rao", email: "asha@example.com" };
    const atLead = await runCheckout(values, {
      ...base,
      saveLead: async () => ({ ok: false, code: "offer_used", error: OFFER_USED_199 }),
      startPay: vi.fn(),
    } as never);
    expect(atLead).toEqual({ kind: "offer_used", message: OFFER_USED_199 });
    const atPay = await runCheckout(values, {
      ...base,
      saveLead: async () => ({ ok: true }),
      startPay: async () => ({
        status: 409,
        body: { ok: false, code: "offer_used", error: OFFER_USED_199 },
      }),
    } as never);
    expect(atPay).toEqual({ kind: "offer_used", message: OFFER_USED_199 });
    expect(base.openGateway).not.toHaveBeenCalled();
  });
});

/* ============================================================ the page === */

describe("the /199 page: ₹199 everywhere, never ₹999", () => {
  it("hero ₹199 + its line, 'Start for ₹199' CTAs, the after-30-days line, the guarantee and FAQ in ₹199", async () => {
    const { Page199 } = await import("@/components/p199/page-199");
    const html = renderToStaticMarkup(
      <Page199
        rates={{ marketing: 0.8631, utility: 0.115, effective_from: null }}
        aidenLink={null}
        returningPaymentId={null}
      />,
    );
    const text = html
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'");
    expect(html).toContain('data-testid="hero-price"');
    expect(text).toContain(HERO_199.price);
    expect(text).toContain(
      "Your first month of AiDwar — and our team sets it up for you on a call.",
    );
    expect(text.split("Start for ₹199").length - 1).toBeGreaterThanOrEqual(5);
    expect(text).toContain(AFTER_30_DAYS);
    expect(AFTER_30_DAYS).toBe(
      "After 30 days you choose a plan with our team. Nothing renews automatically.",
    );
    expect(text).toContain("7-day money-back");
    expect(text).toContain("Pay Meta directly — zero markup");
    expect(text).toContain("we refund your ₹199 in full");
    expect(text).toContain("What you get");
    // Never ₹999 on this page (title/meta checked below), no anchor row.
    expect(text).not.toContain("999");
    expect(html).not.toContain('data-testid="anchor-row"');
    // Only what /999 already shows as proof; no invented numbers.
    expect(text).toContain("1,909");
    expect(text).not.toMatch(/Interakt|Wati|AiSensy|Gallabox|Claude|ChatGPT|OpenAI/i);
  });

  it("the sticky bar says ₹199 / 'Start for ₹199', and 'Finish setup — ₹199' after an unpaid close", async () => {
    const { StickyBar } = await import("@/components/p199/sections-199");
    const normal = renderToStaticMarkup(
      <StickyBar on onStart={() => undefined} onWarm={() => undefined} />,
    );
    expect(normal).toContain("₹199");
    expect(normal).toContain("Start for ₹199");
    expect(normal).not.toContain("999");
    const finish = renderToStaticMarkup(
      <StickyBar on finishSetup onStart={() => undefined} onWarm={() => undefined} />,
    );
    expect(finish).toContain(STICKY_199.finish);
    expect(PRICE_BLOCK_199.cta).toBe("Start for ₹199");
  });

  it("title, meta and OG description name ₹199 only; the exit screen too; noindex like /999", () => {
    const route = readFileSync("src/routes/199.tsx", "utf8");
    expect(route).toContain('createFileRoute("/199")');
    expect(route).not.toContain("₹999");
    const meta = route.slice(route.indexOf("const TITLE"), route.indexOf("/**"));
    expect(meta).toContain("₹199");
    expect(meta).not.toContain("999");
    expect(route).toContain('{ name: "robots", content: "noindex,follow" }');
    expect(route).toContain("getPage199Data");
    const loader = readFileSync("src/lib/page-199.functions.ts", "utf8");
    expect(loader).toContain('"Hi Aiden! I saw the ₹199 offer."');
    const copy = readFileSync("src/lib/page-199.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(copy).not.toMatch(/₹999/);
  });

  it("/999 is untouched: its page, sections and sheet still say what they said", async () => {
    for (const f of [
      "src/components/p999/page-999.tsx",
      "src/components/p999/sections-999.tsx",
      "src/components/p999/checkout-999.tsx",
      "src/routes/999.tsx",
      "src/lib/page-999.ts",
      "src/styles-999.css",
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/199|landing_199/);
    }
  });
});

/* ======================================================== tracking === */

describe("Meta: /199 events as /999's, value 199; Purchase once at 199", () => {
  it("ViewContent '199_page' and InitiateCheckout (199) go server side for every visitor; the pixel only after Accept", async () => {
    const posts: Row[] = [];
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
      location: { pathname: "/199", search: "", href: "https://aidwar.in/199" },
      addEventListener: () => undefined,
      fbq: Object.assign(() => undefined, { queue: [] }),
    });
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit = {}) => {
      posts.push(JSON.parse(String(init.body ?? "{}")) as Row);
      return new Response("{}");
    });
    vi.resetModules();
    const m = await import("./meta-pixel");
    m.view999Shown("/199");
    m.trackInitiateCheckout199();
    expect(posts).toEqual([
      expect.objectContaining({ event: "ViewContent", content_name: "199_page", landing: "199" }),
      expect.objectContaining({ event: "InitiateCheckout", landing: "199" }),
    ]);
    const { viewContentName, pixelZone } = await import("./meta-events");
    expect(viewContentName("/199")).toBe("199_page");
    expect(pixelZone("/199")).toBe("public");
  });

  it("the relay sends /199's InitiateCheckout at value 199 (no consent needed), only from /199", async () => {
    world();
    const graph: Row[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("graph.facebook.com"))
        graph.push(((JSON.parse(String(init.body)) as Row)["data"] as Row[])[0]!);
      return new Response(JSON.stringify({ events_received: 1 }));
    });
    const { Route } = await import("@/routes/api/public/meta-event");
    const post = (
      Route.options as unknown as {
        server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> };
      }
    ).server.handlers["POST"]!;
    const send = (url: string) =>
      post({
        request: new Request("https://aidwar.in/api/public/meta-event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            event: "InitiateCheckout",
            event_id: "InitiateCheckout.abcdef12-3456",
            landing: "199",
            url,
          }),
        }),
      });
    await send("https://aidwar.in/999");
    expect(graph).toHaveLength(0);
    await send("https://aidwar.in/199");
    expect(graph[0]).toMatchObject({
      event_name: "InitiateCheckout",
      event_id: "InitiateCheckout.abcdef12-3456",
      custom_data: { value: 199, currency: "INR", content_name: "basic" },
    });
  });

  it("AddPaymentInfo goes at value 199 for /199; Purchase is 'Purchase.' + payment id at 199, once", async () => {
    const w = world();
    const graph: Row[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      if (String(url).includes("graph.facebook.com"))
        graph.push(((JSON.parse(String(init.body)) as Row)["data"] as Row[])[0]!);
      return new Response(JSON.stringify({ events_received: 1 }));
    });
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: null,
      phone: "98123 45670",
      page: PAGE_199,
    });
    expect(out.ok && out.meta?.params).toMatchObject({ value: 199, currency: "INR" });
    await vi.waitFor(() => expect(graph).toHaveLength(1));
    expect(graph[0]).toMatchObject({ event_name: "AddPaymentInfo", custom_data: { value: 199 } });

    const pay = w.rows("payments")[0]!;
    pay["status"] = "paid";
    const { metaPaymentSettled } = await import("./meta-capi.server");
    await metaPaymentSettled(w.supabase as never, String(pay["id"]));
    await metaPaymentSettled(w.supabase as never, String(pay["id"]));
    const purchases = graph.filter((g) => g["event_name"] === "Purchase");
    expect(purchases).toEqual([
      expect.objectContaining({
        event_id: `Purchase.${String(pay["id"])}`,
        custom_data: { value: 199, currency: "INR", content_name: "basic" },
      }),
    ]);
  });

  it("an account made in the /199 checkout is never a Lead (server and pixel)", () => {
    const relay = readFileSync("src/routes/api/public/meta-event.ts", "utf8");
    expect(relay).toContain(
      'if (body["source"] === "landing_999" || body["source"] === "landing_199") return ok();',
    );
    const pixel = readFileSync("src/lib/meta-pixel.ts", "utf8");
    expect(pixel).toContain('if (source !== "landing_999" && source !== "landing_199") {');
  });
});

/* =========================================================== access === */

describe("the 30-day access period", () => {
  it("paid_at + 30 days; from the current end while it is still running", () => {
    expect(nextPeriodEnd(null, "2026-11-19T10:00:00.000Z")).toBe("2026-12-19T10:00:00.000Z");
    // ended already: from the payment
    expect(nextPeriodEnd("2026-11-01T00:00:00.000Z", "2026-11-19T10:00:00.000Z")).toBe(
      "2026-12-19T10:00:00.000Z",
    );
    // still running: from its end
    expect(nextPeriodEnd("2026-12-10T00:00:00.000Z", "2026-11-19T10:00:00.000Z")).toBe(
      "2027-01-09T00:00:00.000Z",
    );
  });

  it("banner at 5 days or fewer (and after the end), never at 6; 'Talk to us', no ₹999 charge", async () => {
    const now = Date.parse("2026-12-14T06:30:00.000Z");
    const end = "2026-12-19T10:00:00.000Z";
    expect(daysLeft(end, now)).toBe(6);
    expect(accessBanner(end, now)).toBeNull();
    const five = accessBanner(end, now + 864e5);
    expect(five?.text).toBe(
      "Your AiDwar access ends on 19 Dec 2026 — our team will call you, or choose a plan",
    );
    expect(accessBanner(end, Date.parse("2026-12-20T00:00:00Z"))?.text).toContain("ended on");
    expect(accessBanner(null, now)).toBeNull();
    const { AccessEndingBannerView } = await import("@/components/access-ending-banner");
    const html = renderToStaticMarkup(
      <AccessEndingBannerView text={five!.text} talkLink="https://wa.me/919000000001?text=Hi" />,
    );
    expect(html).toContain("Talk to us");
    expect(html).toContain('href="https://wa.me/919000000001?text=Hi"');
    expect(html).not.toContain("999");
    // Only for the /199 paid trial; the plan-fee run never invoices it.
    const renewalsServer = readFileSync("src/lib/renewals.server.ts", "utf8");
    expect(renewalsServer).toContain("paid_trial: await onPaidTrial(supabase, organizationId)");
    const run = readFileSync("src/lib/plan-billing.server.ts", "utf8");
    expect(run).toContain("if (await onPaidTrial(supabase, organizationId)) {");
  });

  it("the plan-fee run skips a workspace while its latest paid plan fee is the ₹199 trial", async () => {
    const { onPaidTrial } = await import("./plan-billing.server");
    const trial = world({ payments: [paidPayment(ORG, { offer: "paid_trial_199" })] });
    expect(await onPaidTrial(trial.supabase as never, ORG)).toBe(true);
    const monthly = world({
      payments: [
        { ...paidPayment(ORG, { offer: "paid_trial_199" }), id: "p1", paid_at: "2026-10-01" },
        { ...paidPayment(ORG, {}), id: "p2", paid_at: "2026-11-01" },
      ],
    });
    expect(await onPaidTrial(monthly.supabase as never, ORG)).toBe(false);
  });

  it("Admin Renewals due: soonest first, owner's first name, phone last 4 only, last amount, offer", async () => {
    const w = world({
      organizations: [
        { id: ORG, name: "Asha Jewellers", plan_period_ends_at: "2026-12-19T10:00:00Z" },
        { id: OTHER_ORG, name: "Old Shop", plan_period_ends_at: "2026-12-02T10:00:00Z" },
        { id: "no-period", name: "Never paid", plan_period_ends_at: null },
      ],
      payments: [
        { ...paidPayment(ORG, { offer: "paid_trial_199" }), amount: 199 },
        paidPayment(OTHER_ORG),
      ],
    });
    const { listRenewals } = await import("./renewals.server");
    const rows = await listRenewals(w.supabase as never);
    expect(rows).toEqual([
      {
        organization_id: OTHER_ORG,
        name: "Old Shop",
        owner_first_name: "Ravi",
        phone_last4: "…1111",
        plan_period_ends_at: "2026-12-02T10:00:00Z",
        last_amount: 999,
        offer: null,
      },
      {
        organization_id: ORG,
        name: "Asha Jewellers",
        owner_first_name: "Asha",
        phone_last4: "…5670",
        plan_period_ends_at: "2026-12-19T10:00:00Z",
        last_amount: 199,
        offer: "paid_trial_199",
      },
    ]);
    for (const r of rows) expect(JSON.stringify(r)).not.toMatch(/\+91|98123|90000/);
    expect(phoneLast4("+91 98123 45670")).toBe("…5670");
    expect(sortRenewals([...rows].reverse())[0]!.name).toBe("Old Shop");
    const { RenewalsTable } = await import("@/components/admin/renewals-tab");
    const html = renderToStaticMarkup(
      <RenewalsTable rows={rows} now={Date.parse("2026-11-29T00:00:00Z")} />,
    );
    expect(html).toContain("…5670");
    expect(html).toContain("₹199 paid trial");
    expect(html).not.toContain("98123");
  });

  it("Admin Leads: a 'Source = /199' filter, the alert says 'Website /199', /199 leads are mirrored", async () => {
    const { LEAD_SOURCE_FILTERS } = await import("./leads");
    expect(LEAD_SOURCE_FILTERS.find((f) => f.value === "landing_199")?.label).toBe("/199");
    const { alertSourceLabel } = await import("./lead-alerts.server");
    expect(alertSourceLabel("landing_199")).toBe("Website /199");
    expect(readFileSync("src/lib/lead-mirror.server.ts", "utf8")).toContain('"landing_199"');
    const sql = readFileSync("supabase/aidwar-migrations/20261450_batch82.sql", "utf8");
    expect(sql).toContain("source IN ('landing_start', 'landing_999', 'landing_199')");
    expect(sql).toContain(
      "ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS plan_period_ends_at timestamptz;",
    );
    expect(
      sql
        .trim()
        .endsWith(
          "SELECT public.mcp_block_oauth_writes();\nSELECT public.mcp_block_oauth_reads();",
        ),
    ).toBe(true);
  });
});
