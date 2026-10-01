import { describe, expect, it } from "vitest";
import { gstFromGross, gstOnTaxable, toPaise, withGst } from "@/lib/billing";
import { buildInvoice, checkInvoiceIssuable, paymentGross } from "@/lib/invoices.server";
import { issueCreditNote, planCreditNote } from "@/lib/credit-notes.server";
import { fakeDb, type FakeOp } from "@/lib/test-support/fake-db";

const paise = (...xs: number[]) => xs.reduce((s, x) => s + toPaise(x), 0);

describe("gstOnTaxable — integer paise GST", () => {
  it("intra-state: CGST + SGST equals 18% exactly, odd paisa to CGST", () => {
    // Old code: tax 18.01 → halves round2(9.005) = 9.01 each → 18.02 of tax.
    const g = gstOnTaxable(100.03);
    expect(g).toMatchObject({ taxable: 100.03, cgst: 9.01, sgst: 9, igst: 0, tax: 18.01, total: 118.04 });
    // Old code: 269.91 of tax shown as 134.96 + 134.96 = 269.92.
    const h = gstOnTaxable(1499.5);
    expect(paise(h.cgst, h.sgst)).toBe(26991);
    expect(h.total).toBe(1769.41);
  });

  it("intra-state even split unchanged for whole-rupee bases", () => {
    expect(gstOnTaxable(999)).toMatchObject({ cgst: 89.91, sgst: 89.91, igst: 0, tax: 179.82, total: 1178.82 });
    expect(gstOnTaxable(1000)).toMatchObject({ cgst: 90, sgst: 90, total: 1180 });
  });

  it("inter-state: IGST only at 18%", () => {
    expect(gstOnTaxable(100.03, { isInterstate: true })).toMatchObject({ cgst: 0, sgst: 0, igst: 18.01, total: 118.04 });
  });

  it("export: zero-rated", () => {
    expect(gstOnTaxable(1000, { isExport: true, isInterstate: true })).toMatchObject({
      cgst: 0,
      sgst: 0,
      igst: 0,
      tax: 0,
      total: 1000,
    });
  });

  it("is sign-symmetric for negative (credit) amounts", () => {
    const pos = gstOnTaxable(100.03);
    const neg = gstOnTaxable(-100.03);
    expect(neg).toMatchObject({ taxable: -pos.taxable, cgst: -pos.cgst, sgst: -pos.sgst, total: -pos.total });
  });

  it("rounds an exact half paisa up (half away from zero)", () => {
    // 10.25 × 18% = 1.845
    expect(gstOnTaxable(10.25).tax).toBe(1.85);
  });

  it("withGst agrees with the invoice maths, so collected gross == invoice total", () => {
    for (const base of [999, 1000, 100.03, 1499.5, 10.25, 0.05, 4999.99]) {
      expect(withGst(base).total).toBe(gstOnTaxable(base).total);
      expect(withGst(base).gst).toBe(gstOnTaxable(base).tax);
    }
  });
});

describe("gstFromGross — backing tax out of a GST-inclusive amount", () => {
  it("parts always add back to the gross", () => {
    for (const gross of [1180, 118.04, 0.01, 59.01, 1769.41, 100]) {
      const s = gstFromGross(gross);
      expect(paise(s.taxable, s.cgst, s.sgst)).toBe(toPaise(gross));
    }
  });
  it("1180 → 1000 + 90 + 90; inter-state → IGST 180; export → no tax", () => {
    expect(gstFromGross(1180)).toMatchObject({ taxable: 1000, cgst: 90, sgst: 90, igst: 0 });
    expect(gstFromGross(1180, { isInterstate: true })).toMatchObject({ taxable: 1000, cgst: 0, sgst: 0, igst: 180 });
    expect(gstFromGross(1180, { isExport: true })).toMatchObject({ taxable: 1180, igst: 0, cgst: 0 });
  });
});

describe("checkInvoiceIssuable", () => {
  const line = (amount: number) => ({ amount, metadata: {} });
  const base = { place_of_supply: "27", supplier_state_code: "27" };

  it("accepts the new uneven split and the legacy equal halves", () => {
    expect(
      checkInvoiceIssuable({ ...base, taxable_value: 100.03, cgst: 9.01, sgst: 9, igst: 0, total: 118.04 }, [line(100.03)]),
    ).toBeNull();
    // A draft built before this change (9.01 + 9.01) can still be issued.
    expect(
      checkInvoiceIssuable({ ...base, taxable_value: 100.03, cgst: 9.01, sgst: 9.01, igst: 0, total: 118.05 }, [line(100.03)]),
    ).toBeNull();
  });

  it("still rejects wrong tax heads", () => {
    expect(
      checkInvoiceIssuable({ ...base, taxable_value: 1000, cgst: 0, sgst: 0, igst: 180, total: 1180 }, [line(1000)]),
    ).toMatch(/intra-state/);
    expect(
      checkInvoiceIssuable(
        { ...base, is_interstate: true, taxable_value: 1000, cgst: 90, sgst: 90, igst: 0, total: 1180 },
        [line(1000)],
      ),
    ).toMatch(/inter-state/);
    expect(
      checkInvoiceIssuable({ ...base, taxable_value: 1000, cgst: 80, sgst: 80, igst: 0, total: 1160 }, [line(1000)]),
    ).toMatch(/CGST\/SGST/);
    expect(
      checkInvoiceIssuable(
        { ...base, is_export: true, taxable_value: 1000, cgst: 0, sgst: 0, igst: 180, total: 1180 },
        [line(1000)],
      ),
    ).toMatch(/zero-rated/);
  });
});

describe("buildInvoice — tax heads by place of supply", () => {
  function run(buyer: Record<string, unknown>, unitPrice: number, negate = false) {
    const inserted: Record<string, unknown>[] = [];
    const db = fakeDb((op: FakeOp) => {
      if (op.table === "platform_settings") {
        return { data: { supplier_state_code: "27", supplier_gstin: "27ABCDE1234F1Z5" }, error: null };
      }
      if (op.table === "organizations") return { data: { id: "org", name: "Org", billing_account_id: "acc" }, error: null };
      if (op.table === "billing_accounts") return { data: buyer, error: null };
      if (op.table === "invoices" && op.kind === "insert") {
        inserted.push(op.payload as Record<string, unknown>);
        return { data: { id: "inv1" }, error: null };
      }
      return undefined;
    });
    return buildInvoice(db.supabase, "org", {
      kind: negate ? "credit_note" : "tax_invoice",
      purpose: "credit_purchase",
      lines: [{ line_type: "credits", description: "Credits", unit_price: unitPrice }],
      negate,
    }).then((r) => ({ r, invoice: inserted[0]! }));
  }

  it("same state → CGST + SGST summing to 18%", async () => {
    const { invoice } = await run({ state_code: "27", country_code: "IN" }, 100.03);
    expect(invoice).toMatchObject({ is_interstate: false, place_of_supply: "27", cgst: 9.01, sgst: 9, igst: 0, total: 118.04 });
  });

  it("other state → IGST, place of supply is the buyer's state", async () => {
    const { invoice } = await run({ state_code: "29", country_code: "IN" }, 1000);
    expect(invoice).toMatchObject({ is_interstate: true, place_of_supply: "29", cgst: 0, sgst: 0, igst: 180, total: 1180 });
  });

  it("unknown buyer state → supplier state, intra-state", async () => {
    const { invoice } = await run({ state_code: null, country_code: "IN" }, 1000);
    expect(invoice).toMatchObject({ is_interstate: false, place_of_supply: "27", cgst: 90, sgst: 90 });
  });

  it("foreign buyer → zero-rated export", async () => {
    const { invoice } = await run({ state_code: null, country_code: "US" }, 1000);
    expect(invoice).toMatchObject({ is_export: true, cgst: 0, sgst: 0, igst: 0, total: 1000 });
  });

  it("negated (credit note) invoice mirrors the positive one", async () => {
    const { invoice } = await run({ state_code: "27", country_code: "IN" }, 100.03, true);
    expect(invoice).toMatchObject({ taxable_value: -100.03, cgst: -9.01, sgst: -9, total: -118.04 });
  });
});

describe("paymentGross — what the buyer actually paid", () => {
  it("prefers the gross frozen on the payment", () => {
    expect(paymentGross({ amount: 1000, raw: { gross_amount: 1180 } })).toBe(1180);
    expect(paymentGross({ amount: 1000, raw: { gross: 1180 } })).toBe(1180);
  });
  it("re-derives it from the ex-GST amount otherwise (never returns the base)", () => {
    // Old sweep / void-and-reissue paid 1000 against an 1180 invoice → partially_paid.
    expect(paymentGross({ amount: 1000, raw: {} })).toBe(1180);
    expect(paymentGross({ amount: 0, raw: {} })).toBe(0);
  });
});

describe("planCreditNote", () => {
  const intra = { total: 1180, taxable_value: 1000, cgst: 90, sgst: 90, igst: 0 };
  const inter = { total: 1180, taxable_value: 1000, cgst: 0, sgst: 0, igst: 180, is_interstate: true };

  it("never exceeds the invoice, not even by a paisa", () => {
    // Old check allowed amount + credited <= total + 0.01.
    const prior = [{ amount: 1180, taxable_value: 1000, cgst: 90, sgst: 90, igst: 0 }];
    expect(planCreditNote(intra, prior, 0.01)).toHaveProperty("error");
    expect(planCreditNote(intra, [], 1180.01)).toHaveProperty("error");
    expect(planCreditNote(intra, [], 1180)).not.toHaveProperty("error");
  });

  it("mirrors the invoice's tax treatment", () => {
    expect(planCreditNote(intra, [], 118)).toMatchObject({ taxable: 100, cgst: 9, sgst: 9, igst: 0 });
    expect(planCreditNote(inter, [], 118)).toMatchObject({ taxable: 100, cgst: 0, sgst: 0, igst: 18 });
    expect(
      planCreditNote({ total: 1000, taxable_value: 1000, cgst: 0, sgst: 0, igst: 0, is_export: true }, [], 500),
    ).toMatchObject({ taxable: 500, cgst: 0, sgst: 0, igst: 0, rate: 0 });
  });

  it("the final note reverses exactly what is left of each tax head", () => {
    // ₹100 then ₹1080 against 1000 + 90 + 90. Old code reversed CGST 90.01 / SGST 89.99.
    const first = planCreditNote(intra, [], 100);
    if ("error" in first) throw new Error(first.error);
    expect(first).toMatchObject({ taxable: 84.75, cgst: 7.63, sgst: 7.62 });
    const prior = [{ amount: 100, taxable_value: first.taxable, cgst: first.cgst, sgst: first.sgst, igst: 0 }];
    const last = planCreditNote(intra, prior, 1080);
    if ("error" in last) throw new Error(last.error);
    expect(paise(first.taxable, last.taxable)).toBe(100000);
    expect(paise(first.cgst, last.cgst)).toBe(9000);
    expect(paise(first.sgst, last.sgst)).toBe(9000);
    expect(paise(last.taxable, last.cgst, last.sgst)).toBe(108000);
  });

  it("a single full credit reverses the invoice exactly (legacy equal-halves invoice too)", () => {
    const legacy = { total: 118.05, taxable_value: 100.03, cgst: 9.01, sgst: 9.01, igst: 0 };
    expect(planCreditNote(legacy, [], 118.05)).toMatchObject({ taxable: 100.03, cgst: 9.01, sgst: 9.01 });
  });
});

describe("issueCreditNote — wired through planCreditNote", () => {
  function setup(invoice: Record<string, unknown>, prior: Record<string, unknown>[]) {
    const db = fakeDb(
      (op: FakeOp) => {
        if (op.table === "platform_settings") {
          return { data: { supplier_state_code: "27", supplier_gstin: "27ABCDE1234F1Z5" }, error: null };
        }
        if (op.table === "invoices") return { data: invoice, error: null };
        if (op.table === "credit_notes" && op.kind === "select") return { data: prior, error: null };
        if (op.table === "credit_notes" && op.kind === "insert") return { data: { id: "cn1" }, error: null };
        return undefined;
      },
      (call) => (call.name === "next_invoice_number" ? { data: "CN/2026-27/00001", error: null } : undefined),
    );
    return db;
  }
  const invoice = {
    id: "inv",
    organization_id: "org",
    invoice_number: "AD/2026-27/00001",
    status: "paid",
    kind: "tax_invoice",
    total: 1180,
    taxable_value: 1000,
    cgst: 90,
    sgst: 90,
    igst: 0,
  };

  it("refuses a 1-paisa over-credit without drawing a number", async () => {
    const db = setup(invoice, [{ amount: 1180, taxable_value: 1000, cgst: 90, sgst: 90, igst: 0 }]);
    const r = await issueCreditNote(db.supabase, {
      invoiceId: "inv",
      amount: 0.01,
      reason: "test refund",
      refundToWallet: false,
      actorId: "u",
    });
    expect(r).toHaveProperty("error");
    expect(db.rpcs.find((c) => c.name === "next_invoice_number")).toBeUndefined();
  });

  it("records the split it planned", async () => {
    const db = setup(invoice, []);
    const r = await issueCreditNote(db.supabase, {
      invoiceId: "inv",
      amount: 118,
      reason: "test refund",
      refundToWallet: false,
      actorId: "u",
    });
    expect(r).not.toHaveProperty("error");
    const insert = db.ops.find((o) => o.table === "credit_notes" && o.kind === "insert");
    expect(insert?.payload).toMatchObject({ amount: 118, taxable_value: 100, cgst: 9, sgst: 9, igst: 0 });
  });
});
