import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 80b — /999's Meta events proven end to end, with fakes only: Graph is
 * a stub answering like Meta's Conversions API, Cashfree is never called, the
 * database is in memory. Nothing reaches live Meta, Cashfree or the DB.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  request: null as Request | null,
  orders: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/permissions.server", () => ({ hasPermission: async () => true }));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => h.request }));
vi.mock("@/lib/cashfree.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cashfree.server")>()),
  cashfreeConfig: () => ({ env: "sandbox", clientId: "test", clientSecret: "test", baseUrl: "x" }),
}));
vi.mock("@/lib/cashfree-billing.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cashfree-billing.server")>()),
  orderCustomer: async () => ({
    id: "c",
    name: "Asha",
    email: "asha@example.com",
    phone: "9812345670",
  }),
  startCashfreeOrder: async (_s: unknown, _c: unknown, input: Record<string, unknown>) => {
    h.orders.push(input);
    return { checkout: { payment_session_id: "s", mode: "sandbox" }, url: "/pay/x" };
  },
}));

const PLATFORM = "00000000-0000-4000-8000-00000000aaaa";
const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const BASIC_V = "44444444-4444-4444-8444-444444444444";
const LEAD = "55555555-5555-4555-8555-555555555555";

type Graph = { url: string; body: Row };
let graph: Graph[] = [];
let graphAnswer: () => Response = () =>
  new Response(JSON.stringify({ events_received: 1, fbtrace_id: "AbCtrace1" }), { status: 200 });

beforeEach(() => {
  vi.stubEnv("META_CAPI_TOKEN", "TEST-not-a-real-token");
  vi.stubEnv("PLATFORM_ORG_ID", PLATFORM);
  vi.stubEnv("META_CAPI_TEST_CODE", "");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  graph = [];
  h.orders = [];
  h.request = null;
  graphAnswer = () =>
    new Response(JSON.stringify({ events_received: 1, fbtrace_id: "AbCtrace1" }), { status: 200 });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    graph.push({ url: String(url), body: JSON.parse(String(init.body ?? "{}")) as Row });
    return graphAnswer();
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
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
      ],
      organization_members: [
        { organization_id: ORG, user_id: OWNER, role: "owner", created_at: "2026-11-15T00:00:00Z" },
        { organization_id: ORG, user_id: ADMIN, role: "owner", created_at: "2026-11-15T00:00:01Z" },
      ],
      profiles: [
        {
          id: OWNER,
          email: "asha@example.com",
          full_name: "Asha Rao",
          phone: "+919812345670",
          is_super_admin: false,
        },
        {
          id: ADMIN,
          email: "vinay@example.com",
          full_name: "Vinay",
          phone: "+919000000001",
          is_super_admin: true,
        },
      ],
      platform_settings: [{ id: true, gst_registered: false }],
      billing_accounts: [],
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
          data: {
            user: {
              id,
              email: id === ADMIN ? "vinay@example.com" : "asha@example.com",
              created_at: "2026-11-15T00:00:00Z",
              user_metadata: {},
            },
          },
        }),
      },
    },
  });
  h.db = { supabase: db.supabase };
  return db;
}

const events = () => graph.filter((g) => g.url.includes("graph.facebook.com"));
const ev = (i: number) => (events()[i]!.body["data"] as Row[])[0]!;

function req(url: string, body: Row, cookie = ""): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 test",
      "cf-connecting-ip": "203.0.113.9",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function relay(body: Row, cookie = "") {
  const { Route } = await import("@/routes/api/public/meta-event");
  const post = (
    Route.options as unknown as {
      server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> };
    }
  ).server.handlers["POST"]!;
  return post({ request: req("https://aidwar.in/api/public/meta-event", body, cookie) });
}

/* ======================================================== page events === */

describe("/999 ViewContent and InitiateCheckout: server side for everyone who hasn't pressed Decline", () => {
  const view = (consent: unknown, extra: Row = {}) => ({
    event: "ViewContent",
    event_id: "ViewContent.visit-1234-abcd",
    landing: "999",
    consent,
    visit_id: "visit-1234-abcd",
    url: "https://aidwar.in/999?fbclid=x",
    ...extra,
  });

  it("no choice yet ('none') and Accept both send; Decline and a missing choice send nothing", async () => {
    world();
    await relay(view("none"));
    await relay(
      view("accepted", { event_id: "ViewContent.visit-9999-zzzz", visit_id: "visit-9999-zzzz" }),
    );
    await relay(view("declined", { event_id: "ViewContent.visit-1111-yyyy" }));
    await relay(view(undefined, { event_id: "ViewContent.visit-2222-xxxx" }));
    expect(events().map((_, i) => ev(i)["event_id"])).toEqual([
      "ViewContent.visit-1234-abcd",
      "ViewContent.visit-9999-zzzz",
    ]);
  });

  it("carries the pixel's own id, the visit as external_id, fbc from the ad click, ip/ua and the page", async () => {
    world();
    await relay(
      view("none", { fbclid: "IwAR0abcdefghij", fbclid_at: 1794466925583 }),
      "_fbp=fb.1.1794466925000.123456",
    );
    const e = ev(0);
    expect(e).toMatchObject({
      event_name: "ViewContent",
      event_id: "ViewContent.visit-1234-abcd",
      action_source: "website",
      event_source_url: "https://aidwar.in/999",
      custom_data: { content_name: "999_page" },
    });
    const ud = e["user_data"] as Row;
    expect(ud).toMatchObject({
      client_ip_address: "203.0.113.9",
      client_user_agent: "Mozilla/5.0 test",
      fbp: "fb.1.1794466925000.123456",
      fbc: "fb.1.1794466925583.IwAR0abcdefghij",
    });
    expect((ud["external_id"] as string[])[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("InitiateCheckout: value 999 INR, content 'basic', its own id; only from /999", async () => {
    world();
    await relay({
      event: "InitiateCheckout",
      event_id: "InitiateCheckout.chk-5678-efgh",
      landing: "999",
      consent: "none",
      visit_id: "visit-1234-abcd",
      url: "https://aidwar.in/start",
    });
    expect(events()).toHaveLength(0);
    await relay({
      event: "InitiateCheckout",
      event_id: "InitiateCheckout.chk-5678-efgh",
      landing: "999",
      consent: "none",
      visit_id: "visit-1234-abcd",
      url: "https://aidwar.in/999",
    });
    expect(ev(0)).toMatchObject({
      event_name: "InitiateCheckout",
      event_id: "InitiateCheckout.chk-5678-efgh",
      custom_data: { value: 999, currency: "INR", content_name: "basic" },
    });
  });

  it("the browser: server copy unless Declined, the pixel only after Accept, the same id on both", async () => {
    const run = async (consent: "accepted" | "declined" | null) => {
      const store = new Map<string, string>();
      if (consent) store.set("aidwar.meta_consent", `${consent}:${Date.now()}`);
      const fbq: unknown[][] = [];
      const posts: Row[] = [];
      const storage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      };
      vi.stubGlobal("window", {
        localStorage: storage,
        sessionStorage: storage,
        location: { pathname: "/999", search: "", href: "https://aidwar.in/999" },
        addEventListener: () => undefined,
        fbq: Object.assign((...a: unknown[]) => fbq.push(a), { queue: [] }),
      });
      vi.stubGlobal("document", {
        readyState: "complete",
        head: { appendChild: () => undefined },
        createElement: () => ({}),
        querySelector: () => ({}),
      });
      vi.stubGlobal("fetch", async (_u: string, init: RequestInit = {}) => {
        posts.push(JSON.parse(String(init.body ?? "{}")) as Row);
        return new Response("{}");
      });
      vi.resetModules();
      const m = await import("./meta-pixel");
      m.trackView999("visit-1234-abcd");
      m.trackInitiateCheckout999("visit-1234-abcd", "chk-5678-efgh");
      return { fbq, posts };
    };
    const none = await run(null);
    expect(none.posts.map((p) => [p["event_id"], p["consent"]])).toEqual([
      ["ViewContent.visit-1234-abcd", "none"],
      ["InitiateCheckout.chk-5678-efgh", "none"],
    ]);
    expect(none.fbq.filter((c) => c[0] === "track")).toEqual([]);
    const yes = await run("accepted");
    expect(yes.posts.map((p) => p["consent"])).toEqual(["accepted", "accepted"]);
    expect(yes.fbq.filter((c) => c[0] === "track").map((c) => (c[3] as Row)["eventID"])).toEqual([
      "ViewContent.visit-1234-abcd",
      "InitiateCheckout.chk-5678-efgh",
    ]);
    const no = await run("declined");
    expect(no.posts).toEqual([]);
    expect(no.fbq.filter((c) => c[0] === "track")).toEqual([]);
  });
});

/* =============================================== AddPaymentInfo + ₹1 === */

describe("AddPaymentInfo and the admin ₹1 test", () => {
  it("AddPaymentInfo: 'AddPaymentInfo.' + lead id, sent whatever the cookie choice, with the lead's fbc/fbp and hashed em/ph/fn", async () => {
    const w = world({
      demo_leads: [
        {
          id: LEAD,
          source: "landing_999",
          phone: "+919812345670",
          meta_fbc: "fb.1.1.IwARclick",
          meta_fbp: "fb.1.1.42",
        },
      ],
    });
    const { startCheckoutPayment } = await import("./checkout-999.server");
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: LEAD,
      phone: "98123 45670",
      request: req("https://aidwar.in/api/public/checkout-999", {}),
    });
    expect(out.ok).toBe(true);
    await vi.waitFor(() => expect(events()).toHaveLength(1));
    const e = ev(0);
    expect(e).toMatchObject({
      event_name: "AddPaymentInfo",
      event_id: `AddPaymentInfo.${LEAD}`,
      custom_data: { value: 999, currency: "INR", content_name: "basic" },
    });
    const ud = e["user_data"] as Row;
    for (const k of ["em", "ph", "fn", "external_id"]) expect(ud).toHaveProperty(k);
    expect(ud).toMatchObject({
      fbc: "fb.1.1.IwARclick",
      fbp: "fb.1.1.42",
      client_ip_address: "203.0.113.9",
    });
    expect(events()[0]!.body).not.toHaveProperty("test_event_code");
  });

  it("?meta_test=CODE (the browser's cookie): every server call from that browser is a Test Events call; nobody else's", async () => {
    const w = world();
    const { startCheckoutPayment } = await import("./checkout-999.server");
    await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: null,
      phone: "98123 45670",
      request: req("https://aidwar.in/api/public/checkout-999", {}, "aidwar_meta_test=TEST4242"),
    });
    await vi.waitFor(() => expect(events()).toHaveLength(1));
    expect(events()[0]!.body["test_event_code"]).toBe("TEST4242");
    // Kept on the payment for its Purchase (settled later, maybe by the webhook).
    expect((w.rows("payments")[0]!["raw"] as Row)["meta_test_code"]).toBe("TEST4242");
    // Another browser (no cookie) is a real event; a malformed cookie is ignored.
    await relay({
      event: "ViewContent",
      event_id: "ViewContent.visit-aaaa-bbbb",
      landing: "999",
      consent: "none",
      visit_id: "visit-aaaa-bbbb",
      url: "https://aidwar.in/999",
    });
    await relay(
      {
        event: "ViewContent",
        event_id: "ViewContent.visit-cccc-dddd",
        landing: "999",
        consent: "none",
        visit_id: "visit-cccc-dddd",
        url: "https://aidwar.in/999",
      },
      "aidwar_meta_test=bad%20code!",
    );
    expect(events()[1]!.body).not.toHaveProperty("test_event_code");
    expect(events()[2]!.body).not.toHaveProperty("test_event_code");
    // The page sets the cookie from ?meta_test=, for 2 hours, path-wide.
    const pixel = readFileSync("src/lib/meta-pixel.ts", "utf8");
    expect(pixel).toContain("Max-Age=7200; Path=/; SameSite=Lax; Secure");
  });

  it("a non-admin (or any other value) never gets ₹1 — refused on the server, nothing created", async () => {
    const w = world();
    const { startCheckoutPayment } = await import("./checkout-999.server");
    expect(
      await startCheckoutPayment(w.supabase as never, {
        userId: OWNER,
        leadId: null,
        phone: "98123 45670",
        adminTestPrice: 1,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await startCheckoutPayment(w.supabase as never, {
        userId: ADMIN,
        leadId: null,
        phone: "98123 45670",
        adminTestPrice: 5,
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      await startCheckoutPayment(w.supabase as never, {
        userId: ADMIN,
        leadId: null,
        phone: "98123 45670",
        adminTestPrice: "1",
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(w.rows("payments")).toHaveLength(0);
    expect(h.orders).toHaveLength(0);
  });

  it("a Super Admin gets ₹1 at the gateway, tagged admin_test; everything else as a real purchase", async () => {
    const w = world();
    const { startCheckoutPayment } = await import("./checkout-999.server");
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: ADMIN,
      leadId: null,
      phone: "90000 00001",
      adminTestPrice: 1,
    });
    expect(out.ok).toBe(true);
    const pay = w.rows("payments")[0]!;
    expect(pay).toMatchObject({ amount: 1, provider: "cashfree", purpose: "plan_fee" });
    expect(pay["raw"]).toMatchObject({
      admin_test: true,
      gross_amount: 1,
      source: "landing_999",
      plan_version_id: BASIC_V,
    });
    expect(h.orders[0]).toMatchObject({ gross: 1 });
    expect(String(h.orders[0]!["note"])).toMatch(/^ADMIN TEST — /);
    // Excluded from the platform's revenue totals.
    expect(readFileSync("src/lib/billing-admin.server.ts", "utf8")).toContain(
      '(p) => ((p["raw"] ?? {}) as Record<string, unknown>)["admin_test"] !== true,',
    );
  });
});

/* ============================================================ Purchase === */

describe("Purchase: once per paid payment, from whichever path settles it", () => {
  const PAY = "66666666-6666-4666-8666-666666666666";
  const paid = (raw: Row = {}, status = "paid") =>
    world({
      payments: [
        {
          id: PAY,
          organization_id: ORG,
          status,
          purpose: "plan_fee",
          amount: 999,
          raw: { source: "landing_999", gross_amount: 999, ...raw },
        },
      ],
      demo_leads: [
        {
          id: LEAD,
          source: "landing_999",
          payment_id: PAY,
          meta_fbc: "fb.1.1.IwARclick",
          meta_fbp: "fb.1.1.42",
        },
      ],
    });

  it("return-confirm first (the buyer's own request), then the webhook: one Purchase, website, value 999", async () => {
    paid();
    const { metaPaymentSettled } = await import("./meta-capi.server");
    h.request = req("https://aidwar.in/api/public/cashfree-pay", {}, "_fbp=fb.1.1.42");
    await metaPaymentSettled(h.db!.supabase as never, PAY);
    h.request = new Request("https://aidwar.in/api/public/cashfree-webhook", {
      method: "POST",
      headers: { "user-agent": "Cashfree" },
    });
    await metaPaymentSettled(h.db!.supabase as never, PAY);
    expect(events()).toHaveLength(1);
    const e = ev(0);
    expect(e).toMatchObject({
      event_name: "Purchase",
      event_id: `Purchase.${PAY}`,
      action_source: "website",
      event_source_url: expect.stringMatching(/\/999$/),
      custom_data: { value: 999, currency: "INR", content_name: "basic" },
    });
    const ud = e["user_data"] as Row;
    expect(ud).toMatchObject({ client_ip_address: "203.0.113.9", fbc: "fb.1.1.IwARclick" });
    for (const k of ["em", "ph", "fn", "external_id"]) expect(ud).toHaveProperty(k);
  });

  it("webhook first: the buyer's facts are never Cashfree's (no ip/ua), the lead's fbc/fbp still match", async () => {
    paid();
    const { metaPaymentSettled } = await import("./meta-capi.server");
    h.request = new Request("https://aidwar.in/api/public/cashfree-webhook", {
      method: "POST",
      headers: { "user-agent": "Cashfree-Webhook", "cf-connecting-ip": "198.51.100.1" },
    });
    await metaPaymentSettled(h.db!.supabase as never, PAY);
    const ud = ev(0)["user_data"] as Row;
    expect(ud).not.toHaveProperty("client_ip_address");
    expect(ud).not.toHaveProperty("client_user_agent");
    expect(ud).toMatchObject({ fbc: "fb.1.1.IwARclick", fbp: "fb.1.1.42" });
    // And the return-confirm afterwards adds nothing.
    h.request = req("https://aidwar.in/api/public/cashfree-pay", {});
    await metaPaymentSettled(h.db!.supabase as never, PAY);
    expect(events()).toHaveLength(1);
  });

  it("never for a failed or pending payment", async () => {
    for (const status of ["failed", "pending", "created"]) {
      paid({}, status);
      const { metaPaymentSettled } = await import("./meta-capi.server");
      await metaPaymentSettled(h.db!.supabase as never, PAY);
    }
    expect(events()).toHaveLength(0);
  });

  it("the buyer's Test Events code rides with the payment; an admin ₹1 test goes only as a Test Events call", async () => {
    const w = paid({ meta_test_code: "TEST4242" });
    const { metaPaymentSettled } = await import("./meta-capi.server");
    await metaPaymentSettled(w.supabase as never, PAY);
    expect(events()[0]!.body["test_event_code"]).toBe("TEST4242");

    const a = paid({ admin_test: true });
    await metaPaymentSettled(a.supabase as never, PAY);
    expect(events()).toHaveLength(1); // nothing new: no code, never a real Purchase
    expect(a.rows("meta_capi_log").at(-1)).toMatchObject({
      event_name: "Purchase",
      outcome: "skipped",
      reason: "admin_test_without_test_code",
    });
    const b = paid({ admin_test: true, meta_test_code: "TEST9" + "999" });
    await metaPaymentSettled(b.supabase as never, PAY);
    expect(events()).toHaveLength(2);
    expect(events()[1]!.body["test_event_code"]).toBe("TEST9999");
    // The pixel never fires an admin test's Purchase.
    const r = await relay({ event: "payment", payment_id: PAY });
    expect(((await r.json()) as Row)["meta"]).toBeNull();
  });
});

/* ================================================================= log === */

describe("meta_capi_log: every server event's outcome", () => {
  it("sent: status, events_received, fbtrace_id; failed: Graph's error; skipped: the reason", async () => {
    const w = world();
    const { sendMetaEvent } = await import("./meta-capi.server");
    await sendMetaEvent(w.supabase as never, {
      event: "ViewContent",
      eventId: "ViewContent.aaaa-bbbb",
      useCurrentRequest: false,
    });
    graphAnswer = () =>
      new Response(
        JSON.stringify({ error: { message: "Invalid parameter", code: 100, fbtrace_id: "Fail1" } }),
        { status: 400 },
      );
    await sendMetaEvent(w.supabase as never, {
      event: "ViewContent",
      eventId: "ViewContent.cccc-dddd",
      useCurrentRequest: false,
    });
    await sendMetaEvent(
      w.supabase as never,
      {
        event: "AddPaymentInfo",
        eventId: "AddPaymentInfo.x",
        userId: "99999999-9999-4999-8999-999999999999",
      },
      {
        META_CAPI_TOKEN: "t",
      },
    );
    vi.stubEnv("META_CAPI_TOKEN", "");
    await sendMetaEvent(
      w.supabase as never,
      { event: "ViewContent", eventId: "ViewContent.eeee-ffff", useCurrentRequest: false },
      {},
    );
    const rows = w.rows("meta_capi_log");
    expect(rows[0]).toMatchObject({
      event_name: "ViewContent",
      event_id: "ViewContent.aaaa-bbbb",
      outcome: "sent",
      http_status: 200,
      events_received: 1,
      fbtrace_id: "AbCtrace1",
    });
    expect(rows[1]).toMatchObject({
      outcome: "failed",
      http_status: 400,
      fbtrace_id: "Fail1",
      error: "Invalid parameter",
    });
    expect(rows.map((r) => r["outcome"])).toContain("skipped");
    expect(rows.at(-1)).toMatchObject({ outcome: "skipped", reason: "token_missing" });
    // Never a person's data in the log.
    for (const r of rows)
      for (const k of Object.keys(r))
        expect(["em", "ph", "fn", "user_data", "client_ip_address"]).not.toContain(k);
  });

  it("the SQL: service role only, 14-day purge in the nightly job (which keeps its three calls)", () => {
    const sql = readFileSync("supabase/aidwar-migrations/20261440_batch80b.sql", "utf8");
    expect(sql).toContain("ALTER TABLE public.meta_capi_log ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("REVOKE ALL ON public.meta_capi_log FROM anon, authenticated;");
    expect(sql).not.toMatch(/CREATE POLICY/i);
    expect(sql).toContain("WHERE created_at < now() - interval '14 days'");
    expect(sql).toContain(
      "$cmd$SELECT public.retention_purge(); SELECT public.api_refusals_purge(); SELECT public.lead_verifications_purge(); SELECT public.meta_capi_log_purge();$cmd$",
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
