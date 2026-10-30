/**
 * Batch 55: renders sample invoices with the real renderer (renderInvoicePdf) —
 * the no-GST "Invoice" and, for comparison, the credit note that reverses an
 * old GST tax invoice. Fictional data; no database.
 *
 *   bun scripts/ui-shots/b55-invoice-pdf.ts docs/screenshots/batch55
 *   pdftoppm -png -r 80 docs/screenshots/batch55/invoice-no-gst.pdf docs/screenshots/batch55/invoice-no-gst
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderInvoicePdf } from "../../src/lib/invoice-pdf.server";
import type { SupplierProfile } from "../../src/lib/invoices.server";

const out = process.argv[2] ?? "docs/screenshots/batch55";

const supplier: SupplierProfile = {
  legal_name: "Meezoy Ventures Private Limited",
  brand_name: "AiDwar",
  gstin: null,
  pan: null,
  state_code: "36",
  address: { line1: "3-3-303, Subric Street", city: "Secunderabad", state: "Telangana", postal_code: "500003", country: "India" },
  email: "support@aidwar.in",
  website: "https://aidwar.in",
  logo_url: null,
  invoice_series: "AD",
  invoice_due_days: 7,
  sac_platform: "998315",
  sac_messaging: "998415",
  invoice_footer: "Thank you for choosing AiDwar. Questions: support@aidwar.in",
  bank_details: {},
  dunning_pause_campaigns_days: 10,
  dunning_suspend_days: 30,
  gst_registered: false,
};

const buyer = {
  name: "ZOORI Jewels",
  legal_name: "ZOORI Jewels",
  address: { line1: "Road No. 36, Jubilee Hills", city: "Hyderabad", state: "Telangana", postal_code: "500033" },
  state_code: "36",
  billing_email: "accounts@zoori.example",
};

const invoice = await renderInvoicePdf({
  supplier,
  invoice: {
    kind: "invoice",
    invoice_number: "AD/2026-27/00012",
    issue_date: "2026-10-30",
    due_date: "2026-11-06",
    status: "paid",
    place_of_supply: "36",
    taxable_value: 2000,
    cgst: 0,
    sgst: 0,
    igst: 0,
    total: 2000,
    buyer_snapshot: buyer,
    sent: { payment_ref: "cf_5114910000001", payment_gateway: "Cashfree" },
  },
  lines: [
    { description: "Prepaid messaging credits — Starter", sac_code: "998415", quantity: 1, unit_price: 2000, amount: 2000, metadata: {} },
  ],
});
writeFileSync(join(out, "invoice-no-gst.pdf"), invoice);

const note = await renderInvoicePdf({
  supplier,
  invoice: {
    kind: "credit_note",
    credited_kind: "tax_invoice",
    invoice_number: "CN/2026-27/00001",
    issue_date: "2026-10-30",
    status: "issued",
    place_of_supply: "36",
    taxable_value: 200,
    cgst: 18,
    sgst: 18,
    igst: 0,
    total: 236,
    buyer_snapshot: buyer,
    notes: "Credit note against AD/2026-27/00011 — Re-issued without GST: supplier not registered under GST",
  },
  lines: [
    { description: "Credit against invoice AD/2026-27/00011", sac_code: "998315", quantity: 1, unit_price: 200, amount: 200, metadata: {} },
  ],
});
writeFileSync(join(out, "credit-note-reissue.pdf"), note);
console.log("wrote", out);
