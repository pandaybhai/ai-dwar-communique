import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/billing";

/**
 * The invoice engine.
 *
 * Rules that never bend:
 *   - an invoice number is drawn ONLY at the moment of issue, and never twice;
 *   - a draft has no number and no PDF;
 *   - tax is decided by the buyer's state against the supplier's state, and
 *     exports are zero-rated;
 *   - money is rounded to two decimals at every boundary.
 */

export const TAX_RATE = 18;

export type InvoiceKind = "tax_invoice" | "proforma" | "credit_note";
export type InvoicePurpose = "credit_purchase" | "plan_fee" | "usage" | "adjustment";

export type InvoiceLineInput = {
  line_type: "plan" | "credits" | "messaging" | "automation" | "ai" | "addon" | "discount" | "adjustment";
  description: string;
  sac_code?: string | null;
  quantity?: number;
  unit?: string | null;
  unit_price: number;
  /** Informational lines carry no money and no tax. */
  informational?: boolean;
  metadata?: Record<string, unknown>;
};

export type SupplierProfile = {
  legal_name: string;
  brand_name: string;
  gstin: string | null;
  pan: string | null;
  state_code: string | null;
  address: Record<string, unknown>;
  email: string | null;
  website: string | null;
  logo_url: string | null;
  invoice_series: string;
  invoice_due_days: number;
  sac_platform: string;
  sac_messaging: string;
  invoice_footer: string | null;
  bank_details: Record<string, unknown>;
  dunning_pause_campaigns_days: number;
  dunning_suspend_days: number;
};

export async function loadSupplier(supabase: SupabaseClient): Promise<SupplierProfile> {
  const { data } = await supabase.from("platform_settings").select("*").eq("id", true).maybeSingle();
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    legal_name: String(row["supplier_legal_name"] ?? "Meezoy Ventures Private Limited"),
    brand_name: String(row["supplier_brand_name"] ?? "AiDwar"),
    gstin: (row["supplier_gstin"] as string | null) ?? null,
    pan: (row["supplier_pan"] as string | null) ?? null,
    state_code: (row["supplier_state_code"] as string | null) ?? null,
    address: (row["supplier_address"] ?? {}) as Record<string, unknown>,
    email: (row["supplier_email"] as string | null) ?? null,
    website: (row["supplier_website"] as string | null) ?? null,
    logo_url: (row["supplier_logo_url"] as string | null) ?? null,
    invoice_series: String(row["invoice_series"] ?? "AD"),
    invoice_due_days: Number(row["invoice_due_days"] ?? 7),
    sac_platform: String(row["sac_platform"] ?? "998315"),
    sac_messaging: String(row["sac_messaging"] ?? "998415"),
    invoice_footer: (row["invoice_footer"] as string | null) ?? null,
    bank_details: (row["bank_details"] ?? {}) as Record<string, unknown>,
    dunning_pause_campaigns_days: Number(row["dunning_pause_campaigns_days"] ?? 10),
    dunning_suspend_days: Number(row["dunning_suspend_days"] ?? 30),
  };
}

type BuildInput = {
  kind: InvoiceKind;
  purpose: InvoicePurpose;
  lines: InvoiceLineInput[];
  period?: { start: string; end: string } | null;
  payment_id?: string | null;
  related_invoice_id?: string | null;
  series?: string | null;
  notes?: string | null;
  roi_snapshot?: Record<string, unknown> | null;
  created_by?: string | null;
  /** Credit notes carry negative money. */
  negate?: boolean;
};

/** Builds a DRAFT invoice: no number, no PDF, nothing sent. */
export async function buildInvoice(
  supabase: SupabaseClient,
  organizationId: string,
  input: BuildInput,
): Promise<{ invoice_id: string } | { error: string }> {
  const supplier = await loadSupplier(supabase);

  const { data: org } = await supabase
    .from("organizations")
    .select("id, name, billing_account_id")
    .eq("id", organizationId)
    .maybeSingle();
  if (!org) return { error: "That workspace no longer exists." };

  const accountId = (org["billing_account_id"] as string | null) ?? null;
  const { data: account } = accountId
    ? await supabase.from("billing_accounts").select("*").eq("id", accountId).maybeSingle()
    : { data: null };
  const buyer = (account ?? {}) as Record<string, unknown>;

  const buyerState = (buyer["state_code"] as string | null) ?? null;
  const buyerCountry = String(buyer["country_code"] ?? "IN");
  const isExport = buyerCountry !== "IN";
  const isInterstate = !isExport && Boolean(buyerState) && buyerState !== supplier.state_code;

  const buyerSnapshot = {
    name: (buyer["name"] as string | null) ?? (org["name"] as string),
    legal_name: (buyer["legal_name"] as string | null) ?? null,
    gstin: (buyer["gstin"] as string | null) ?? null,
    address: (buyer["address"] ?? {}) as Record<string, unknown>,
    state_code: buyerState,
    country_code: buyerCountry,
    billing_email: (buyer["billing_email"] as string | null) ?? null,
    billing_whatsapp: (buyer["billing_whatsapp"] as string | null) ?? null,
  };

  const sign = input.negate === true ? -1 : 1;
  const taxRate = isExport ? 0 : TAX_RATE;

  let taxable = 0;
  const prepared = input.lines.map((line, index) => {
    const qty = Number(line.quantity ?? 1);
    const unitPrice = round2(Number(line.unit_price ?? 0) * sign);
    const amount = line.informational === true ? 0 : round2(unitPrice * qty);
    const lineTax = line.informational === true ? 0 : taxRate;
    if (line.informational !== true) taxable += amount;
    return {
      line_no: index + 1,
      line_type: line.line_type,
      description: line.description,
      sac_code: line.sac_code ?? null,
      quantity: qty,
      unit: line.unit ?? null,
      unit_price: unitPrice,
      amount,
      tax_rate: lineTax,
      metadata: {
        ...(line.metadata ?? {}),
        ...(line.informational === true ? { informational: true } : {}),
      },
    };
  });

  taxable = round2(taxable);
  const taxTotal = round2((taxable * taxRate) / 100);
  const cgst = isExport || isInterstate ? 0 : round2(taxTotal / 2);
  const sgst = cgst;
  const igst = isInterstate && !isExport ? taxTotal : 0;
  const total = round2(taxable + cgst + sgst + igst);

  const tdsExpected =
    buyer["tds_applicable"] === true ? round2(Math.abs(taxable) * 0.02) * sign : 0;

  const notes =
    input.notes ?? (isExport ? "Export of services under LUT — zero rated." : null);

  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      organization_id: organizationId,
      billing_account_id: accountId,
      series: input.series ?? supplier.invoice_series,
      kind: input.kind,
      purpose: input.purpose,
      status: "draft",
      related_invoice_id: input.related_invoice_id ?? null,
      payment_id: input.payment_id ?? null,
      issue_date: new Date().toISOString().slice(0, 10),
      period_start: input.period?.start ?? null,
      period_end: input.period?.end ?? null,
      place_of_supply: buyerState,
      supplier_state_code: supplier.state_code,
      is_interstate: isInterstate,
      is_export: isExport,
      currency: String(buyer["currency"] ?? "INR"),
      subtotal: taxable,
      discount: 0,
      taxable_value: taxable,
      cgst,
      sgst,
      igst,
      total,
      tds_expected: tdsExpected,
      buyer_snapshot: buyerSnapshot,
      roi_snapshot: input.roi_snapshot ?? null,
      notes,
      created_by: input.created_by ?? null,
    })
    .select("id")
    .maybeSingle();

  if (error || !invoice) return { error: "We couldn't prepare the invoice." };

  await supabase
    .from("invoice_lines")
    .insert(prepared.map((line) => ({ ...line, invoice_id: invoice.id as string })));

  return { invoice_id: invoice.id as string };
}

/**
 * Draws the number, renders the PDF, files it and queues the notices.
 * Calling this twice is safe — a numbered invoice is returned untouched.
 */
export async function issueInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<{ invoice_number: string; pdf_path: string | null } | { error: string }> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) return { error: "That invoice no longer exists." };

  if (invoice["invoice_number"]) {
    return {
      invoice_number: String(invoice["invoice_number"]),
      pdf_path: (invoice["pdf_path"] as string | null) ?? null,
    };
  }

  const supplier = await loadSupplier(supabase);
  const issueDate = String(invoice["issue_date"] ?? new Date().toISOString().slice(0, 10));
  const series = String(invoice["series"] ?? supplier.invoice_series);

  const { data: numberData, error: numberError } = await supabase.rpc("next_invoice_number", {
    p_series: series,
    p_date: issueDate,
  });
  const invoiceNumber = typeof numberData === "string" ? numberData : "";
  if (numberError || !invoiceNumber) return { error: "We couldn't allocate an invoice number." };

  const dueDate = new Date(`${issueDate}T00:00:00Z`);
  dueDate.setUTCDate(dueDate.getUTCDate() + supplier.invoice_due_days);

  const { error: claimError } = await supabase
    .from("invoices")
    .update({
      invoice_number: invoiceNumber,
      status: "issued",
      due_date: dueDate.toISOString().slice(0, 10),
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId)
    .is("invoice_number", null);
  if (claimError) {
    // Someone else numbered it first: return theirs, never a second number.
    const { data: fresh } = await supabase
      .from("invoices")
      .select("invoice_number, pdf_path")
      .eq("id", invoiceId)
      .maybeSingle();
    if (fresh?.["invoice_number"]) {
      return {
        invoice_number: String(fresh["invoice_number"]),
        pdf_path: (fresh["pdf_path"] as string | null) ?? null,
      };
    }
    return { error: "We couldn't issue the invoice." };
  }

  const { data: lines } = await supabase
    .from("invoice_lines")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("line_no");

  let pdfPath: string | null = null;
  try {
    const { renderInvoicePdf } = await import("@/lib/invoice-pdf.server");
    const bytes = await renderInvoicePdf({
      supplier,
      invoice: { ...(invoice as Record<string, unknown>), invoice_number: invoiceNumber, due_date: dueDate.toISOString().slice(0, 10) },
      lines: (lines ?? []) as Record<string, unknown>[],
    });
    const path = `${String(invoice["organization_id"])}/${invoiceNumber.replace(/\//g, "-")}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("invoices")
      .upload(path, bytes, { contentType: "application/pdf", upsert: true });
    if (!uploadError) {
      pdfPath = path;
      await supabase.from("invoices").update({ pdf_path: path }).eq("id", invoiceId);
    }
  } catch {
    // A missing PDF must not lose the invoice — the number stands and the
    // document can be re-rendered.
  }

  const { notify } = await import("@/lib/billing.server");
  const orgId = invoice["organization_id"] as string | null;
  if (orgId && invoice["kind"] !== "proforma") {
    await notify(supabase, {
      organizationId: orgId,
      audience: "client",
      kind: "invoice_issued",
      payload: {
        invoice_id: invoiceId,
        invoice_number: invoiceNumber,
        amount: Number(invoice["total"] ?? 0),
        pdf_path: pdfPath,
      },
    });
    const buyerEmail = ((invoice["buyer_snapshot"] ?? {}) as Record<string, unknown>)[
      "billing_email"
    ] as string | null;
    if (buyerEmail) {
      await notify(supabase, {
        organizationId: orgId,
        audience: "client",
        kind: "invoice_issued",
        channel: "email",
        recipient: buyerEmail,
        payload: { invoice_id: invoiceId, invoice_number: invoiceNumber, amount: Number(invoice["total"] ?? 0) },
      });
    }
  }

  return { invoice_number: invoiceNumber, pdf_path: pdfPath };
}

export async function markPaid(
  supabase: SupabaseClient,
  invoiceId: string,
  paymentId: string | null,
  amount: number,
): Promise<void> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, total, amount_paid")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) return;

  const paid = round2(Number(invoice["amount_paid"] ?? 0) + Number(amount ?? 0));
  const total = Number(invoice["total"] ?? 0);
  const status = paid + 0.01 >= total ? "paid" : paid > 0 ? "partially_paid" : "issued";

  await supabase
    .from("invoices")
    .update({
      amount_paid: paid,
      status,
      payment_id: paymentId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", invoiceId);
}

/** A credit note against an issued invoice. The wallet refund is the caller's. */
export async function createCreditNote(
  supabase: SupabaseClient,
  invoiceId: string,
  lines: InvoiceLineInput[],
  reason: string,
  createdBy?: string | null,
): Promise<{ invoice_id: string; invoice_number: string } | { error: string }> {
  const { data: original } = await supabase
    .from("invoices")
    .select("id, organization_id, status, invoice_number")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!original) return { error: "That invoice no longer exists." };
  if (!original["invoice_number"]) return { error: "You can only credit an issued invoice." };

  const built = await buildInvoice(supabase, String(original["organization_id"]), {
    kind: "credit_note",
    purpose: "adjustment",
    lines,
    related_invoice_id: invoiceId,
    notes: `Credit note against ${String(original["invoice_number"])} — ${reason}`,
    negate: true,
    created_by: createdBy ?? null,
  });
  if ("error" in built) return built;

  const issued = await issueInvoice(supabase, built.invoice_id);
  if ("error" in issued) return issued;
  return { invoice_id: built.invoice_id, invoice_number: issued.invoice_number };
}

/** A quote, in its own PF series. Never a tax document. */
export async function createProforma(
  supabase: SupabaseClient,
  organizationId: string,
  lines: InvoiceLineInput[],
  createdBy?: string | null,
): Promise<{ invoice_id: string; invoice_number: string } | { error: string }> {
  const built = await buildInvoice(supabase, organizationId, {
    kind: "proforma",
    purpose: "adjustment",
    lines,
    series: "PF",
    notes: "This is a proforma invoice, not a tax invoice. No tax credit may be claimed on it.",
    created_by: createdBy ?? null,
  });
  if ("error" in built) return built;
  const issued = await issueInvoice(supabase, built.invoice_id);
  if ("error" in issued) return issued;
  return { invoice_id: built.invoice_id, invoice_number: issued.invoice_number };
}

/** A short-lived link to the filed PDF. Callers check billing.view first. */
export async function invoiceDownloadUrl(
  supabase: SupabaseClient,
  pdfPath: string,
): Promise<string | null> {
  const { data } = await supabase.storage.from("invoices").createSignedUrl(pdfPath, 600);
  return (data as { signedUrl?: string } | null)?.signedUrl ?? null;
}

/**
 * Re-renders the PDF for an already-numbered invoice. Used when the first
 * render failed — the number never changes, so the file simply reappears.
 */
export async function ensureInvoicePdf(
  supabase: SupabaseClient,
  invoiceId: string,
): Promise<string | null> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) return null;
  const existing = (invoice["pdf_path"] as string | null) ?? null;
  if (existing) return existing;
  const invoiceNumber = (invoice["invoice_number"] as string | null) ?? null;
  if (!invoiceNumber) return null;

  const [supplier, { data: lines }] = await Promise.all([
    loadSupplier(supabase),
    supabase.from("invoice_lines").select("*").eq("invoice_id", invoiceId).order("line_no"),
  ]);

  try {
    const { renderInvoicePdf } = await import("@/lib/invoice-pdf.server");
    const bytes = await renderInvoicePdf({
      supplier,
      invoice: invoice as Record<string, unknown>,
      lines: (lines ?? []) as Record<string, unknown>[],
    });
    const path = `${String(invoice["organization_id"])}/${invoiceNumber.replace(/\//g, "-")}.pdf`;
    const { error } = await supabase.storage
      .from("invoices")
      .upload(path, bytes, { contentType: "application/pdf", upsert: true });
    if (error) return null;
    await supabase.from("invoices").update({ pdf_path: path }).eq("id", invoiceId);
    return path;
  } catch {
    return null;
  }
}
