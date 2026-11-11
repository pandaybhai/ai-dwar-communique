import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 68 — Super Admin "Record plan payment" for a plan fee paid offline.
 * Fakes only: the in-memory database, a fake file store, Razorpay and the
 * WhatsApp sender mocked. Nothing reaches a live database, WhatsApp, Meta or
 * Cashfree.
 *
 * The live case: ZOORI Jewels, Growth v1 at Rs 4,999, no-GST mode, paid
 * Rs 5,000 by bank transfer on 11 Nov 2026 (ref 631500744741) for the period
 * starting 10 Nov 2026.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  createPaymentLink: vi.fn(),
  send: vi.fn(),
  uploads: new Map<string, Uint8Array>(),
  statement: [] as Record<string, unknown>[],
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/billing-statement.server", () => ({
  buildStatementLines: async () => h.statement,
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
  recipientFor: async () => "+919876543210",
}));
vi.mock("@/lib/campaigns.server", () => ({
  loadSenderContext: async () => ({ fake: true }),
  sendCampaignTemplate: h.send,
}));

import { recordPlanPayment, planPaymentPreview } from "./plan-payment.server";
import {
  billingDayFor,
  currentPeriodStart,
  defaultPeriodStart,
  planPaymentFigures,
  planPeriod,
  sameDateNextMonth,
} from "./plan-payment";
import { invoicePlanFee, runPlanBilling } from "./plan-billing.server";
import { adminOrgPayments } from "./billing-admin.server";

const ZOORI = "81c234b2-569f-40be-ad71-96c046de5d12";
const ADMIN = "user-super";
const MEMBER = "user-member";
const REAL_GSTIN = "36ABCDE1234F1Z5";

type World = MemoryDb & { walletCalls: Row[] };

function world(
  opts: { settings?: Row; org?: Row; billing?: Row; extra?: Record<string, Row[]> } = {},
): World {
  let seq = 30;
  const walletCalls: Row[] = [];
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
          ...opts.settings,
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
          trial_ends_at: null,
          ...opts.org,
        },
      ],
      billing_accounts: [
        {
          id: "ba-1",
          name: "ZOORI Jewels",
          state_code: "36",
          country_code: "IN",
          currency: "INR",
          billing_email: "accounts@zoori.test",
          billing_whatsapp: "+919876543210",
        },
      ],
      plan_versions: [
        { id: "pv-growth", version: 1, price_monthly: 4999, plans: { name: "Growth" } },
      ],
      organization_billing_settings: [
        { organization_id: ZOORI, limits_override: {}, plan_fee_override: null, ...opts.billing },
      ],
      profiles: [
        { id: ADMIN, is_super_admin: true },
        { id: MEMBER, is_super_admin: false },
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
      ...opts.extra,
    },
    {
      org_flag_enabled: () => ({ data: false, error: null }),
      next_invoice_number: (a) => {
        seq += 1;
        return {
          data: `${String(a["p_series"])}/2026-27/${String(seq).padStart(5, "0")}`,
          error: null,
        };
      },
      wallet_apply: (a) => {
        walletCalls.push(a);
        return { data: "ledger-x", error: null };
      },
    },
  );
  // A fake file store for the invoice PDFs (render → upload → signed link).
  Object.assign(db.supabase as object, {
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array) => {
          h.uploads.set(path, bytes);
          return { error: null };
        },
        createSignedUrl: async (path: string) => ({
          data: { signedUrl: `https://files.test/${path}` },
          error: null,
        }),
      }),
    },
  });
  h.db = { supabase: db.supabase };
  return Object.assign(db, { walletCalls });
}

/** The text a pdf-lib invoice draws, read back from its (deflated) content streams. */
function pdfText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf("endstream", start);
    const chunk = Buffer.from(raw.slice(start, end), "latin1");
    let body: string;
    try {
      body = inflateSync(chunk).toString("latin1");
    } catch {
      body = chunk.toString("latin1");
    }
    for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      out.push(Buffer.from(t[1]!, "hex").toString("latin1"));
    }
    for (const t of body.matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)) out.push(t[1]!);
  }
  return out.join("\n");
}

const zooriSave = {
  actorId: ADMIN,
  organizationId: ZOORI,
  periodStart: "2026-11-10",
  amount: 5000,
  method: "bank_transfer",
  reference: "631500744741",
  paidOn: "2026-11-11",
  note: "Growth plan, first month",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T06:00:00Z"));
  h.uploads.clear();
  h.statement = [];
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
  vi.restoreAllMocks();
});

describe("periods and figures (pure)", () => {
  it("a period runs from its start to the day before the same date next month", () => {
    expect(planPeriod("2026-11-10")).toEqual({
      start: "2026-11-10",
      end: "2026-12-09",
      next_start: "2026-12-10",
    });
    expect(planPeriod("2026-12-10").end).toBe("2027-01-09");
    expect(sameDateNextMonth("2027-01-31")).toBe("2027-02-28");
    expect(billingDayFor("2026-11-10")).toBe(10);
    expect(billingDayFor("2026-11-30")).toBe(28);
  });

  it("the next unpaid period: oldest unpaid invoice, else after the last paid one, else the current one", () => {
    expect(defaultPeriodStart([], 10, "2026-11-11")).toBe("2026-11-10");
    expect(defaultPeriodStart([], 10, "2026-11-09")).toBe("2026-10-10");
    expect(currentPeriodStart(1, "2026-11-11")).toBe("2026-11-01");
    const paid = { period_start: "2026-11-10", status: "paid", total: 4999, amount_paid: 4999 };
    expect(defaultPeriodStart([paid], 10, "2026-11-20")).toBe("2026-12-10");
    const open = { period_start: "2026-10-10", status: "issued", total: 4999, amount_paid: 0 };
    expect(defaultPeriodStart([paid, open], 10, "2026-11-20")).toBe("2026-10-10");
    const cancelled = { period_start: "2026-09-10", status: "void", total: 4999, amount_paid: 0 };
    expect(defaultPeriodStart([cancelled], 10, "2026-11-20")).toBe("2026-11-10");
  });

  it("Rs 5,000 for a Rs 4,999 fee: Rs 4,999 applied, Rs 1 over; short and GST cases", () => {
    expect(planPaymentFigures({ base: 4999, gstRegistered: false, received: 5000 })).toEqual({
      base: 4999,
      gst: 0,
      total: 4999,
      received: 5000,
      difference: 1,
      applied: 4999,
      excess: 1,
      short: 0,
    });
    expect(planPaymentFigures({ base: 4999, gstRegistered: false, received: 4900 })).toMatchObject({
      applied: 4900,
      excess: 0,
      short: 99,
      difference: -99,
    });
    expect(
      planPaymentFigures({ base: 4999, gstRegistered: true, received: 5898.82 }),
    ).toMatchObject({
      gst: 899.82,
      total: 5898.82,
      applied: 5898.82,
      excess: 0,
    });
  });
});

describe("ZOORI: Growth Rs 4,999, no GST, Rs 5,000 received, period from 10 Nov 2026", () => {
  it("the preview shows plan v1, 10 Nov to 9 Dec, Rs 4,999 with no GST, Rs 1 over, billing day 10", async () => {
    const w = world();
    const preview = await planPaymentPreview(w.supabase, {
      actorId: ADMIN,
      organizationId: ZOORI,
      amount: 5000,
    });
    expect(preview).toMatchObject({
      plan_name: "Growth",
      plan_version: "v1",
      default_period_start: "2026-11-10",
      period: { start: "2026-11-10", end: "2026-12-09", next_start: "2026-12-10" },
      plan_fee: 4999,
      fee_from: "plan",
      gst_registered: false,
      figures: { total: 4999, gst: 0, received: 5000, difference: 1, excess: 1 },
      invoice: null,
      billing_day: 10,
      new_billing_day: 10,
      warnings: [],
    });
    // A preview writes nothing.
    expect(w.rows("invoices")).toHaveLength(0);
    expect(w.rows("payments")).toHaveLength(0);
  });

  it("one paid plan_fee invoice for 2026-11-10..2026-12-09, one manual payment, Rs 1 unapplied, billing day 10, no wallet credit, PDF once", async () => {
    h.statement = [
      {
        line_type: "usage",
        description: "Messages sent last month (included)",
        unit_price: 0,
        informational: true,
      },
    ];
    const w = world({ org: { billing_day: 1 } });
    const out = await recordPlanPayment(w.supabase, zooriSave);
    expect(out).toMatchObject({
      ok: true,
      already: false,
      invoice_status: "paid",
      period: { start: "2026-11-10", end: "2026-12-09" },
      applied: 4999,
      excess: 1,
      short: 0,
      billing_day: 10,
      delivered: true,
    });

    const invoices = w.rows("invoices");
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({
      kind: "invoice",
      purpose: "plan_fee",
      status: "paid",
      period_start: "2026-11-10",
      period_end: "2026-12-09",
      taxable_value: 4999,
      cgst: 0,
      sgst: 0,
      igst: 0,
      total: 4999,
      amount_paid: 4999,
      created_by: ADMIN,
      invoice_number: "AD/2026-27/00031",
    });
    // The same lines invoicePlanFee builds: the plan, then the statement lines.
    const lines = w.rows("invoice_lines").filter((l) => l["invoice_id"] === invoices[0]!["id"]);
    expect(lines.map((l) => l["description"])).toEqual([
      "Growth plan — 2026-11-10 to 2026-12-09",
      "Messages sent last month (included)",
    ]);

    // No payment link: no gateway payment, no Razorpay call.
    expect(h.createPaymentLink).not.toHaveBeenCalled();
    const payments = w.rows("payments");
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      provider: "manual",
      purpose: "plan_fee",
      method: "bank_transfer",
      amount: 5000,
      status: "paid",
      paid_at: "2026-11-11T12:00:00+05:30",
      created_by: ADMIN,
    });
    expect(payments[0]!["raw"]).toMatchObject({
      invoice_id: invoices[0]!["id"],
      reference: "631500744741",
      note: "Growth plan, first month",
      period: "2026-11-10 to 2026-12-09",
      excess: 1,
      applied: 4999,
    });
    expect(invoices[0]!["payment_id"]).toBe(payments[0]!["id"]);

    // Nothing to the wallet.
    expect(w.walletCalls).toHaveLength(0);
    expect(w.rows("wallet_ledger")).toHaveLength(0);

    // Billing day moves to the period's day; plan and status untouched.
    expect(w.rows("organizations")[0]).toMatchObject({
      billing_day: 10,
      plan_status: "active",
      plan_version_id: "pv-growth",
    });

    // The paid invoice PDF went once, and names how it was paid.
    expect(h.send).toHaveBeenCalledTimes(1);
    const pdf = [...h.uploads.values()].at(-1)!;
    expect(pdfText(pdf)).toContain("Paid via Bank transfer ref 631500744741");
    expect(invoices[0]!["sent"]).toMatchObject({ whatsapp_at: expect.any(String) });

    // Audit-logged with the actor.
    const log = w.rows("activity_log").filter((a) => a["action"] === "plan_payment_recorded");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ organization_id: ZOORI, user_id: ADMIN });
    expect(log[0]!["details"]).toMatchObject({
      reference: "631500744741",
      excess: 1,
      billing_day_to: 10,
    });

    // The sheet shows the Rs 1 as unapplied.
    const rows = await adminOrgPayments(w.supabase, ZOORI, ADMIN);
    expect(rows[0]).toMatchObject({
      plan_period: "2026-11-10 to 2026-12-09",
      reference: "631500744741",
      unapplied_amount: 1,
    });
  });

  it("saving the same period and reference again adds nothing; a different period works", async () => {
    const w = world();
    await recordPlanPayment(w.supabase, zooriSave);
    const again = await recordPlanPayment(w.supabase, {
      ...zooriSave,
      reference: " 631500744741 ",
    });
    expect(again).toMatchObject({ ok: true, already: true, excess: 1 });
    expect(w.rows("invoices")).toHaveLength(1);
    expect(w.rows("payments")).toHaveLength(1);
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(
      w.rows("activity_log").filter((a) => a["action"] === "plan_payment_recorded"),
    ).toHaveLength(1);

    // The preview says so before saving.
    const preview = await planPaymentPreview(w.supabase, {
      actorId: ADMIN,
      organizationId: ZOORI,
      periodStart: "2026-11-10",
      reference: "631500744741",
    });
    expect(preview).toMatchObject({ already_recorded: { reference: "631500744741" } });

    // A different reference for a period already paid is refused.
    const other = await recordPlanPayment(w.supabase, { ...zooriSave, reference: "999" });
    expect(other).toEqual({ error: expect.stringContaining("already paid") });
    expect(w.rows("payments")).toHaveLength(1);

    // The next period (offered by default now) is its own invoice and payment.
    const next = await planPaymentPreview(w.supabase, { actorId: ADMIN, organizationId: ZOORI });
    expect(next).toMatchObject({ default_period_start: "2026-12-10" });
    vi.setSystemTime(new Date("2026-12-11T06:00:00Z"));
    const dec = await recordPlanPayment(w.supabase, {
      ...zooriSave,
      periodStart: "2026-12-10",
      amount: 4999,
      reference: "631500999999",
      paidOn: "2026-12-11",
    });
    expect(dec).toMatchObject({
      ok: true,
      period: { start: "2026-12-10", end: "2027-01-09" },
      excess: 0,
    });
    expect(w.rows("invoices")).toHaveLength(2);
    expect(w.rows("payments")).toHaveLength(2);
    expect(w.rows("organizations")[0]!["billing_day"]).toBe(10);
  });

  it("an open plan_fee invoice for the period (with its payment link) is paid instead of raising a new one", async () => {
    const w = world();
    const raised = await invoicePlanFee(w.supabase, ZOORI, {
      start: "2026-11-10",
      end: "2026-12-10",
    });
    expect(raised).toMatchObject({ pay_url: "https://rzp.io/i/abc" });
    expect(h.send).toHaveBeenCalledTimes(1); // the unpaid invoice went out with its link
    const invoiceId = w.rows("invoices")[0]!["id"];

    const preview = await planPaymentPreview(w.supabase, {
      actorId: ADMIN,
      organizationId: ZOORI,
      amount: 5000,
    });
    expect(preview).toMatchObject({
      default_period_start: "2026-11-10",
      invoice: { id: invoiceId, status: "issued", total: 4999, open_payment_link: true },
    });
    expect((preview as { warnings: string[] }).warnings.join(" ")).toContain(
      "open online payment link",
    );

    const out = await recordPlanPayment(w.supabase, zooriSave);
    expect(out).toMatchObject({
      ok: true,
      invoice_id: invoiceId,
      invoice_status: "paid",
      excess: 1,
    });
    expect(w.rows("invoices")).toHaveLength(1);
    const invoice = w.rows("invoices")[0]!;
    expect(invoice).toMatchObject({ status: "paid", amount_paid: 4999 });
    // The paid copy carries no payment link and says how it was paid.
    expect((invoice["sent"] as Row)["pay_url"]).toBeUndefined();
    expect(invoice["sent"]).toMatchObject({
      payment_ref: "631500744741",
      payment_gateway: "Bank transfer",
      pay_url_before_paid: "https://rzp.io/i/abc",
    });
    // The paid invoice is sent once more (it had gone out unpaid), and points home.
    expect(h.send).toHaveBeenCalledTimes(2);
    expect(h.send.mock.calls[1]![3]).toMatchObject({
      variables: { "3": "https://aidwar.in/app/billing" },
    });
    // The Razorpay link's payment is left as it was (never paid, never touched).
    const manual = w.rows("payments").filter((p) => p["provider"] === "manual");
    expect(manual).toHaveLength(1);
    expect(w.rows("payments").find((p) => p["provider"] === "razorpay")).toMatchObject({
      status: "created",
    });
  });

  it("a short payment leaves the invoice part paid and its PDF without a paid line", async () => {
    const w = world();
    const out = await recordPlanPayment(w.supabase, { ...zooriSave, amount: 4900 });
    expect(out).toMatchObject({
      ok: true,
      invoice_status: "partially_paid",
      applied: 4900,
      short: 99,
      excess: 0,
    });
    expect(w.rows("invoices")[0]).toMatchObject({ status: "partially_paid", amount_paid: 4900 });
    expect((w.rows("invoices")[0]!["sent"] ?? {}) as Row).not.toHaveProperty("payment_ref");
  });

  it("a past_due workspace goes back to active through the existing dunning lift", async () => {
    const w = world({ org: { plan_status: "past_due" } });
    await recordPlanPayment(w.supabase, zooriSave);
    expect(w.rows("organizations")[0]!["plan_status"]).toBe("active");
  });
});

describe("GST mode and the fee override", () => {
  it("GST-registered: Rs 4,999 + 18% = Rs 5,898.82 on a tax invoice, paid in full", async () => {
    const w = world({
      settings: { gst_registered: true, supplier_gstin: REAL_GSTIN, supplier_pan: "ABCDE1234F" },
    });
    const preview = await planPaymentPreview(w.supabase, {
      actorId: ADMIN,
      organizationId: ZOORI,
      amount: 5898.82,
    });
    expect(preview).toMatchObject({
      gst_registered: true,
      figures: { base: 4999, gst: 899.82, total: 5898.82, difference: 0, excess: 0 },
    });
    const out = await recordPlanPayment(w.supabase, { ...zooriSave, amount: 5898.82 });
    expect(out).toMatchObject({ ok: true, invoice_status: "paid", excess: 0 });
    expect(w.rows("invoices")[0]).toMatchObject({
      kind: "tax_invoice",
      taxable_value: 4999,
      total: 5898.82,
      amount_paid: 5898.82,
    });
    expect(
      Number(w.rows("invoices")[0]!["cgst"]) + Number(w.rows("invoices")[0]!["sgst"]),
    ).toBeCloseTo(899.82, 2);
  });

  it("plan_fee_override is the fee, as the monthly run charges it", async () => {
    const w = world({ billing: { plan_fee_override: 3999 } });
    const preview = await planPaymentPreview(w.supabase, {
      actorId: ADMIN,
      organizationId: ZOORI,
      amount: 4000,
    });
    expect(preview).toMatchObject({
      plan_fee: 3999,
      fee_from: "override",
      figures: { total: 3999, excess: 1 },
    });
    const out = await recordPlanPayment(w.supabase, { ...zooriSave, amount: 4000 });
    expect(out).toMatchObject({ ok: true, invoice_status: "paid", applied: 3999, excess: 1 });
    expect(w.rows("invoices")[0]).toMatchObject({ total: 3999 });
  });
});

describe("refusals", () => {
  it("an internal workspace is refused with a clear message, and nothing is written", async () => {
    const w = world({
      billing: {
        limits_override: { _internal_workspace: { at: "2026-11-01", by: ADMIN, reason: "demo" } },
      },
    });
    const out = await recordPlanPayment(w.supabase, zooriSave);
    expect(out).toEqual({ error: expect.stringContaining("internal workspace") });
    expect(w.rows("invoices")).toHaveLength(0);
    expect(w.rows("payments")).toHaveLength(0);
  });

  it("only a Super Admin may preview or record", async () => {
    const w = world();
    await expect(
      recordPlanPayment(w.supabase, { ...zooriSave, actorId: MEMBER }),
    ).rejects.toMatchObject({
      name: "PermissionError",
    });
    await expect(
      planPaymentPreview(w.supabase, { actorId: MEMBER, organizationId: ZOORI }),
    ).rejects.toMatchObject({ name: "PermissionError" });
    expect(w.rows("payments")).toHaveLength(0);
  });

  it("missing reference, bad dates, unknown method and a future paid-on date are refused", async () => {
    const w = world();
    expect(await recordPlanPayment(w.supabase, { ...zooriSave, reference: " " })).toMatchObject({
      error: expect.any(String),
    });
    expect(await recordPlanPayment(w.supabase, { ...zooriSave, method: "crypto" })).toMatchObject({
      error: expect.any(String),
    });
    expect(
      await recordPlanPayment(w.supabase, { ...zooriSave, periodStart: "2026-11-31" }),
    ).toMatchObject({ error: expect.any(String) });
    expect(
      await recordPlanPayment(w.supabase, { ...zooriSave, paidOn: "2026-11-12" }),
    ).toMatchObject({
      error: expect.stringContaining("future"),
    });
    expect(await recordPlanPayment(w.supabase, { ...zooriSave, amount: 0 })).toMatchObject({
      error: expect.any(String),
    });
    expect(w.rows("payments")).toHaveLength(0);
  });
});

describe("the monthly run afterwards", () => {
  it("nothing on 1 Dec; on 10 Dec it invoices the next period only", async () => {
    const w = world({ org: { billing_day: 1 } });
    await recordPlanPayment(w.supabase, zooriSave);
    expect(w.rows("invoices")).toHaveLength(1);

    vi.setSystemTime(new Date("2026-12-01T01:00:00Z"));
    const dec1 = await runPlanBilling(w.supabase);
    expect(dec1.invoiced).toBe(0);
    expect(w.rows("invoices")).toHaveLength(1);

    vi.setSystemTime(new Date("2026-12-10T01:00:00Z"));
    const dec10 = await runPlanBilling(w.supabase);
    expect(dec10.invoiced).toBe(1);
    const invoices = w.rows("invoices");
    expect(invoices).toHaveLength(2);
    expect(invoices[1]).toMatchObject({
      period_start: "2026-12-10",
      status: "issued",
      total: 4999,
    });
    // The paid period is never invoiced again.
    expect(invoices.filter((i) => i["period_start"] === "2026-11-10")).toHaveLength(1);
  });
});

describe("the sheet", () => {
  it("the card writes nothing itself: only the two Super Admin actions, and it sits in the workspace sheet", async () => {
    const { readFileSync } = await import("node:fs");
    const card = readFileSync("src/components/admin/record-plan-payment.tsx", "utf8");
    expect(card).not.toMatch(/aidwar\.from|\.insert\(|\.update\(/);
    expect([...card.matchAll(/action: "([a-z_]+)"/g)].map((m) => m[1])).toEqual([
      "plan_payment_preview",
      "record_plan_payment",
    ]);
    const sheet = readFileSync("src/components/admin/org-billing-sheet.tsx", "utf8");
    expect(sheet).toMatch(/<RecordPlanPayment\s+organizationId={organizationId}/);
    const route = readFileSync("src/routes/api/admin/billing.ts", "utf8");
    // Behind the route's own Super Admin check, before any action runs.
    expect(route.indexOf("isSuperAdmin(supabase, user.id)")).toBeLessThan(
      route.indexOf('case "record_plan_payment"'),
    );
  });
});
