import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 55 — no GST until AiDwar is GST-registered. No live database,
 * Cashfree, Razorpay, WhatsApp or Meta: the database is the in-memory one,
 * Cashfree is a fake on fetch, Razorpay a mock.
 *
 *   gst_registered false (the default): plan, credit pack, top-up and gateway
 *   amounts are the base price; a new invoice is kind "invoice" ("INVOICE"),
 *   no CGST/SGST/IGST, total = taxable value, no GSTIN, no demo footer, the
 *   not-registered line; the copy says no GST.
 *   gst_registered true: today's figures exactly (pinned below).
 *   Super Admin refuses true with an empty or demo GSTIN; "Re-issue without
 *   GST" = credit note + new no-GST invoice + the GST back to the wallet.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  createPaymentLink: vi.fn(),
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

import { withGst } from "./billing";
import {
  DEMO_SUPPLIER_GSTIN,
  DEMO_SUPPLIER_PAN,
  NOT_REGISTERED_LINE,
  chargeFor,
  gstSwitchBlock,
  isRealGstin,
  isRealPan,
  stripDemoFooter,
} from "./gst-mode";
import { loadGstRegistered, priceNow, saveGstSettings } from "./gst-mode.server";
import { buildInvoice, checkInvoiceIssuable, issueInvoice, loadSupplier } from "./invoices.server";
import { planCreditNote } from "./credit-notes.server";
import { renderInvoicePdf } from "./invoice-pdf.server";
import { listGstInvoices, reissueWithoutGst, REISSUE_REASON } from "./gst-reissue.server";
import { startPlanPurchase } from "./plan-purchase.server";
import { invoicePlanFee } from "./plan-billing.server";

const ORG = "org-55";
const OWNER = "user-owner";
const REAL_GSTIN = "36ABCDE1234F1Z5";

function world(settings: Row = {}, extra: Record<string, Row[]> = {}, flag = false): MemoryDb {
  let seq = 0;
  const db = memoryDb(
    {
      platform_settings: [
        {
          id: true,
          supplier_legal_name: "Meezoy Ventures Private Limited",
          supplier_brand_name: "AiDwar",
          supplier_state_code: "36",
          supplier_gstin: DEMO_SUPPLIER_GSTIN,
          supplier_pan: DEMO_SUPPLIER_PAN,
          supplier_address: { line1: "3-3-303, Subric Street", city: "Secunderabad" },
          invoice_series: "AD",
          invoice_footer: `Thank you. [DEMO GSTIN ${DEMO_SUPPLIER_GSTIN} — replace before go-live] Questions: support@aidwar.in`,
          ...settings,
        },
      ],
      organizations: [
        {
          id: ORG,
          name: "ZOORI Jewels",
          billing_account_id: "ba-1",
          plan_status: "trial",
          plan_version_id: "pv-1",
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
              id: "pv-1",
              price_monthly: 2499,
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
        { id: "pv-1", price_monthly: 2499, price_annual: null, plans: { name: "Growth" } },
      ],
      profiles: [
        { id: OWNER, email: "asha@zoori.test", full_name: "Asha Rao", phone: "+919876543210" },
      ],
      wallet_balances: [{ organization_id: ORG, balance: 0 }],
      wallet_ledger: [],
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
      wallet_apply: (a, d) => {
        const id = `ledger-${d.rows("wallet_ledger").length + 1}`;
        d.rows("wallet_ledger").push({
          id,
          organization_id: a["p_org"],
          entry_type: a["p_type"],
          amount: a["p_amount"],
          reference_type: a["p_ref_type"],
          reference_id: a["p_ref_id"],
          metadata: a["p_metadata"],
        });
        const wallet = d.rows("wallet_balances").find((w) => w["organization_id"] === a["p_org"])!;
        wallet["balance"] = Number(wallet["balance"]) + Number(a["p_amount"]);
        return { data: id, error: null };
      },
    },
  );
  h.db = { supabase: db.supabase };
  return db;
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

beforeEach(() => {
  h.createPaymentLink.mockReset();
  h.createPaymentLink.mockResolvedValue({
    link: { id: "plink_1", short_url: "https://rzp.io/i/abc", raw: { id: "plink_1" } },
    error: null,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the price: base exactly while not registered, withGst() exactly once registered", () => {
  it("₹2,499 plan → ₹2,499; ₹2,000 credits → ₹2,000; nothing added", () => {
    expect(chargeFor(2499, false)).toEqual({ base: 2499, gst: 0, total: 2499 });
    expect(chargeFor(2000, false)).toEqual({ base: 2000, gst: 0, total: 2000 });
    expect(chargeFor(200, false)).toEqual({ base: 200, gst: 0, total: 200 });
  });

  it("registered: the same figures as before Batch 55, to the paisa", () => {
    for (const base of [200, 999, 2000, 2499, 4999, 5899.99, 0.05, 1234.56]) {
      expect(chargeFor(base, true)).toEqual(withGst(base));
    }
    expect(chargeFor(2499, true)).toEqual({ base: 2499, gst: 449.82, total: 2948.82 });
    expect(chargeFor(200, true)).toEqual({ base: 200, gst: 36, total: 236 });
  });

  it("only an explicit true is registered: no row, no column or a failed read never adds GST", async () => {
    expect(await loadGstRegistered(world().supabase)).toBe(false);
    expect(
      await loadGstRegistered(world({ gst_registered: true, supplier_gstin: REAL_GSTIN }).supabase),
    ).toBe(true);
    expect(await loadGstRegistered(memoryDb().supabase)).toBe(false);
    const failing = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "x" } }) }),
        }),
      }),
    } as unknown as Parameters<typeof loadGstRegistered>[0];
    expect(await loadGstRegistered(failing)).toBeNull();
    expect(await priceNow(failing, 2000)).toEqual({ error: expect.any(String) });
  });
});

describe("plan purchase and the monthly plan fee: no GST while not registered", () => {
  it("Razorpay: choosing the ₹2,499 plan asks for ₹2,499, and the payment carries GST 0", async () => {
    const db = world();
    const out = await startPlanPurchase(db.supabase, {
      organizationId: ORG,
      userId: OWNER,
      planKey: "growth",
    });
    expect(out).toMatchObject({ url: "https://rzp.io/i/abc" });
    expect(h.createPaymentLink.mock.calls[0]![1]).toMatchObject({
      amount: 2499,
      description: "AiDwar Growth plan — first month",
    });
    expect(db.rows("payments")[0]).toMatchObject({ amount: 2499, purpose: "plan_fee" });
    expect(db.rows("payments")[0]!["raw"]).toMatchObject({
      gst_rate: 0,
      gst_amount: 0,
      gross_amount: 2499,
    });
  });

  it("Razorpay, registered: today's ₹2,948.82 and its wording", async () => {
    const db = world({ gst_registered: true, supplier_gstin: REAL_GSTIN });
    await startPlanPurchase(db.supabase, { organizationId: ORG, userId: OWNER, planKey: "growth" });
    expect(h.createPaymentLink.mock.calls[0]![1]).toMatchObject({
      amount: 2948.82,
      description: "AiDwar Growth plan — first month (incl. 18% GST)",
    });
    expect(db.rows("payments")[0]!["raw"]).toMatchObject({
      gst_rate: 0.18,
      gst_amount: 449.82,
      gross_amount: 2948.82,
    });
  });

  it("Cashfree: the first month is a ₹2,499 order", async () => {
    vi.stubEnv("CASHFREE_CLIENT_ID", "TEST-not-a-real-client-id");
    vi.stubEnv("CASHFREE_CLIENT_SECRET", "cfsk_ma_test_not_real");
    vi.stubEnv("CASHFREE_ENV", "sandbox");
    const orders: Row[] = [];
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
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
    const db = world({}, {}, true);
    const out = await startPlanPurchase(db.supabase, {
      organizationId: ORG,
      userId: OWNER,
      planKey: "growth",
      billingWhatsapp: "+91 98765 43210",
    });
    expect(out).toMatchObject({ payment_id: expect.any(String) });
    expect(orders[0]).toMatchObject({ order_amount: 2499, order_currency: "INR" });
  });

  it("the monthly plan-fee run: an 'invoice' of ₹2,499 with no GST, and a ₹2,499 payment link", async () => {
    const db = world({ supplier_gstin: null, supplier_pan: null });
    const out = await invoicePlanFee(db.supabase, ORG, { start: "2026-11-01", end: "2026-12-01" });
    expect(out).toMatchObject({ pay_url: "https://rzp.io/i/abc" });
    const invoice = db.rows("invoices")[0]!;
    expect(invoice).toMatchObject({
      kind: "invoice",
      taxable_value: 2499,
      cgst: 0,
      sgst: 0,
      igst: 0,
      total: 2499,
    });
    expect(h.createPaymentLink.mock.calls[0]![1]).toMatchObject({ amount: 2499 });
    expect(db.rows("payments")[0]!["raw"]).toMatchObject({ gst_amount: 0, gross_amount: 2499 });
  });
});

describe("invoices while not registered", () => {
  const line = {
    line_type: "credits" as const,
    description: "Prepaid messaging credits",
    sac_code: "998415",
    unit_price: 200,
  };

  it("a sale asked for as a tax invoice is built as kind 'invoice': no GST, total = taxable value", async () => {
    const db = world();
    const built = await buildInvoice(db.supabase, ORG, {
      kind: "tax_invoice",
      purpose: "credit_purchase",
      lines: [line],
    });
    expect(built).toEqual({ invoice_id: expect.any(String) });
    expect(db.rows("invoices")[0]).toMatchObject({
      kind: "invoice",
      series: "AD",
      taxable_value: 200,
      cgst: 0,
      sgst: 0,
      igst: 0,
      total: 200,
    });
    expect(db.rows("invoice_lines")[0]).toMatchObject({ tax_rate: 0, amount: 200 });
  });

  it("it is issued in the same AD series without any supplier GSTIN; a GST tax invoice is refused", async () => {
    const db = world({ supplier_gstin: null, supplier_pan: null });
    const built = (await buildInvoice(db.supabase, ORG, {
      kind: "tax_invoice",
      purpose: "credit_purchase",
      lines: [line],
    })) as { invoice_id: string };
    const issued = await issueInvoice(db.supabase, built.invoice_id, { deliver: false });
    expect(issued).toMatchObject({ invoice_number: "AD/2026-27/00001" });

    db.rows("invoices").push({
      id: "old-draft",
      kind: "tax_invoice",
      status: "draft",
      taxable_value: 200,
      cgst: 18,
      sgst: 18,
      igst: 0,
      total: 236,
      place_of_supply: "36",
      supplier_state_code: "36",
    });
    db.rows("invoice_lines").push({
      invoice_id: "old-draft",
      line_no: 1,
      amount: 200,
      metadata: {},
    });
    expect(await issueInvoice(db.supabase, "old-draft", { deliver: false })).toEqual({
      error: expect.stringContaining("not GST-registered"),
    });
  });

  it("the issue check wants zero tax on an 'invoice'", () => {
    const lines = [{ amount: 200, metadata: {} }];
    const base = {
      kind: "invoice",
      taxable_value: 200,
      total: 200,
      place_of_supply: "36",
      supplier_state_code: "36",
    };
    expect(checkInvoiceIssuable({ ...base, cgst: 0, sgst: 0, igst: 0 }, lines)).toBeNull();
    expect(
      checkInvoiceIssuable({ ...base, cgst: 18, sgst: 18, igst: 0, total: 236 }, lines),
    ).toMatch(/no CGST/);
  });

  it("the demo GSTIN, PAN and footer text are never used", async () => {
    const supplier = await loadSupplier(world().supabase);
    expect(supplier.gstin).toBeNull();
    expect(supplier.pan).toBeNull();
    expect(supplier.invoice_footer).toBe("Thank you. Questions: support@aidwar.in");
    expect(supplier.gst_registered).toBe(false);
    expect(isRealGstin(DEMO_SUPPLIER_GSTIN)).toBe(false);
    expect(isRealPan(DEMO_SUPPLIER_PAN)).toBe(false);
    expect(stripDemoFooter("[DEMO GSTIN 36AAACM0000D1Z5]")).toBeNull();
  });

  it("the PDF: titled INVOICE, no GSTIN, no CGST/SGST, no SAC, the not-registered line, no demo footer", async () => {
    const db = world({ supplier_pan: "AAACM1234D" });
    const supplier = await loadSupplier(db.supabase);
    const text = pdfText(
      await renderInvoicePdf({
        supplier,
        invoice: {
          kind: "invoice",
          invoice_number: "AD/2026-27/00012",
          issue_date: "2026-10-30",
          status: "paid",
          place_of_supply: "36",
          taxable_value: 200,
          cgst: 0,
          sgst: 0,
          igst: 0,
          total: 200,
          buyer_snapshot: { name: "ZOORI Jewels" },
        },
        lines: [
          {
            description: "Prepaid messaging credits",
            sac_code: "998415",
            quantity: 1,
            unit_price: 200,
            amount: 200,
            metadata: {},
          },
        ],
      }),
    );
    expect(text).toContain("INVOICE");
    expect(text).not.toContain("TAX INVOICE");
    expect(text).not.toMatch(/GSTIN|CGST|SGST|IGST|SAC|998415|DEMO/);
    expect(text).toContain(NOT_REGISTERED_LINE);
    expect(text).toContain("PAN: AAACM1234D");
    expect(text).toContain("Subtotal");
    expect(text).toContain("Rupees Two Hundred Only");
    expect(text).toContain("Thank you. Questions: support@aidwar.in");
  });

  it("the PDF of a registered tax invoice still shows the real GSTIN and CGST/SGST", async () => {
    const supplier = await loadSupplier(
      world({ gst_registered: true, supplier_gstin: REAL_GSTIN }).supabase,
    );
    const text = pdfText(
      await renderInvoicePdf({
        supplier,
        invoice: {
          kind: "tax_invoice",
          invoice_number: "AD/2027-28/00001",
          taxable_value: 200,
          cgst: 18,
          sgst: 18,
          igst: 0,
          total: 236,
          buyer_snapshot: {},
        },
        lines: [
          {
            description: "Credits",
            sac_code: "998415",
            quantity: 1,
            unit_price: 200,
            amount: 200,
            metadata: {},
          },
        ],
      }),
    );
    expect(text).toContain("TAX INVOICE");
    expect(text).toContain(`GSTIN: ${REAL_GSTIN}`);
    expect(text).toContain("CGST 9%");
    expect(text).toContain("998415");
    expect(text).not.toContain(NOT_REGISTERED_LINE);
  });

  it("a credit note against an 'invoice' carries no GST", () => {
    const invoice = { kind: "invoice", total: 200, taxable_value: 200, cgst: 0, sgst: 0, igst: 0 };
    expect(planCreditNote(invoice, [], 50)).toEqual({
      taxable: 50,
      cgst: 0,
      sgst: 0,
      igst: 0,
      rate: 0,
    });
    expect(planCreditNote(invoice, [], 200)).toEqual({
      taxable: 200,
      cgst: 0,
      sgst: 0,
      igst: 0,
      rate: 0,
    });
  });
});

describe("registered: buildInvoice is today's, byte for byte", () => {
  const strip = (row: Row) => {
    const {
      id: _id,
      created_at: _c,
      updated_at: _u,
      issue_date: _d,
      invoice_id: _i,
      ...rest
    } = row;
    return rest;
  };
  it("intra-state and inter-state tax invoices", async () => {
    const db = world({ gst_registered: true, supplier_gstin: REAL_GSTIN });
    await buildInvoice(db.supabase, ORG, {
      kind: "tax_invoice",
      purpose: "credit_purchase",
      payment_id: "pay-1",
      lines: [
        {
          line_type: "credits",
          description: "Prepaid messaging credits — Starter",
          sac_code: "998415",
          unit_price: 200,
        },
      ],
    });
    db.rows("billing_accounts")[0]!["state_code"] = "27";
    await buildInvoice(db.supabase, ORG, {
      kind: "tax_invoice",
      purpose: "plan_fee",
      period: { start: "2026-11-01", end: "2026-12-01" },
      lines: [
        { line_type: "plan", description: "Growth plan", sac_code: "998315", unit_price: 2499 },
      ],
    });
    expect(db.rows("invoices").map(strip)).toMatchInlineSnapshot(`
      [
        {
          "billing_account_id": "ba-1",
          "buyer_snapshot": {
            "address": {},
            "billing_email": "accounts@zoori.test",
            "billing_whatsapp": "+919876543210",
            "country_code": "IN",
            "gstin": null,
            "legal_name": null,
            "name": "ZOORI Jewels",
            "state_code": "36",
          },
          "cgst": 18,
          "created_by": null,
          "currency": "INR",
          "discount": 0,
          "igst": 0,
          "is_export": false,
          "is_interstate": false,
          "kind": "tax_invoice",
          "notes": null,
          "organization_id": "org-55",
          "payment_id": "pay-1",
          "period_end": null,
          "period_start": null,
          "place_of_supply": "36",
          "purpose": "credit_purchase",
          "related_invoice_id": null,
          "roi_snapshot": null,
          "series": "AD",
          "sgst": 18,
          "status": "draft",
          "subtotal": 200,
          "supplier_state_code": "36",
          "taxable_value": 200,
          "tds_expected": 0,
          "total": 236,
        },
        {
          "billing_account_id": "ba-1",
          "buyer_snapshot": {
            "address": {},
            "billing_email": "accounts@zoori.test",
            "billing_whatsapp": "+919876543210",
            "country_code": "IN",
            "gstin": null,
            "legal_name": null,
            "name": "ZOORI Jewels",
            "state_code": "27",
          },
          "cgst": 0,
          "created_by": null,
          "currency": "INR",
          "discount": 0,
          "igst": 449.82,
          "is_export": false,
          "is_interstate": true,
          "kind": "tax_invoice",
          "notes": null,
          "organization_id": "org-55",
          "payment_id": null,
          "period_end": "2026-12-01",
          "period_start": "2026-11-01",
          "place_of_supply": "27",
          "purpose": "plan_fee",
          "related_invoice_id": null,
          "roi_snapshot": null,
          "series": "AD",
          "sgst": 0,
          "status": "draft",
          "subtotal": 2499,
          "supplier_state_code": "36",
          "taxable_value": 2499,
          "tds_expected": 0,
          "total": 2948.82,
        },
      ]
    `);
    expect(db.rows("invoice_lines").map(strip)).toMatchInlineSnapshot(`
      [
        {
          "amount": 200,
          "description": "Prepaid messaging credits — Starter",
          "line_no": 1,
          "line_type": "credits",
          "metadata": {},
          "quantity": 1,
          "sac_code": "998415",
          "tax_rate": 18,
          "unit": null,
          "unit_price": 200,
        },
        {
          "amount": 2499,
          "description": "Growth plan",
          "line_no": 1,
          "line_type": "plan",
          "metadata": {},
          "quantity": 1,
          "sac_code": "998315",
          "tax_rate": 18,
          "unit": null,
          "unit_price": 2499,
        },
      ]
    `);
  });
});

describe("Super Admin: the GST switch", () => {
  it("refuses to switch GST on with an empty, demo or malformed GSTIN", async () => {
    for (const gstin of [null, "", DEMO_SUPPLIER_GSTIN, "36ABC"]) {
      expect(gstSwitchBlock(gstin)).not.toBeNull();
    }
    expect(gstSwitchBlock(REAL_GSTIN)).toBeNull();

    const db = world({ gst_registered: false, supplier_gstin: null, supplier_pan: null });
    expect(
      await saveGstSettings(db.supabase, {
        gstRegistered: true,
        supplierGstin: null,
        supplierPan: null,
      }),
    ).toEqual({
      error: expect.stringContaining("real GSTIN"),
    });
    expect(
      await saveGstSettings(db.supabase, {
        gstRegistered: true,
        supplierGstin: DEMO_SUPPLIER_GSTIN,
        supplierPan: null,
      }),
    ).toEqual({ error: expect.stringContaining("demo GSTIN") });
    expect(db.rows("platform_settings")[0]).toMatchObject({
      gst_registered: false,
      supplier_gstin: null,
    });
  });

  it("switches on with a real GSTIN, and reports before and after for the audit log", async () => {
    const db = world({ gst_registered: false, supplier_gstin: null, supplier_pan: null });
    const out = await saveGstSettings(db.supabase, {
      gstRegistered: true,
      supplierGstin: REAL_GSTIN,
      supplierPan: "aaacm1234d",
    });
    expect(out).toMatchObject({
      before: { gst_registered: false, supplier_gstin: null },
      after: { gst_registered: true, supplier_gstin: REAL_GSTIN, supplier_pan: "AAACM1234D" },
    });
  });

  it("before 20261290 (no column) GST can't be switched on", async () => {
    const db = world({ supplier_gstin: null, supplier_pan: null });
    delete db.rows("platform_settings")[0]!["gst_registered"];
    expect(
      await saveGstSettings(db.supabase, {
        gstRegistered: true,
        supplierGstin: REAL_GSTIN,
        supplierPan: null,
      }),
    ).toEqual({
      error: expect.stringContaining("20261290"),
    });
  });
});

describe("Re-issue without GST", () => {
  /** AD/2026-27/00011 as it went out: ₹200 + ₹36 GST = ₹236, paid. */
  function paidGstInvoice(db: MemoryDb) {
    db.rows("payments").push({
      id: "pay-11",
      organization_id: ORG,
      purpose: "credit_purchase",
      status: "paid",
      amount: 200,
      raw: { gross_amount: 236, gst_amount: 36 },
    });
    db.rows("invoices").push({
      id: "inv-11",
      organization_id: ORG,
      billing_account_id: "ba-1",
      invoice_number: "AD/2026-27/00011",
      kind: "tax_invoice",
      purpose: "credit_purchase",
      status: "paid",
      payment_id: "pay-11",
      issue_date: "2026-10-12",
      place_of_supply: "36",
      supplier_state_code: "36",
      is_interstate: false,
      is_export: false,
      taxable_value: 200,
      cgst: 18,
      sgst: 18,
      igst: 0,
      total: 236,
      amount_paid: 236,
      created_at: "2026-10-12T10:00:00Z",
    });
    db.rows("invoice_lines").push({
      invoice_id: "inv-11",
      line_no: 1,
      line_type: "credits",
      description: "Prepaid messaging credits — Starter",
      sac_code: "998415",
      quantity: 1,
      unit_price: 200,
      amount: 200,
      tax_rate: 18,
      metadata: { pack_id: "pack-1" },
    });
  }

  it("lists which invoices qualify; runs nothing on its own", async () => {
    const db = world({ supplier_gstin: null, supplier_pan: null });
    paidGstInvoice(db);
    const rows = await listGstInvoices(db.supabase);
    expect(rows).toEqual([
      expect.objectContaining({
        invoice_number: "AD/2026-27/00011",
        gst: 36,
        taxable_value: 200,
        total: 236,
        blocked: null,
      }),
    ]);
    expect(db.rows("credit_notes")).toHaveLength(0);
    expect(db.rows("wallet_ledger")).toHaveLength(0);
  });

  it("credit note for ₹236 + a ₹200 no-GST invoice, paid + ₹36 back to the wallet; a second click changes nothing", async () => {
    const db = world({ supplier_gstin: null, supplier_pan: null });
    paidGstInvoice(db);
    expect(
      await reissueWithoutGst(db.supabase, {
        invoiceId: "inv-11",
        actorId: "admin",
        confirmed: false,
      }),
    ).toEqual({
      error: "Confirm the re-issue first.",
    });
    const out = await reissueWithoutGst(db.supabase, {
      invoiceId: "inv-11",
      actorId: "admin",
      confirmed: true,
    });
    expect(out).toMatchObject({
      original: "AD/2026-27/00011",
      credit_note: "CN/2026-27/00001",
      invoice_number: "AD/2026-27/00002",
      wallet_credit: 36,
    });

    const notes = db.rows("credit_notes");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      invoice_id: "inv-11",
      amount: 236,
      taxable_value: 200,
      cgst: 18,
      sgst: 18,
      reason: REISSUE_REASON,
      refund_mode: "none",
    });

    const fresh = db.rows("invoices").find((i) => i["related_invoice_id"] === "inv-11")!;
    expect(fresh).toMatchObject({
      kind: "invoice",
      purpose: "credit_purchase",
      payment_id: "pay-11",
      taxable_value: 200,
      cgst: 0,
      sgst: 0,
      igst: 0,
      total: 200,
      amount_paid: 200,
      status: "paid",
    });

    const ledger = db.rows("wallet_ledger");
    expect(ledger).toEqual([
      expect.objectContaining({
        entry_type: "credit_note",
        amount: 36,
        reference_type: "credit_note",
        reference_id: notes[0]!["id"],
      }),
    ]);
    expect(db.rows("wallet_balances")[0]!["balance"]).toBe(36);
    expect(db.rows("activity_log").map((a) => a["action"])).toContain(
      "invoice_reissued_without_gst",
    );

    // Again: refused, and nothing doubles.
    expect(
      await reissueWithoutGst(db.supabase, {
        invoiceId: "inv-11",
        actorId: "admin",
        confirmed: true,
      }),
    ).toMatchObject({});
    expect(db.rows("credit_notes")).toHaveLength(1);
    expect(db.rows("invoices").filter((i) => i["related_invoice_id"] === "inv-11")).toHaveLength(1);
    expect(db.rows("wallet_ledger")).toHaveLength(1);
    expect((await listGstInvoices(db.supabase))[0]!.blocked).toMatch(
      /Already re-issued as AD\/2026-27\/00002/,
    );
  });

  it("refused when the invoice isn't paid, already has a credit note, or GST is on", async () => {
    const unpaid = world({ supplier_gstin: null });
    paidGstInvoice(unpaid);
    Object.assign(unpaid.rows("invoices")[0]!, { status: "issued", amount_paid: 0 });
    expect(
      await reissueWithoutGst(unpaid.supabase, {
        invoiceId: "inv-11",
        actorId: "a",
        confirmed: true,
      }),
    ).toEqual({
      error: expect.stringContaining("Not paid in full"),
    });

    const credited = world({ supplier_gstin: null });
    paidGstInvoice(credited);
    credited
      .rows("credit_notes")
      .push({ invoice_id: "inv-11", status: "issued", reason: "Refund — duplicate", amount: 50 });
    expect(
      await reissueWithoutGst(credited.supabase, {
        invoiceId: "inv-11",
        actorId: "a",
        confirmed: true,
      }),
    ).toEqual({
      error: expect.stringContaining("already has a credit note"),
    });

    const registered = world({ gst_registered: true, supplier_gstin: REAL_GSTIN });
    paidGstInvoice(registered);
    expect(
      await reissueWithoutGst(registered.supabase, {
        invoiceId: "inv-11",
        actorId: "a",
        confirmed: true,
      }),
    ).toEqual({
      error: expect.stringContaining("GST-registered"),
    });
    expect(registered.rows("credit_notes")).toHaveLength(0);
  });
});
