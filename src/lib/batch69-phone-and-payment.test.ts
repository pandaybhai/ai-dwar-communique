import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 69 — two fixes found while recording the first paid plan. Fakes only:
 * the in-memory database, Razorpay and the WhatsApp sender mocked, Cashfree a
 * fake on fetch. Nothing reaches a live database, WhatsApp, Meta or Cashfree.
 *
 *  1. Every typed-and-stored phone Batch 66 didn't cover now takes the one
 *     rule (enteredPhone) with the workspace's default country code: the
 *     billing WhatsApp (Super Admin form and the customer's plan purchase),
 *     staff alert numbers, the onboarding and sign-up numbers. ZOORI's
 *     "81213 10333" → +918121310333; a number with its code is unchanged.
 *  2. Record plan payment: after a save the card shows the saved result, and
 *     a period already paid says so — never "₹5,000.00 over".
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  createPaymentLink: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/permissions.server", () => ({ hasPermission: async () => true }));
vi.mock("@/lib/billing-statement.server", () => ({
  buildStatementLines: async () => [],
  planFeeRoiSnapshot: async () => null,
}));
vi.mock("@/lib/razorpay.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./razorpay.server")>()),
  razorpayKeys: async () => ({ keyId: "rzp_test_x", keySecret: "rzp_test_secret_not_real" }),
  createPaymentLink: h.createPaymentLink,
}));
vi.mock("@/lib/billing-notify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./billing-notify.server")>()),
  resolvePlatformOrg: async () => "org-platform",
  recipientFor: async () => "+918121310333",
}));
vi.mock("@/lib/campaigns.server", () => ({
  loadSenderContext: async () => ({ fake: true }),
  sendCampaignTemplate: h.send,
}));

import { ENTER_WITH_COUNTRY, INDIA_MOBILE_ERROR, normalizePhone, typedPhone } from "./phone";
import { addContactPhone } from "./add-contact-phone";
import { workspaceTypedPhone } from "./default-country";
import { alertPhonesNeedCountry, validateAlertSettings } from "./handoff-alerts.server";
import { saveBillingAccount } from "./billing-admin.server";
import { startPlanPurchase } from "./plan-purchase.server";
import { cashfreePhone } from "./cashfree.server";
import { signupPhone } from "@/routes/signup";
import { planPaymentPreview, recordPlanPayment } from "./plan-payment.server";
import { paidNotice, planPaymentPanel, savedResultLines } from "./plan-payment";
import { money } from "./billing";

const ZOORI = "81c234b2-569f-40be-ad71-96c046de5d12";
const US_SHOP = "org-us";
const ADMIN = "user-super";
const OWNER = "user-owner";
/** A workspace still on its trial, choosing its first plan. */
const TRIAL: Row = { plan_status: "trial", plan_version_id: null };
const TOO_SHORT = `Too short: needs 10 digits, or + and the country code. ${ENTER_WITH_COUNTRY}`;

function world(extra: Record<string, Row[]> = {}, flag = false, org: Row = {}): MemoryDb {
  let seq = 30;
  const db = memoryDb(
    {
      platform_settings: [
        {
          id: true,
          supplier_legal_name: "Meezoy Ventures Private Limited",
          supplier_brand_name: "AiDwar",
          supplier_state_code: "36",
          supplier_gstin: null,
          supplier_pan: null,
          supplier_address: { line1: "3-3-303, Subric Street", city: "Secunderabad" },
          invoice_series: "AD",
        },
      ],
      organizations: [
        {
          id: ZOORI,
          name: "ZOORI Jewels",
          billing_account_id: "ba-1",
          plan_status: "active",
          plan_version_id: "pv-growth",
          billing_day: 10,
          billing_enabled_at: "2026-11-01T00:00:00Z",
          default_country_code: "91",
          ...org,
        },
        { id: US_SHOP, name: "Brooklyn Beads", default_country_code: "1" },
      ],
      billing_accounts: [
        {
          id: "ba-1",
          name: "ZOORI Jewels",
          state_code: "36",
          country_code: "IN",
          currency: "INR",
          billing_whatsapp: null,
        },
      ],
      plans: [
        {
          key: "growth",
          name: "Growth",
          tagline: null,
          sort_order: 1,
          is_active: true,
          is_public: true,
          plan_versions: [
            {
              id: "pv-growth",
              price_monthly: 4999,
              price_annual: null,
              currency: "INR",
              limits: {},
              highlights: [],
              is_current: true,
            },
          ],
        },
      ],
      plan_versions: [
        { id: "pv-growth", version: 1, price_monthly: 4999, plans: { name: "Growth" } },
      ],
      organization_billing_settings: [{ organization_id: ZOORI, limits_override: {} }],
      profiles: [
        { id: ADMIN, is_super_admin: true },
        { id: OWNER, is_super_admin: false, email: "owner@zoori.test" },
      ],
      message_templates: [
        {
          organization_id: "org-platform",
          name: "client_invoice_issued",
          language: "en",
          status: "APPROVED",
          components: [],
        },
      ],
      invoices: [],
      invoice_lines: [],
      payments: [],
      subscriptions: [],
      wallet_ledger: [],
      billing_notifications: [],
      activity_log: [],
      ...extra,
    },
    {
      org_flag_enabled: () => ({ data: flag, error: null }),
      next_invoice_number: (a) => {
        seq += 1;
        return {
          data: `${String(a["p_series"])}/2026-27/${String(seq).padStart(5, "0")}`,
          error: null,
        };
      },
      wallet_apply: () => ({ data: "ledger-x", error: null }),
    },
  );
  Object.assign(db.supabase as object, {
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://files.test/${path}` },
          error: null,
        }),
      }),
    },
  });
  h.db = { supabase: db.supabase };
  return db;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T06:00:00Z"));
  h.send.mockReset();
  h.send.mockResolvedValue({ messageId: "wamid-1", error: null });
  h.createPaymentLink.mockReset();
  h.createPaymentLink.mockResolvedValue({
    link: { id: "plink_1", short_url: "https://rzp.io/i/abc", raw: { id: "plink_1" } },
    error: null,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("(1) the one phone rule for typed numbers (typedPhone)", () => {
  it("ZOORI's 81213 10333 → +918121310333; a number with its code is exactly as before", () => {
    expect(typedPhone("81213 10333", "91")).toEqual({ phone: "+918121310333", addedCountry: true });
    for (const n of ["+918121310333", "+91 81213 10333", "918121310333", "0091 81213 10333"])
      expect(typedPhone(n, "91"), n).toEqual({
        phone: normalizePhone(n.replace(/^0091/, "+91")),
        addedCountry: false,
      });
    expect(typedPhone("12345", "91")).toEqual({ error: TOO_SHORT });
    // Add contact keeps its exact Batch 66 answers through the same helper.
    expect(addContactPhone("12345", "91")).toEqual({ error: TOO_SHORT });
    expect(addContactPhone("81213 10333", "91")).toEqual({
      phone: "+918121310333",
      waId: "918121310333",
    });
  });

  it("the workspace's own code is read only when the number needs it; a failed read refuses", async () => {
    const db = world();
    expect(await workspaceTypedPhone(db.supabase, US_SHOP, "(415) 555-0123")).toMatchObject({
      phone: "+14155550123",
    });
    expect(await workspaceTypedPhone(db.supabase, ZOORI, "81213 10333")).toMatchObject({
      phone: "+918121310333",
    });
    const broken = {
      from: () => {
        throw new Error("no database");
      },
    };
    // With its country code: no read at all, the same number as before.
    expect(await workspaceTypedPhone(broken, ZOORI, "+918121310333")).toEqual({
      phone: "+918121310333",
      addedCountry: false,
    });
    expect(await workspaceTypedPhone(broken, ZOORI, "81213 10333")).toEqual({
      error: expect.stringContaining("default country code"),
    });
  });
});

describe("(1) billing WhatsApp: the Super Admin billing account form", () => {
  const save = (db: MemoryDb, billingWhatsapp: string, organizationId = ZOORI) =>
    saveBillingAccount(db.supabase, {
      actorId: ADMIN,
      organizationId,
      accountId: organizationId === ZOORI ? "ba-1" : null,
      account: { name: "ZOORI Jewels", billing_whatsapp: billingWhatsapp },
    });

  it("81213 10333 → +918121310333 (the live row's mistake)", async () => {
    const db = world();
    expect(await save(db, "81213 10333")).toMatchObject({ ok: true });
    expect(db.rows("billing_accounts")[0]!["billing_whatsapp"]).toBe("+918121310333");
  });

  it("+918121310333 is saved unchanged; empty stays empty", async () => {
    const db = world();
    await save(db, "+918121310333");
    expect(db.rows("billing_accounts")[0]!["billing_whatsapp"]).toBe("+918121310333");
    await save(db, "  ");
    expect(db.rows("billing_accounts")[0]!["billing_whatsapp"]).toBeNull();
  });

  it("a bad number is refused with the Batch 66 sentence, and nothing is written", async () => {
    const db = world({
      billing_accounts: [{ id: "ba-1", name: "ZOORI Jewels", billing_whatsapp: "+918121310333" }],
    });
    // Batch 78: an Indian workspace's own number answers with India's line.
    expect(await save(db, "12345")).toEqual({ error: `Billing WhatsApp: ${INDIA_MOBILE_ERROR}` });
    expect(db.rows("billing_accounts")[0]!["billing_whatsapp"]).toBe("+918121310333");
  });

  it("another workspace's default code is used for its own numbers", async () => {
    const db = world();
    expect(await save(db, "415 555 0123", US_SHOP)).toMatchObject({ ok: true });
    const created = db.rows("billing_accounts").find((a) => a["id"] !== "ba-1")!;
    expect(created["billing_whatsapp"]).toBe("+14155550123");
  });
});

describe("(1) billing WhatsApp: the customer's own billing details (plan purchase, both designs)", () => {
  it("81213 10333 → +918121310333 on the billing account; Razorpay gets the same number", async () => {
    const db = world({}, false, TRIAL);
    const out = await startPlanPurchase(db.supabase, {
      organizationId: ZOORI,
      userId: OWNER,
      planKey: "growth",
      billingWhatsapp: "81213 10333",
    });
    expect(out).toMatchObject({ url: "https://rzp.io/i/abc" });
    expect(db.rows("billing_accounts")[0]!["billing_whatsapp"]).toBe("+918121310333");
    expect(h.createPaymentLink.mock.calls[0]![1]).toMatchObject({
      customer: { contact: "+918121310333" },
    });
  });

  it("a bad number is refused before any payment is started", async () => {
    const db = world({}, false, TRIAL);
    const out = await startPlanPurchase(db.supabase, {
      organizationId: ZOORI,
      userId: OWNER,
      planKey: "growth",
      billingWhatsapp: "12345",
    });
    // Batch 78: an Indian workspace's own number answers with India's line.
    expect(out).toEqual({ error: `Billing WhatsApp: ${INDIA_MOBILE_ERROR}` });
    expect(db.rows("payments")).toHaveLength(0);
    expect(h.createPaymentLink).not.toHaveBeenCalled();
  });

  it("Cashfree's customer phone is what it was before (8121310333)", async () => {
    expect(cashfreePhone("+918121310333")).toBe(cashfreePhone("8121310333"));
    vi.stubEnv("CASHFREE_CLIENT_ID", "TEST-not-a-real-client-id");
    vi.stubEnv("CASHFREE_CLIENT_SECRET", "cfsk_ma_test_not_real");
    vi.stubEnv("CASHFREE_ENV", "sandbox");
    const orders: Row[] = [];
    vi.stubGlobal("fetch", async (_input: string | URL, init: RequestInit = {}) => {
      const body = JSON.parse(String(init.body ?? "{}")) as Row;
      orders.push(body);
      return new Response(
        JSON.stringify({
          cf_order_id: 1,
          order_id: body["order_id"],
          order_amount: body["order_amount"],
          order_status: "ACTIVE",
          payment_session_id: "session_1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const db = world({}, true, TRIAL);
    await startPlanPurchase(db.supabase, {
      organizationId: ZOORI,
      userId: OWNER,
      planKey: "growth",
      billingWhatsapp: "81213 10333",
    });
    expect(orders[0]!["customer_details"]).toMatchObject({ customer_phone: "8121310333" });
  });
});

describe("(1) staff alert numbers, onboarding and sign-up", () => {
  it("staff alerts: 81213 10333 → +918121310333; with its code unchanged; bad refused", () => {
    expect(alertPhonesNeedCountry(["81213 10333"])).toBe(true);
    expect(alertPhonesNeedCountry(["+918121310333", ""])).toBe(false);
    expect(validateAlertSettings({ phones: ["81213 10333"] }, [], "91")).toEqual({
      ok: true,
      settings: { phones: ["+918121310333"], email: null },
    });
    expect(validateAlertSettings({ phones: ["+918121310333"] }, [], null)).toEqual({
      ok: true,
      settings: { phones: ["+918121310333"], email: null },
    });
    // Batch 78: India's line for an Indian workspace (never a guessed country).
    expect(validateAlertSettings({ phones: ["12345"] }, [], "91")).toEqual({
      ok: false,
      error: `“12345”: ${INDIA_MOBILE_ERROR}`,
    });
    expect(validateAlertSettings({ phones: ["73078015438"] }, [], "91").ok).toBe(false);
    // The business's own number is still refused, however it is written.
    const own = validateAlertSettings({ phones: ["81213 10333"] }, ["+91 81213 10333"], "91");
    expect(own.ok).toBe(false);
  });

  it("staff alerts route: reads the workspace's code only when a number needs it", () => {
    const route = readFileSync("src/routes/api/ai/employee.ts", "utf8");
    expect(route).toMatch(
      /alertPhonesNeedCountry\(payload\["phones"\]\)[\s\S]{0,200}loadDefaultCountryCode/,
    );
  });

  it("onboarding: the typed number goes through the rule with the workspace's code", () => {
    const route = readFileSync("src/routes/api/onboarding/start.ts", "utf8");
    expect(route).toContain("workspaceTypedPhone(supabaseAdmin, auth.organizationId, typedPhone)");
    expect(route).not.toContain('normalizePhone(String(payload["phone"]');
  });

  it("sign-up: 81213 10333 → +918121310333; a trunk 0 is dropped; bad refused with the Batch 66 sentence", () => {
    expect(signupPhone("81213 10333")).toEqual({ phone: "+918121310333" });
    expect(signupPhone("+918121310333")).toEqual({ phone: "+918121310333" });
    // Before: "+08121310333" was stored.
    expect(signupPhone("08121310333")).toEqual({ phone: "+918121310333" });
    // Batch 78: sign-up uses /start's rule — India's line, and no +7 slip.
    expect(signupPhone("12345")).toEqual({ error: INDIA_MOBILE_ERROR });
    expect(signupPhone("73078015438")).toEqual({ error: INDIA_MOBILE_ERROR });
  });
});

describe("(2) Record plan payment: after a save, and a paid period", () => {
  const zooriSave = {
    actorId: ADMIN,
    organizationId: ZOORI,
    periodStart: "2026-11-10",
    amount: 5000,
    method: "bank_transfer",
    reference: "631500744741",
    paidOn: "2026-11-11",
  };

  it("ZOORI: the saved result shows the invoice, paid and ₹1 over; never ₹5,000 over", async () => {
    const db = world();
    const saved = await recordPlanPayment(db.supabase, zooriSave);
    expect(saved).toMatchObject({ ok: true, reference: "631500744741", excess: 1 });
    if (!("ok" in saved)) throw new Error("not saved");

    // What the card fetches right after the save (the same amount still typed).
    const after = await planPaymentPreview(db.supabase, {
      actorId: ADMIN,
      organizationId: ZOORI,
      periodStart: "2026-11-10",
      amount: 5000,
    });
    if ("error" in after) throw new Error(after.error);

    // Right after the save: the saved result, not the preview.
    expect(planPaymentPanel(after, saved)).toBe("saved");
    const lines = savedResultLines(saved, money).join("\n");
    expect(lines).toContain(
      `Recorded: invoice ${saved.invoice_number} for 10 Nov 2026 to 9 Dec 2026 is paid (ref 631500744741).`,
    );
    expect(lines).toContain(`${money(1)} over the invoice is left unapplied`);
    expect(lines).not.toContain(money(5000));

    // Changing anything afterwards (or reopening): the paid notice, no difference.
    expect(planPaymentPanel(after, null)).toBe("paid");
    expect(after.paid).toEqual({
      invoice_number: saved.invoice_number,
      reference: "631500744741",
      method: "Bank transfer",
      excess: 1,
    });
    expect(paidNotice(after.paid!)).toBe(
      `This period is paid (invoice ${saved.invoice_number}, ref 631500744741).`,
    );
    expect(after.warnings.join(" ")).not.toMatch(/already paid/);
  });

  it("reopening the sheet later for the paid period shows the paid notice", async () => {
    const db = world();
    await recordPlanPayment(db.supabase, zooriSave);
    const reopened = await planPaymentPreview(db.supabase, {
      actorId: ADMIN,
      organizationId: ZOORI,
      periodStart: "2026-11-10",
    });
    if ("error" in reopened) throw new Error(reopened.error);
    expect(planPaymentPanel(reopened, null)).toBe("paid");
    // The next period is offered by default, as an ordinary preview.
    const next = await planPaymentPreview(db.supabase, { actorId: ADMIN, organizationId: ZOORI });
    if ("error" in next) throw new Error(next.error);
    expect(next.period.start).toBe("2026-12-10");
    expect(planPaymentPanel(next, null)).toBe("preview");
    expect(next.paid).toBeNull();
  });

  it("an unpaid period is still the ordinary preview with its difference", async () => {
    const db = world();
    const preview = await planPaymentPreview(db.supabase, {
      actorId: ADMIN,
      organizationId: ZOORI,
      amount: 5000,
    });
    if ("error" in preview) throw new Error(preview.error);
    expect(planPaymentPanel(preview, null)).toBe("preview");
    expect(preview.paid).toBeNull();
    expect(preview.figures).toMatchObject({ difference: 1, excess: 1 });
  });

  it("the card shows the saved result after a save, and refreshes the preview underneath", () => {
    const card = readFileSync("src/components/admin/record-plan-payment.tsx", "utf8");
    const save = card.slice(
      card.indexOf("async function save()"),
      card.indexOf("/** Any change after a save"),
    );
    // The refreshed preview (now "paid") is ready for the first change after the save.
    expect(save.indexOf("setDone(data)")).toBeLessThan(save.indexOf("check({"));
    expect(card).toContain("planPaymentPanel(preview, done)");
    expect(card).toContain('panel === "saved"');
    expect(card).toContain('panel === "paid"');
    expect(card).toContain('panel === "preview"');
    // Every field clears the saved result, so the panel follows the fresh preview.
    expect(card.match(/onChange=\{edit\(set/g)).toHaveLength(6);
  });
});
