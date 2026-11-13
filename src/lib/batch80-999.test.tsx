import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 80 — /999: the AiDwar Basic plan (₹999/month, pay Meta directly,
 * zero markup), its page and its one-screen checkout. Fakes only: no live
 * database, WhatsApp, Meta or payment gateway is reached, and no real
 * payment is made.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  events: [] as Array<Record<string, unknown>>,
  orders: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/permissions.server", () => ({ hasPermission: async () => true }));
vi.mock("@/lib/cashfree.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cashfree.server")>()),
  cashfreeConfig: () => ({ env: "sandbox", clientId: "test", clientSecret: "test", baseUrl: "x" }),
}));
vi.mock("@/lib/cashfree-billing.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cashfree-billing.server")>()),
  orderCustomer: async () => ({
    id: "cust",
    name: "Asha Rao",
    email: "asha@example.com",
    phone: "9812345670",
  }),
  startCashfreeOrder: async (_s: unknown, _c: unknown, input: Record<string, unknown>) => {
    h.orders.push(input);
    return { checkout: { payment_session_id: "session_test", mode: "sandbox" }, url: "/pay/x" };
  },
}));
vi.mock("@/lib/meta-capi.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./meta-capi.server")>()),
  queueMetaEvent: async (_s: unknown, ev: Record<string, unknown>) => {
    h.events.push(ev);
  },
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to }: { children: unknown; to: string }) => (
    <a href={to}>{children as never}</a>
  ),
  useNavigate: () => async () => undefined,
}));

import { runCheckout, PAY_FAILED, type CheckoutDeps } from "./checkout-999-flow";
import {
  CALC,
  DEMO_CHATS,
  calc,
  demoBeats,
  faq,
  fieldError,
  passwordStrength,
  stickyVisible,
  type CheckoutValues,
} from "./page-999";
import { checkoutAbandoned, saveCheckoutLead, startCheckoutPayment } from "./checkout-999.server";
import { filterLeads, isCheckoutAbandoned, type LeadRow } from "./leads";
import { pixelZone, viewContentName } from "./meta-events";

const ORG = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const BASIC_V = "33333333-3333-4333-8333-333333333333";
const GROWTH_V = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  h.events = [];
  h.orders = [];
});
afterEach(() => vi.restoreAllMocks());

/** A world with Basic (hidden) and Growth; flags resolve like org_flag_enabled. */
function world(extra: Record<string, Row[]> = {}): MemoryDb {
  const db = memoryDb(
    {
      plans: [
        {
          key: "basic",
          name: "Basic",
          tagline: null,
          is_active: true,
          is_public: false,
          sort_order: 5,
          plan_versions: [
            {
              id: BASIC_V,
              price_monthly: 999,
              price_annual: 9990,
              currency: "INR",
              limits: { ai_answers: 300 },
              highlights: [],
              features: ["billing", "cashfree_billing", "meta_direct_billing"],
              is_current: true,
            },
          ],
        },
        {
          key: "growth",
          name: "Growth",
          tagline: null,
          is_active: true,
          is_public: true,
          sort_order: 20,
          plan_versions: [
            {
              id: GROWTH_V,
              price_monthly: 4999,
              price_annual: 49990,
              currency: "INR",
              limits: {},
              highlights: [],
              features: ["billing"],
              is_current: true,
            },
          ],
        },
      ],
      plan_versions: [
        {
          id: BASIC_V,
          price_monthly: 999,
          features: ["billing", "cashfree_billing", "meta_direct_billing"],
        },
        { id: GROWTH_V, price_monthly: 4999, features: ["billing"] },
      ],
      organizations: [
        {
          id: ORG,
          name: "Asha Jewellers",
          plan_status: "trial",
          plan_version_id: null,
          billing_account_id: null,
        },
      ],
      organization_members: [
        { organization_id: ORG, user_id: OWNER, role: "owner", created_at: "2026-11-13T00:00:00Z" },
      ],
      profiles: [
        { id: OWNER, email: "asha@example.com", full_name: "Asha Rao", phone: "+919812345670" },
      ],
      platform_settings: [{ id: true, gst_registered: false }],
      billing_accounts: [],
      payments: [],
      demo_leads: [],
      activity_log: [],
      organization_billing_settings: [],
      knowledge_sources: [],
      wallet_balances: [{ organization_id: ORG, balance: 0, held: 0 }],
      ...extra,
    },
    {
      org_flag_enabled: (args, api) => {
        const org = api.rows("organizations").find((o) => o["id"] === args["p_org"]);
        const v = api.rows("plan_versions").find((p) => p["id"] === org?.["plan_version_id"]);
        return {
          data: ((v?.["features"] as string[]) ?? []).includes(String(args["p_flag"])),
          error: null,
        };
      },
    },
  );
  h.db = { supabase: db.supabase };
  return db;
}

/* ================================================================ plan === */

describe("the Basic plan", () => {
  it("is sold only by /999: the plan chooser's list never has it", async () => {
    world();
    const { purchasablePlans, startPlanPurchase } = await import("./plan-purchase.server");
    expect((await purchasablePlans(h.db!.supabase as never)).map((p) => p.key)).toEqual(["growth"]);
    const refused = await startPlanPurchase(h.db!.supabase as never, {
      organizationId: ORG,
      userId: OWNER,
      planKey: "basic",
    });
    expect(refused).toEqual({ error: "That plan isn't available right now." });
  });

  it("/999's payment: exactly ₹999 (no GST while unregistered), through Cashfree (the plan's own gateway), back to /999", async () => {
    const w = world();
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: null,
      phone: "98123 45670",
    });
    expect(out.ok).toBe(true);
    const pay = w.rows("payments")[0]!;
    expect(pay).toMatchObject({ provider: "cashfree", purpose: "plan_fee", amount: 999 });
    expect(pay["raw"]).toMatchObject({
      kind: "plan_purchase",
      plan_key: "basic",
      plan_version_id: BASIC_V,
      gst_amount: 0,
      gross_amount: 999,
      source: "landing_999",
    });
    expect(h.orders[0]).toMatchObject({ gross: 999 });
    expect(String(h.orders[0]!["returnUrl"])).toMatch(/\/999\?payment=/);
  });

  it("activates on a confirmed payment: plan active, the lead paid, 'Paid via /999' on the workspace", async () => {
    const w = world({
      demo_leads: [{ id: "lead-1", source: "landing_999", payment_id: "pay-1", paid_at: null }],
    });
    const { activatePlanFromPayment } = await import("./plan-purchase.server");
    const ok = await activatePlanFromPayment(w.supabase as never, {
      id: "pay-1",
      organization_id: ORG,
      raw: { plan_version_id: BASIC_V, plan_key: "basic", source: "landing_999" },
    });
    expect(ok).toBe(true);
    expect(w.rows("organizations")[0]).toMatchObject({
      plan_status: "active",
      plan_version_id: BASIC_V,
    });
    expect(w.rows("demo_leads")[0]!["paid_at"]).toBeTruthy();
    expect(
      (w.rows("organization_billing_settings")[0]!["limits_override"] as Row)["_paid_via"],
    ).toMatchObject({ source: "/999", payment_id: "pay-1" });
  });

  it("a workspace that pays Meta itself is never held, gated or asked to buy credits — at zero balance", async () => {
    const w = world();
    w.rows("organizations")[0]!["plan_version_id"] = BASIC_V;
    const rpc = vi.spyOn(w.supabase as never as { rpc: (...a: unknown[]) => unknown }, "rpc");
    const billing = await import("./billing.server");
    expect(await billing.metaDirectBilling(w.supabase as never, ORG)).toBe(true);
    expect(await billing.messagesBilled(w.supabase as never, ORG)).toBe(false);
    const cover = await billing.creditsCover(w.supabase as never, ORG, 5000);
    expect(cover.covers).toBe(true);
    const held = await billing.holdCampaignSpend(w.supabase as never, {
      organizationId: ORG,
      campaignId: "c1",
      amount: 2589,
      actorId: null,
    });
    expect(held).toEqual({ ok: true });
    expect(rpc.mock.calls.some((c) => c[0] === "wallet_apply")).toBe(false);
    const { holdCampaign } = await import("./campaign-billing.server");
    expect(await holdCampaign(w.supabase as never, ORG, "c1")).toEqual({ ok: true });
    expect(rpc.mock.calls.some((c) => c[0] === "wallet_apply")).toBe(false);
  });

  it("any other workspace is unchanged: billed, and a hold it can't cover is refused", async () => {
    const w = world();
    w.rows("organizations")[0]!["plan_version_id"] = GROWTH_V;
    const billing = await import("./billing.server");
    expect(await billing.metaDirectBilling(w.supabase as never, ORG)).toBe(false);
    expect(await billing.messagesBilled(w.supabase as never, ORG)).toBe(true);
    expect((await billing.creditsCover(w.supabase as never, ORG, 5000)).covers).toBe(false);
  });

  it("billing screens and the sweep hide every credit prompt for it (classic, Aiden Workspace, Home, low_credits)", () => {
    const classic = readFileSync("src/components/billing/billing-view.tsx", "utf8");
    expect(classic).toContain("const paysMeta = summary.pays_meta_directly === true;");
    expect(classic).toContain(
      "const low = !paysMeta && wallet.available <= summary.settings.low_credit_threshold;",
    );
    const v2 = readFileSync("src/components/billing-v2/new-billing.tsx", "utf8");
    expect(v2).toContain('const payButton = !paysMeta && can("billing.pay");');
    const home = readFileSync("src/routes/app/index.tsx", "utf8");
    expect(home).toContain("extras.billing.pays_meta_directly !== true &&");
    const sweep = readFileSync("src/lib/billing-sweep.server.ts", "utf8");
    expect(sweep).toContain("if (!lowSince && !paysMeta) {");
  });

  it("after the 300 answers Aiden hands new chats to the inbox (Basic only); the count is the month's", async () => {
    const w = world();
    const { istMonthKey } = await import("./billing-ai-economics.server");
    w.rows("ai_usage_months").push({
      organization_id: ORG,
      month: `${istMonthKey(new Date())}-01`,
      answers: 300,
      allowance: 300,
    });
    const { answerAllowanceReached } = await import("./answer-allowance.server");
    expect(await answerAllowanceReached(w.supabase as never, ORG)).toEqual({
      reached: true,
      used: 300,
      allowance: 300,
    });
    w.rows("ai_usage_months")[0]!["answers"] = 299;
    expect((await answerAllowanceReached(w.supabase as never, ORG)).reached).toBe(false);
    const agent = readFileSync("src/lib/ai-agent.server.ts", "utf8");
    expect(agent).toContain('if (mode === "replying" && (await paysMeta)) {');
    expect(agent).toContain('reason: "ai_allowance_reached",');
  });
});

/* ============================================================ checkout === */

const GOOD: CheckoutValues = {
  phone: "98123 45670",
  name: "Asha Rao",
  business_name: "Asha Jewellers",
  email: "asha@example.com",
  password: "Diwali-2026!",
};

function fakeDeps(over: Partial<CheckoutDeps> = {}) {
  const calls: string[] = [];
  const state = { session: null as null | { userId: string; token: string } };
  const deps: CheckoutDeps = {
    saveLead: async (body) => {
      calls.push(`lead:${String(body["phone"])}`);
      return { ok: true };
    },
    session: async () => state.session,
    signUp: async (input) => {
      calls.push(`signUp:${input.email}:${input.fullName}`);
      state.session = { userId: OWNER, token: "tok" };
      return { userId: OWNER, token: "tok", error: null };
    },
    signIn: async () => {
      calls.push("signIn");
      return { userId: null, token: null, error: "Invalid login credentials" };
    },
    startPay: async (_t, body) => {
      calls.push(`pay${body["organization_id"] ? ":org" : ""}`);
      return {
        status: 200,
        body: {
          ok: true,
          payment_id: "pay-1",
          checkout: { payment_session_id: "s", mode: "sandbox" },
          meta: {
            event: "AddPaymentInfo",
            event_id: "AddPaymentInfo.pay-1",
            params: { value: 999 },
          },
        },
      };
    },
    createWorkspace: async () => {
      calls.push("workspace");
      return { orgId: ORG };
    },
    openGateway: async () => {
      calls.push("gateway");
      return { error: null };
    },
    confirm: async () => {
      calls.push("confirm");
      return "paid";
    },
    onRegistered: () => calls.push("registered"),
    onAddPaymentInfo: (m) => calls.push(`api:${m.event_id}`),
    wait: async () => undefined,
    ...over,
  };
  return { deps, calls, state };
}

describe("the one-screen checkout", () => {
  it("end to end: lead once → the existing sign-up → pay → Cashfree's popup → confirmed paid", async () => {
    const { deps, calls } = fakeDeps();
    const out = await runCheckout(GOOD, deps);
    expect(out).toEqual({ kind: "paid", paymentId: "pay-1", firstName: "Asha" });
    expect(calls).toEqual([
      "lead:98123 45670",
      "signUp:asha@example.com:Asha Rao",
      "registered",
      "pay",
      "api:AddPaymentInfo.pay-1",
      "gateway",
      "confirm",
    ]);
  });

  it("uses the existing email + password sign-up (the same auth.signUp call /signup makes); no sign-up fork", () => {
    const sheet = readFileSync("src/components/p999/checkout-999.tsx", "utf8");
    const signup = readFileSync("src/routes/signup.tsx", "utf8");
    for (const src of [sheet, signup]) {
      expect(src).toContain("aidwar.auth.signUp({");
      expect(src).toContain("emailRedirectTo: `${window.location.origin}/login`,");
    }
    expect(sheet).toContain(
      "data: fullName ? { phone: e164, full_name: fullName } : { phone: e164 },",
    );
    expect(signup).toContain("data: fullName ? { phone, full_name: fullName } : { phone },");
    expect(sheet).not.toMatch(/admin\.createUser|\/auth\/v1\/admin/);
  });

  it("an email that already has an account: signs in with the typed password, or asks for it inline (no page change)", async () => {
    const taken = { userId: null, token: null, error: "User already registered" };
    const a = fakeDeps({
      signUp: async () => taken,
      signIn: async () => ({ userId: OWNER, token: "tok", error: null }),
    });
    expect((await runCheckout(GOOD, a.deps)).kind).toBe("paid");

    const b = fakeDeps({ signUp: async () => taken });
    const out = await runCheckout(GOOD, b.deps);
    expect(out).toMatchObject({ kind: "needs_password" });
    expect(b.calls).not.toContain("pay");
    // The sheet then asks only for that account's password and continues.
    const c = fakeDeps({ signIn: async () => ({ userId: OWNER, token: "tok", error: null }) });
    expect((await runCheckout(GOOD, c.deps, { existingAccount: true })).kind).toBe("paid");
    expect(c.calls.some((x) => x.startsWith("signUp"))).toBe(false);
  });

  it("a failed payment keeps the account (no plan) and everything typed; Try again doesn't sign up twice", async () => {
    const f = fakeDeps({ confirm: async () => "failed" });
    const values = { ...GOOD };
    const out = await runCheckout(values, f.deps);
    expect(out).toEqual({ kind: "failed", message: PAY_FAILED, paymentId: "pay-1" });
    expect(values).toEqual(GOOD);
    expect(PAY_FAILED).toBe("Payment didn't go through — try UPI again or another method.");
    // The retry: the session is there, so straight to a new payment.
    f.deps.confirm = async () => "paid";
    expect((await runCheckout(values, f.deps)).kind).toBe("paid");
    expect(f.calls.filter((x) => x.startsWith("signUp"))).toHaveLength(1);
  });

  it("no workspace yet: made with the onboarding's own create path, then paid", async () => {
    let first = true;
    const { deps, calls } = fakeDeps({
      startPay: async (_t, body) => {
        calls.push(`pay${body["organization_id"] ? ":org" : ""}`);
        if (first) {
          first = false;
          return { status: 409, body: { code: "needs_workspace", error: "No workspace yet." } };
        }
        return {
          status: 200,
          body: {
            ok: true,
            payment_id: "pay-2",
            checkout: { payment_session_id: "s", mode: "sandbox" },
          },
        };
      },
    });
    expect((await runCheckout(GOOD, deps)).kind).toBe("paid");
    expect(calls).toContain("workspace");
    expect(calls).toContain("pay:org");
    const sheet = readFileSync("src/components/p999/checkout-999.tsx", "utf8");
    expect(sheet).toContain('aidwar.rpc("create_organization", { org_name: orgName })');
    expect(sheet).toContain("{ name, url: null, about: null, brand: null, noWebsite: true },");
  });

  it("bad fields stop before anything is sent; the honeypot ends quietly", async () => {
    const a = fakeDeps();
    expect(await runCheckout({ ...GOOD, phone: "12345" }, a.deps)).toMatchObject({
      kind: "field",
      field: "phone",
    });
    expect(a.calls).toEqual([]);
    const b = fakeDeps();
    expect((await runCheckout({ ...GOOD, honeypot: "http://spam" }, b.deps)).kind).toBe("failed");
    expect(b.calls).toEqual([]);
  });

  it("the sheet: one screen, no nav/footer/outbound links, ✕ closes, typed data kept (password in memory only)", () => {
    const sheet = readFileSync("src/components/p999/checkout-999.tsx", "utf8");
    expect(sheet).not.toMatch(/<a\s|<Link\b|href=/);
    expect(sheet).toContain('aria-label="Close checkout"');
    expect(sheet).toContain(
      "window.sessionStorage.setItem(SAVED_KEY, JSON.stringify(savedSubset(values)));",
    );
    expect(sheet).not.toMatch(/history\.(pushState|replaceState)|popstate|beforeunload/);
    expect(sheet).toContain('redirectTarget: "_modal"');
    // The keyboards and autofill each field needs.
    for (const s of [
      'inputMode="numeric"',
      'autoComplete="tel-national"',
      'f === "name" ? "name"',
      '"organization"',
      'type={f === "email" ? "email" : "text"}',
      '"new-password"',
    ]) {
      expect(sheet).toContain(s);
    }
  });
});

/* =============================================================== lead === */

describe("the /999 lead", () => {
  const meta = { ip: "203.0.113.5", referrer: "https://aidwar.in/999", cookieLeadId: null };

  it("saved once with source landing_999; the same buyer again updates it; mirrored into AiDwar's workspace", async () => {
    const w = world();
    const first = await saveCheckoutLead(
      w.supabase as never,
      { phone: "98123 45670", name: "Asha Rao", business_name: "Asha Jewellers" },
      meta,
    );
    expect(first).toMatchObject({ ok: true, duplicate: false });
    const again = await saveCheckoutLead(
      w.supabase as never,
      { phone: "+91 98123 45670", name: "Asha Rao", business_name: "Asha Jewellers Pvt" },
      { ...meta, cookieLeadId: (first as { id: string }).id },
    );
    expect(again).toMatchObject({ ok: true, duplicate: true });
    const rows = w.rows("demo_leads");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "landing_999",
      phone: "+919812345670",
      business_name: "Asha Jewellers Pvt",
      landing_path: "/999",
    });
  });

  it("India-only number rules (Batch 78) and the honeypot", async () => {
    const w = world();
    expect(
      await saveCheckoutLead(
        w.supabase as never,
        { phone: "+1 917 700 2867", name: "A B", business_name: "Shop" },
        meta,
      ),
    ).toMatchObject({ ok: false, field: "phone" });
    expect(
      await saveCheckoutLead(
        w.supabase as never,
        { phone: "99999 99999", name: "A B", business_name: "Shop" },
        meta,
      ),
    ).toMatchObject({ ok: false, field: "phone" });
    expect(
      await saveCheckoutLead(
        w.supabase as never,
        { phone: "98123 45670", name: "A B", business_name: "Shop", company_website_confirm: "x" },
        meta,
      ),
    ).toMatchObject({ ok: true, honeypot: true });
    expect(w.rows("demo_leads")).toHaveLength(0);
    expect(fieldError("phone", { ...GOOD, phone: "73078015438" })).toBe(
      "Please enter your 10-digit WhatsApp number",
    );
    expect(fieldError("phone", GOOD)).toBeNull();
  });

  it("reaching Pay marks the lead; unpaid 30 minutes on = Checkout abandoned (Admin → Leads)", async () => {
    const w = world({
      demo_leads: [
        { id: "lead-1", source: "landing_999", phone: "+919812345670", linked_user_id: null },
      ],
    });
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: "lead-1",
      phone: "98123 45670",
    });
    expect(out.ok).toBe(true);
    const lead = w.rows("demo_leads")[0]!;
    expect(lead).toMatchObject({ linked_user_id: OWNER, organization_id: ORG });
    expect(lead["checkout_at"]).toBeTruthy();
    expect(lead["payment_id"]).toBe((out as { payment_id: string }).payment_id);
    const later = Date.parse(String(lead["checkout_at"])) + 31 * 60_000;
    expect(checkoutAbandoned(lead as never, later)).toBe(true);
    expect(
      isCheckoutAbandoned({ ...lead, paid_at: "2026-11-13T10:00:00Z" } as never, later),
    ).toBe(false);
    const leads = [
      { ...lead, status: "new", assigned_to: null } as unknown as LeadRow,
      {
        id: "x",
        source: "landing_start",
        status: "new",
        phone: "+91",
        checkout_at: null,
      } as unknown as LeadRow,
    ];
    expect(
      filterLeads(leads, {
        status: "all",
        search: "",
        unassignedOnly: false,
        source: "abandoned",
        now: later,
      }),
    ).toHaveLength(1);
    expect(
      filterLeads(leads, {
        status: "all",
        search: "",
        unassignedOnly: false,
        source: "landing_999",
      }),
    ).toHaveLength(1);
  });

  it("no workspace yet: the server asks the sheet to make one", async () => {
    const w = world({ organization_members: [] });
    expect(
      await startCheckoutPayment(w.supabase as never, {
        userId: OWNER,
        leadId: null,
        phone: "98123 45670",
      }),
    ).toMatchObject({ ok: false, code: "needs_workspace" });
  });

  it("the alert says 'Website /999' and the lead mirror takes /999 leads", () => {
    const alerts = readFileSync("src/lib/lead-alerts.server.ts", "utf8");
    expect(alerts).toContain('? "Website /999"');
    expect(alerts).toContain('.in("source", ["landing_start", "landing", "landing_999"])');
    expect(readFileSync("src/lib/lead-mirror.server.ts", "utf8")).toContain(
      'const MIRROR_SOURCES = ["landing_start", "landing", "landing_999"] as const;',
    );
  });
});

/* ============================================================== events === */

describe("Meta events", () => {
  it("ViewContent on /999 ('999_page'); the page is in the pixel's public zone", () => {
    expect(pixelZone("/999")).toBe("public");
    expect(viewContentName("/999")).toBe("999_page");
  });

  it("AddPaymentInfo on Pay (server, value 999, once per payment)", async () => {
    const w = world();
    const out = await startCheckoutPayment(w.supabase as never, {
      userId: OWNER,
      leadId: null,
      phone: "98123 45670",
    });
    const id = (out as { payment_id: string }).payment_id;
    expect(h.events).toEqual([
      expect.objectContaining({
        event: "AddPaymentInfo",
        eventId: `AddPaymentInfo.${id}`,
        params: { value: 999, currency: "INR", content_name: "basic" },
        once: true,
      }),
    ]);
    expect((out as { meta: unknown }).meta).toMatchObject({
      event: "AddPaymentInfo",
      event_id: `AddPaymentInfo.${id}`,
    });
  });

  it("Purchase only for a paid payment: 'Purchase.' + payment id, value 999; other plans keep Subscribe", async () => {
    const w = world({
      payments: [
        {
          id: "p999",
          organization_id: ORG,
          status: "paid",
          purpose: "plan_fee",
          amount: 999,
          raw: { source: "landing_999", gross_amount: 999 },
        },
        {
          id: "pnew",
          organization_id: ORG,
          status: "pending",
          purpose: "plan_fee",
          amount: 999,
          raw: { source: "landing_999" },
        },
        {
          id: "pgro",
          organization_id: ORG,
          status: "paid",
          purpose: "plan_fee",
          amount: 4999,
          raw: { gross_amount: 4999 },
        },
      ],
    });
    const { paymentConversion } =
      await vi.importActual<typeof import("./meta-capi.server")>("./meta-capi.server");
    expect(await paymentConversion(w.supabase as never, "p999")).toMatchObject({
      event: "Purchase",
      eventId: "Purchase.p999",
      params: { value: 999, currency: "INR", content_name: "basic" },
    });
    expect(await paymentConversion(w.supabase as never, "pnew")).toBeNull();
    expect((await paymentConversion(w.supabase as never, "pgro"))?.event).toBe("Subscribe");
  });

  it("InitiateCheckout's server copy only with consent and only from /999", async () => {
    const w = world();
    void w;
    const { Route } = await import("@/routes/api/public/meta-event");
    const handler = (
      Route.options as unknown as {
        server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> };
      }
    ).server.handlers["POST"]!;
    const post = (body: Row) =>
      handler({
        request: new Request("https://aidwar.in/api/public/meta-event", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      });
    await post({
      event: "InitiateCheckout",
      event_id: "InitiateCheckout.abcdef1234",
      url: "https://aidwar.in/999",
    });
    await post({
      event: "InitiateCheckout",
      event_id: "InitiateCheckout.abcdef1234",
      consent: true,
      url: "https://aidwar.in/start",
    });
    expect(h.events).toHaveLength(0);
    await post({
      event: "InitiateCheckout",
      event_id: "InitiateCheckout.abcdef1234",
      consent: true,
      url: "https://aidwar.in/999",
    });
    expect(h.events).toEqual([
      expect.objectContaining({
        event: "InitiateCheckout",
        eventId: "InitiateCheckout.abcdef1234",
        params: { value: 999, currency: "INR", content_name: "basic" },
      }),
    ]);
  });

  it("no Lead and no LeadUnverified from /999: an account made in the checkout sends CompleteRegistration only", async () => {
    const w = world();
    Object.assign(w.supabase as object, {
      auth: {
        admin: {
          getUserById: async () => ({
            data: {
              user: {
                id: OWNER,
                email: "asha@example.com",
                created_at: new Date().toISOString(),
                user_metadata: { phone: "+919812345670", full_name: "Asha Rao" },
              },
            },
          }),
        },
      },
    });
    const { Route } = await import("@/routes/api/public/meta-event");
    const handler = (
      Route.options as unknown as {
        server: { handlers: Record<string, (a: { request: Request }) => Promise<Response>> };
      }
    ).server.handlers["POST"]!;
    await handler({
      request: new Request("https://aidwar.in/api/public/meta-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "CompleteRegistration",
          user_id: OWNER,
          source: "landing_999",
          url: "https://aidwar.in/999",
        }),
      }),
    });
    expect(h.events.map((e) => e["event"])).toEqual(["CompleteRegistration"]);
    for (const f of [
      "src/lib/checkout-999.server.ts",
      "src/lib/checkout-999-flow.ts",
      "src/components/p999/checkout-999.tsx",
      "src/components/p999/page-999.tsx",
    ]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/["']Lead["']|LeadUnverified|leadEventId/);
    }
    expect(readFileSync("src/components/p999/checkout-999.tsx", "utf8")).toContain(
      'pixel.trackRegistration(userId, phone, "landing_999")',
    );
  });
});

/* ================================================================ page === */

describe("the /999 page", () => {
  it("calculator: Meta's base rate × messages; typical tools 20–40%; we promise the low end", () => {
    const rates = { marketing: 0.8631, utility: 0.115 };
    expect(calc(3000, "offers", rates)).toEqual({
      meta: 2589,
      markupLow: 518,
      markupHigh: 1036,
      saveAtLeast: 518,
    });
    expect(calc(10000, "updates", rates)).toEqual({
      meta: 1150,
      markupLow: 230,
      markupHigh: 460,
      saveAtLeast: 230,
    });
    // The slider's ends hold.
    expect(calc(100, "offers", rates).meta).toBe(Math.round(CALC.min * 0.8631));
    expect(calc(99999, "offers", rates).meta).toBe(Math.round(CALC.max * 0.8631));
    expect(CALC.metaPricingUrl).toMatch(/^https:\/\/developers\.facebook\.com\//);
    // Base rates come from message_rates, never the rate card (client_rate_for).
    const loader = readFileSync("src/lib/public-rates.server.ts", "utf8");
    const base = loader.slice(loader.indexOf("export async function loadMetaBaseRates"));
    expect(base).toContain('.from("message_rates")');
    expect(base).not.toContain("client_rate_for");
  });

  it("sticky bar: after the hero button scrolls away; hidden while checkout or the final button is on screen", () => {
    expect(
      stickyVisible({ heroCtaVisible: true, finalCtaVisible: false, checkoutOpen: false }),
    ).toBe(false);
    expect(
      stickyVisible({ heroCtaVisible: false, finalCtaVisible: false, checkoutOpen: false }),
    ).toBe(true);
    expect(
      stickyVisible({ heroCtaVisible: false, finalCtaVisible: false, checkoutOpen: true }),
    ).toBe(false);
    expect(
      stickyVisible({ heroCtaVisible: false, finalCtaVisible: true, checkoutOpen: false }),
    ).toBe(false);
  });

  it("reduced motion: every animation and every hidden-before-play state is inside prefers-reduced-motion: no-preference", async () => {
    const { P999_CSS } = await import("@/components/p999/p999-css");
    const i = P999_CSS.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(i).toBeGreaterThan(0);
    const outside = P999_CSS.slice(0, i);
    expect(outside).not.toMatch(/animation\s*:/);
    // Hidden outside the block only: the bar's own off state, the hover glow, decorative confetti.
    const hiddenRules = [...outside.matchAll(/([^{}]+)\{[^}]*opacity:\s*0(?:\.0+1)?\s*;/g)].map(
      (m) => m[1]!.trim(),
    );
    expect(hiddenRules).toEqual([".p9-cta-glow", '.p9-sticky[data-on="false"]', ".p9-confetti i"]);
    // Motion is transform/opacity (plus stroke draws) — no layout properties animated.
    const inside = P999_CSS.slice(i);
    expect(inside).not.toMatch(/@keyframes[^{]+\{[^}]*\b(width|height|top|left|margin)\s*:/);
  });

  it("demo: six example businesses, each a customer question and Aiden's answer, timed like WhatsApp", () => {
    expect(DEMO_CHATS.map((c) => c.label)).toEqual([
      "Jewellery",
      "Fashion",
      "Food & café",
      "Clinic & salon",
      "Education",
      "Online store",
    ]);
    for (const c of DEMO_CHATS) {
      expect(c.lines[0]!.from).toBe("customer");
      expect(c.lines.some((l) => l.from === "aiden")).toBe(true);
      expect(c.shop.startsWith("Your ")).toBe(true); // never a real business
      const beats = demoBeats(c);
      expect(beats.filter((b) => b.typing)).toHaveLength(
        c.lines.filter((l) => l.from === "aiden").length,
      );
      expect(beats[beats.length - 1]!.show).toBe(-1);
    }
  });

  it("renders: the headline, flat ₹999 with no GST anywhere, 6 FAQs, no made-up proof or AI vendor names", async () => {
    const { Page999 } = await import("@/components/p999/page-999");
    const html = renderToStaticMarkup(
      <Page999
        rates={{ marketing: 0.8631, utility: 0.115, effective_from: "2026-01-01" }}
        aidenLink={null}
        returningPaymentId={null}
      />,
    );
    const text = html
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;/g, "'");
    expect(text).toMatch(/Your\s+AI\s+salesperson\s+on\s+WhatsApp\./);
    expect(text).toContain("Pay Meta directly — we add");
    expect(text).toContain("7-day money-back · Live in 10 minutes · Cancel anytime");
    expect(text).toContain("Start for ₹999");
    for (const banned of [
      /GST/,
      /1,178/,
      /179\.82/,
      /GSTIN/,
      /Claude|ChatGPT|OpenAI|Gemini/i,
      /\b1000\+|thousands of businesses/i,
    ]) {
      expect(text).not.toMatch(banned);
    }
    const questions = faq({ marketing: 0.8631, utility: 0.115 }).map((f) => f.q);
    expect(questions).toEqual([
      "What's the catch?",
      "How much will Meta charge me?",
      "Do I need a website?",
      "Can I use my existing number?",
      "What happens after 300 AI answers?",
      "How do I cancel?",
    ]);
    for (const q of questions) expect(text).toContain(q.replace(/'/g, "'"));
    // The only real figure is ZOORI's, already public on /start; the screen is the real inbox.
    expect(text).toContain("1,900+");
    expect(html).toContain('src="/999-inbox-aiden.webp"');
    // Checkout code stays out of the first paint (lazy chunks).
    const page = readFileSync("src/components/p999/page-999.tsx", "utf8");
    for (const chunk of ["demo-999", "calculator-999", "checkout-999"]) {
      expect(page).toContain(`import("@/components/p999/${chunk}")`);
    }
  });

  it("the route is noindex (like /start) and every checkout total is ₹999", () => {
    const route = readFileSync("src/routes/999.tsx", "utf8");
    expect(route).toContain('{ name: "robots", content: "noindex,follow" }');
    const sheet = readFileSync("src/components/p999/checkout-999.tsx", "utf8");
    expect(sheet).not.toMatch(/GST|1,178|179\.82/);
    expect(readFileSync("src/lib/page-999.ts", "utf8")).toContain('pay: "Pay ₹999 →",');
  });

  it("password hint and money-back line on the refund policy", () => {
    expect(passwordStrength("short").score).toBe(0);
    expect(passwordStrength("abcdefgh").score).toBe(1);
    expect(passwordStrength("Diwali-2026!").score).toBe(3);
    expect(readFileSync("src/routes/refunds.tsx", "utf8")).toContain(
      "AiDwar Basic (₹999/month, bought on aidwar.in/999) comes with a 7-day money-back guarantee",
    );
  });
});
