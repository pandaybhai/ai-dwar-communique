import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { SupplierProfile } from "@/lib/invoices.server";

/**
 * A4 tax invoice, drawn by hand with pdf-lib so it runs anywhere the server
 * runs. Brand green on a white page, one line table, one tax summary.
 */

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 42;
const INK = rgb(0.07, 0.09, 0.11);
const MUTED = rgb(0.42, 0.45, 0.5);
const BRAND = rgb(0.063, 0.725, 0.506); // #10B981
const RULE = rgb(0.87, 0.89, 0.91);

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen",
  "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n] ?? "";
  const t = TENS[Math.floor(n / 10)] ?? "";
  const o = ONES[n % 10] ?? "";
  return o ? `${t} ${o}` : t;
}

/** Indian numbering: crore, lakh, thousand, hundred. */
function wordsBelowCrore(n: number): string {
  const parts: string[] = [];
  const lakh = Math.floor(n / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred) parts.push(`${ONES[hundred]} Hundred`);
  if (rest) parts.push(twoDigits(rest));
  return parts.join(" ");
}

export function amountInWords(value: number): string {
  const negative = value < 0;
  const abs = Math.abs(Math.round(value * 100) / 100);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);

  let words = "";
  const crore = Math.floor(rupees / 10000000);
  const rest = rupees % 10000000;
  if (crore) words += `${wordsBelowCrore(crore)} Crore `;
  words += wordsBelowCrore(rest);
  if (!words.trim()) words = "Zero";

  let out = `${negative ? "Minus " : ""}Rupees ${words.trim()}`;
  if (paise > 0) out += ` and ${twoDigits(paise)} Paise`;
  return `${out} Only`;
}

function inr(value: number): string {
  const negative = value < 0;
  const abs = Math.abs(Number(value ?? 0)).toFixed(2);
  const [whole = "0", frac = "00"] = abs.split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  return `${negative ? "-" : ""}Rs. ${grouped}.${frac}`;
}

function addressLines(address: Record<string, unknown>): string[] {
  const keys = ["line1", "line2", "city", "state", "postal_code", "country"];
  return keys
    .map((k) => address[k])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

type Ctx = { page: PDFPage; font: PDFFont; bold: PDFFont };

function text(
  ctx: Ctx,
  value: string,
  x: number,
  y: number,
  opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; align?: "left" | "right" } = {},
) {
  const size = opts.size ?? 9;
  const font = opts.bold ? ctx.bold : ctx.font;
  const clean = value.replace(/[^\x20-\x7E]/g, "");
  const width = font.widthOfTextAtSize(clean, size);
  ctx.page.drawText(clean, {
    x: opts.align === "right" ? x - width : x,
    y,
    size,
    font,
    color: opts.color ?? INK,
  });
}

function rule(ctx: Ctx, y: number, x = MARGIN, width = A4[0] - MARGIN * 2) {
  ctx.page.drawRectangle({ x, y, width, height: 0.7, color: RULE });
}

export type InvoicePdfInput = {
  supplier: SupplierProfile;
  invoice: Record<string, unknown>;
  lines: Record<string, unknown>[];
};

export async function renderInvoicePdf(input: InvoicePdfInput): Promise<Uint8Array> {
  const { supplier, invoice, lines } = input;
  const doc = await PDFDocument.create();
  const page = doc.addPage(A4);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = { page, font, bold };
  const right = A4[0] - MARGIN;

  const kind = String(invoice["kind"] ?? "tax_invoice");
  const title =
    kind === "proforma" ? "PROFORMA INVOICE" : kind === "credit_note" ? "CREDIT NOTE" : "TAX INVOICE";

  let y = A4[1] - MARGIN;

  // Brand bar
  page.drawRectangle({ x: 0, y: y + 12, width: A4[0], height: 6, color: BRAND });

  text(ctx, supplier.brand_name, MARGIN, y - 8, { size: 20, bold: true });
  text(ctx, title, right, y - 8, { size: 16, bold: true, align: "right", color: BRAND });
  y -= 26;

  text(ctx, supplier.legal_name, MARGIN, y, { size: 9, color: MUTED });
  text(ctx, String(invoice["invoice_number"] ?? "DRAFT"), right, y, {
    size: 10,
    bold: true,
    align: "right",
  });
  y -= 12;

  for (const line of addressLines(supplier.address)) {
    text(ctx, line, MARGIN, y, { size: 8.5, color: MUTED });
    y -= 10;
  }
  const supplierMeta = [
    supplier.gstin ? `GSTIN: ${supplier.gstin}` : null,
    supplier.pan ? `PAN: ${supplier.pan}` : null,
    supplier.email,
    supplier.website,
  ].filter(Boolean) as string[];
  for (const line of supplierMeta) {
    text(ctx, line, MARGIN, y, { size: 8.5, color: MUTED });
    y -= 10;
  }

  // Dates block, right aligned against the header
  let dy = A4[1] - MARGIN - 50;
  const dates: [string, string][] = [
    ["Issue date", String(invoice["issue_date"] ?? "")],
    ["Due date", String(invoice["due_date"] ?? "-")],
  ];
  if (invoice["period_start"] && invoice["period_end"]) {
    dates.push(["Period", `${String(invoice["period_start"])} to ${String(invoice["period_end"])}`]);
  }
  for (const [label, value] of dates) {
    text(ctx, `${label}: ${value}`, right, dy, { size: 8.5, align: "right", color: MUTED });
    dy -= 11;
  }

  y = Math.min(y, dy) - 12;
  rule(ctx, y);
  y -= 18;

  // Buyer
  const buyer = (invoice["buyer_snapshot"] ?? {}) as Record<string, unknown>;
  text(ctx, "BILL TO", MARGIN, y, { size: 8, bold: true, color: MUTED });
  text(ctx, `Place of supply: ${String(invoice["place_of_supply"] ?? "-")}`, right, y, {
    size: 8.5,
    align: "right",
    color: MUTED,
  });
  y -= 14;
  text(ctx, String(buyer["legal_name"] ?? buyer["name"] ?? "-"), MARGIN, y, {
    size: 11,
    bold: true,
  });
  y -= 12;
  for (const line of addressLines((buyer["address"] ?? {}) as Record<string, unknown>)) {
    text(ctx, line, MARGIN, y, { size: 8.5, color: MUTED });
    y -= 10;
  }
  if (buyer["gstin"]) {
    text(ctx, `GSTIN: ${String(buyer["gstin"])}`, MARGIN, y, { size: 8.5, color: MUTED });
    y -= 10;
  }
  if (buyer["billing_email"]) {
    text(ctx, String(buyer["billing_email"]), MARGIN, y, { size: 8.5, color: MUTED });
    y -= 10;
  }

  y -= 10;

  // Line table
  const cols = { desc: MARGIN, sac: 300, qty: 360, price: 440, amount: right };
  page.drawRectangle({
    x: MARGIN,
    y: y - 4,
    width: A4[0] - MARGIN * 2,
    height: 18,
    color: rgb(0.96, 0.98, 0.97),
  });
  text(ctx, "Description", cols.desc + 4, y + 2, { size: 8, bold: true, color: MUTED });
  text(ctx, "SAC", cols.sac, y + 2, { size: 8, bold: true, color: MUTED });
  text(ctx, "Qty", cols.qty, y + 2, { size: 8, bold: true, color: MUTED });
  text(ctx, "Unit price", cols.price, y + 2, { size: 8, bold: true, color: MUTED });
  text(ctx, "Amount", cols.amount - 4, y + 2, { size: 8, bold: true, color: MUTED, align: "right" });
  y -= 20;

  for (const line of lines) {
    const informational =
      ((line["metadata"] ?? {}) as Record<string, unknown>)["informational"] === true;
    const description = String(line["description"] ?? "");
    const wrapped = wrap(description, font, 8.5, cols.sac - cols.desc - 12);
    for (const [index, part] of wrapped.entries()) {
      text(ctx, part, cols.desc + 4, y, { size: 8.5, color: informational ? MUTED : INK });
      if (index === 0) {
        text(ctx, String(line["sac_code"] ?? "-"), cols.sac, y, { size: 8.5, color: MUTED });
        text(ctx, String(Number(line["quantity"] ?? 1)), cols.qty, y, { size: 8.5, color: MUTED });
        text(ctx, informational ? "-" : inr(Number(line["unit_price"] ?? 0)), cols.price, y, {
          size: 8.5,
          color: MUTED,
        });
        text(ctx, informational ? "-" : inr(Number(line["amount"] ?? 0)), cols.amount - 4, y, {
          size: 8.5,
          align: "right",
          color: informational ? MUTED : INK,
        });
      }
      y -= 11;
    }
    y -= 3;
    rule(ctx, y + 6);
    if (y < 220) break;
  }

  y -= 10;

  // Totals
  const isExport = invoice["is_export"] === true;
  const totals: [string, string][] = [["Taxable value", inr(Number(invoice["taxable_value"] ?? 0))]];
  if (isExport) {
    totals.push(["Tax", "Zero rated (export)"]);
  } else if (invoice["is_interstate"] === true) {
    totals.push(["IGST 18%", inr(Number(invoice["igst"] ?? 0))]);
  } else {
    totals.push(["CGST 9%", inr(Number(invoice["cgst"] ?? 0))]);
    totals.push(["SGST 9%", inr(Number(invoice["sgst"] ?? 0))]);
  }

  for (const [label, value] of totals) {
    text(ctx, label, 430, y, { size: 9, color: MUTED, align: "right" });
    text(ctx, value, right, y, { size: 9, align: "right" });
    y -= 13;
  }
  rule(ctx, y + 6, 330, right - 330);
  y -= 6;
  text(ctx, "Total", 430, y, { size: 11, bold: true, align: "right" });
  text(ctx, inr(Number(invoice["total"] ?? 0)), right, y, { size: 11, bold: true, align: "right" });
  y -= 18;

  text(ctx, amountInWords(Number(invoice["total"] ?? 0)), MARGIN, y, { size: 8.5, bold: true });
  y -= 16;

  const tds = Number(invoice["tds_expected"] ?? 0);
  if (tds !== 0) {
    text(
      ctx,
      `TDS of ${inr(tds)} (2% u/s 194J) may be deducted; please share the certificate.`,
      MARGIN,
      y,
      { size: 8, color: MUTED },
    );
    y -= 11;
  }
  if (isExport) {
    text(ctx, "Export of services under LUT — no IGST charged.", MARGIN, y, {
      size: 8,
      color: MUTED,
    });
    y -= 11;
  }

  const paidRef = ((invoice["sent"] ?? {}) as Record<string, unknown>)["razorpay_ref"];
  if (typeof paidRef === "string" && paidRef) {
    text(ctx, `Paid via Razorpay ref ${paidRef}`, MARGIN, y, { size: 8, color: BRAND });
    y -= 11;
  } else if (String(invoice["status"]) === "paid") {
    text(ctx, "Paid — thank you.", MARGIN, y, { size: 8, color: BRAND });
    y -= 11;
  } else {
    const bank = supplier.bank_details;
    const bankLines = Object.entries(bank)
      .filter(([, v]) => typeof v === "string" && v)
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`);
    if (bankLines.length > 0) {
      y -= 4;
      text(ctx, "BANK TRANSFER", MARGIN, y, { size: 8, bold: true, color: MUTED });
      y -= 11;
      for (const line of bankLines) {
        text(ctx, line, MARGIN, y, { size: 8, color: MUTED });
        y -= 10;
      }
    }
  }

  if (invoice["notes"]) {
    y -= 4;
    for (const part of wrap(String(invoice["notes"]), font, 8, A4[0] - MARGIN * 2)) {
      text(ctx, part, MARGIN, y, { size: 8, color: MUTED });
      y -= 10;
    }
  }

  if (supplier.invoice_footer) {
    for (const part of wrap(supplier.invoice_footer, font, 8, A4[0] - MARGIN * 2)) {
      text(ctx, part, MARGIN, MARGIN + 14, { size: 8, color: MUTED });
      break;
    }
  }
  text(ctx, "This is a computer generated document.", right, MARGIN, {
    size: 7.5,
    color: MUTED,
    align: "right",
  });

  return doc.save();
}

function wrap(value: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const clean = value.replace(/[^\x20-\x7E]/g, "");
  const words = clean.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out.length > 0 ? out : [""];
}
