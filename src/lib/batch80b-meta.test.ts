import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 80b — Test Events mode, meta_capi_log and the admin ₹1 live test, with
 * fakes only: Graph is a stub answering like Meta's Conversions API, Cashfree
 * is never called, the database is in memory. How /999's events are sent is
 * unchanged from Batch 80 (batch80-999.test.tsx); Purchase once across the
 * webhook and the return page runs through the real Cashfree paths in
 * batch31-cashfree.test.ts.
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

/* =============================================== AddPaymentInfo + ₹1 === */

describe("AddPaymentInfo and the admin ₹1 test", () => {
  it("AddPaymentInfo is sent as in Batch 80 ('AddPaymentInfo.' + payment id, 999 INR); no Test Events code without ?meta_test", async () => {
    const w = world();
    const { startCheckoutPayment } = await import("./checkout-999.server");
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: null,
      phone: "98123 45670",
      request: req("https://aidwar.in/api/public/checkout-999", {}),
    });
    expect(out.ok).toBe(true);
    await vi.waitFor(() => expect(events()).toHaveLength(1));
    const pay = w.rows("payments")[0]!;
    expect(ev(0)).toMatchObject({
      event_name: "AddPaymentInfo",
      event_id: `AddPaymentInfo.${String(pay["id"])}`,
      custom_data: { value: 999, currency: "INR", content_name: "basic" },
    });
    expect(events()[0]!.body).not.toHaveProperty("test_event_code");
    expect(pay["raw"]).not.toHaveProperty("meta_test_code");
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
    const { sendMetaEvent } = await import("./meta-capi.server");
    await sendMetaEvent(w.supabase as never, {
      event: "ViewContent",
      eventId: "ViewContent.aaaa-bbbb",
      request: req("https://aidwar.in/api/public/meta-event", {}),
    });
    await sendMetaEvent(w.supabase as never, {
      event: "ViewContent",
      eventId: "ViewContent.cccc-dddd",
      request: req("https://aidwar.in/api/public/meta-event", {}, "aidwar_meta_test=bad%20code!"),
    });
    expect(events()[1]!.body).not.toHaveProperty("test_event_code");
    expect(events()[2]!.body).not.toHaveProperty("test_event_code");
    // The same browser's page events carry it too (any server event with its request).
    await sendMetaEvent(w.supabase as never, {
      event: "ViewContent",
      eventId: "ViewContent.eeee-ffff",
      request: req("https://aidwar.in/api/public/meta-event", {}, "aidwar_meta_test=TEST4242"),
    });
    expect(events()[3]!.body["test_event_code"]).toBe("TEST4242");
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

describe("Purchase: sent as in Batch 80, plus the Test Events code and the ₹1 rule", () => {
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
    });

  it("unchanged: 'Purchase.' + payment id, system_generated, 999 INR, once (the marker) however often it's asked", async () => {
    paid();
    const { metaPaymentSettled } = await import("./meta-capi.server");
    await metaPaymentSettled(h.db!.supabase as never, PAY);
    await metaPaymentSettled(h.db!.supabase as never, PAY);
    expect(events()).toHaveLength(1);
    expect(ev(0)).toMatchObject({
      event_name: "Purchase",
      event_id: `Purchase.${PAY}`,
      action_source: "system_generated",
      custom_data: { value: 999, currency: "INR", content_name: "basic" },
    });
    expect(events()[0]!.body).not.toHaveProperty("test_event_code");
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
    });
    graphAnswer = () =>
      new Response(
        JSON.stringify({ error: { message: "Invalid parameter", code: 100, fbtrace_id: "Fail1" } }),
        { status: 400 },
      );
    await sendMetaEvent(w.supabase as never, {
      event: "ViewContent",
      eventId: "ViewContent.cccc-dddd",
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
      { event: "ViewContent", eventId: "ViewContent.eeee-ffff" },
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
