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
  // Where the buyer's state is unknown, the place of supply is the supplier's
  // own state (an unregistered buyer at the supplier's location).
  const placeOfSupply = isExport ? buyerState : (buyerState ?? supplier.state_code);

  if (input.lines.length === 0) return { error: "An invoice needs at least one line." };
  if (!supplier.state_code) {
    return { error: "Set the supplier state on the platform billing settings first." };
  }
  if (!isExport && !placeOfSupply) {
    return { error: "We couldn't work out the place of supply for this invoice." };
  }

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
      place_of_supply: placeOfSupply,
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

  const { error: lineError } = await supabase
    .from("invoice_lines")
    .insert(prepared.map((line) => ({ ...line, invoice_id: invoice.id as string })));

  // An invoice with no lines is not an invoice. If the lines fail, the shell
  // goes with them rather than sitting around waiting to be issued.
  if (lineError) {
    await supabase.from("invoices").delete().eq("id", invoice.id as string);
    return { error: "We couldn't record the invoice lines." };
  }

  return { invoice_id: invoice.id as string };
}

/**
 * The last gate before a number is drawn. Everything here is arithmetic that
 * must already be true; a failure means the invoice was built wrong, and a
 * wrong invoice must never consume a number.
 */
export function checkInvoiceIssuable(
  invoice: Record<string, unknown>,
  lines: Record<string, unknown>[],
): string | null {
  const n = (v: unknown) => round2(Number(v ?? 0));
  const money = lines.filter((l) => (l["metadata"] as Record<string, unknown> | null)?.["informational"] !== true);

  if (lines.length === 0) return "the invoice has no lines";
  if (money.length === 0) return "the invoice has no chargeable lines";

  const taxable = n(invoice["taxable_value"]);
  const lineSum = round2(money.reduce((sum, l) => sum + Number(l["amount"] ?? 0), 0));
  if (Math.abs(taxable - lineSum) > 0.01) {
    return `taxable value ${taxable} does not match the lines (${lineSum})`;
  }

  const isExport = invoice["is_export"] === true;
  const isInterstate = invoice["is_interstate"] === true;
  const cgst = n(invoice["cgst"]);
  const sgst = n(invoice["sgst"]);
  const igst = n(invoice["igst"]);
  const expectedTax = isExport ? 0 : round2((taxable * TAX_RATE) / 100);

  if (isExport) {
    if (cgst || sgst || igst) return "an export invoice must be zero-rated";
  } else if (isInterstate) {
    if (cgst || sgst) return "an inter-state invoice carries IGST only";
    if (Math.abs(igst - expectedTax) > 0.02) return `IGST ${igst} should be ${expectedTax}`;
  } else {
    if (igst) return "an intra-state invoice carries CGST and SGST only";
    const half = round2(expectedTax / 2);
    if (Math.abs(cgst - half) > 0.02 || Math.abs(sgst - half) > 0.02) {
      return `CGST/SGST ${cgst}/${sgst} should be ${half} each`;
    }
  }

  if (!invoice["place_of_supply"] && !isExport) return "place of supply is missing";
  if (!invoice["supplier_state_code"]) return "supplier state is missing";

  const total = n(invoice["total"]);
  const expectedTotal = round2(taxable + cgst + sgst + igst);
  if (Math.abs(total - expectedTotal) > 0.02) {
    return `total ${total} should be ${expectedTotal}`;
  }
  return null;
}


/**
 * Draws the number, renders the PDF, files it and queues the notices.
 * Calling this twice is safe — a numbered invoice is returned untouched.
 */
export async function issueInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
  options: { deliver?: boolean } = {},
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

  const { data: draftLines } = await supabase
    .from("invoice_lines")
    .select("*")
    .eq("invoice_id", invoiceId)
    .order("line_no");

  const problem = checkInvoiceIssuable(
    invoice as Record<string, unknown>,
    (draftLines ?? []) as Record<string, unknown>[],
  );
  if (problem) return { error: `This invoice can't be issued — ${problem}.` };

  const supplier = await loadSupplier(supabase);
  // A tax document without the supplier's GSTIN is not a tax document. A
  // proforma is a quote and may go out without one.
  if (invoice["kind"] !== "proforma" && !supplier.gstin?.trim()) {
    return {
      error:
        "Supplier GSTIN is missing — add it under platform billing settings before issuing invoices.",
    };
  }
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

  // A missing PDF must not lose the invoice — the number stands and the
  // document is re-rendered by the nightly job or an admin.
  const stored = await storeInvoicePdf(
    supabase,
    supplier,
    {
      ...(invoice as Record<string, unknown>),
      invoice_number: invoiceNumber,
      due_date: dueDate.toISOString().slice(0, 10),
      status: "issued",
    },
    (lines ?? []) as Record<string, unknown>[],
  );
  const pdfPath = stored.path;

  if (invoice["kind"] !== "proforma" && options.deliver !== false) {
    await deliverInvoice(supabase, invoiceId, { fallbackToQueue: true });
  }

  return { invoice_number: invoiceNumber, pdf_path: pdfPath };
}

/**
 * Renders and files the PDF for a numbered invoice. Every failure is logged
 * with the invoice number so a blank pdf_path is never a mystery again.
 */
async function storeInvoicePdf(
  supabase: SupabaseClient,
  supplier: SupplierProfile,
  invoice: Record<string, unknown>,
  lines: Record<string, unknown>[],
): Promise<{ path: string | null; error: string | null }> {
  const invoiceNumber = String(invoice["invoice_number"] ?? "");
  const invoiceId = String(invoice["id"] ?? "");
  try {
    const { renderInvoicePdf } = await import("@/lib/invoice-pdf.server");
    const bytes = await renderInvoicePdf({ supplier, invoice, lines });
    const path = `${String(invoice["organization_id"])}/${invoiceNumber.replace(/\//g, "-")}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("invoices")
      .upload(path, bytes, { contentType: "application/pdf", upsert: true });
    if (uploadError) {
      console.error("[invoices] pdf upload failed", invoiceNumber, uploadError.message);
      await supabase
        .from("invoices")
        .update({ sent: { ...((invoice["sent"] ?? {}) as Record<string, unknown>), pdf_error: uploadError.message.slice(0, 300) } })
        .eq("id", invoiceId);
      return { path: null, error: uploadError.message };
    }
    await supabase.from("invoices").update({ pdf_path: path }).eq("id", invoiceId);
    return { path, error: null };
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    console.error("[invoices] pdf render failed", invoiceNumber, message);
    await supabase
      .from("invoices")
      .update({ sent: { ...((invoice["sent"] ?? {}) as Record<string, unknown>), pdf_error: message.slice(0, 300) } })
      .eq("id", invoiceId);
    return { path: null, error: message };
  }
}

/**
 * Sends the invoice to the buyer's billing WhatsApp as a document, through the
 * same template sender campaigns use (so a messages row is written), and
 * records when it went. Without a PDF, or when the send fails, the notice is
 * queued for the billing-notify worker instead so nobody is left uninformed.
 */
export async function deliverInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
  options: { fallbackToQueue?: boolean } = {},
): Promise<{ ok: true; message_id: string | null } | { ok: false; error: string }> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, organization_id, invoice_number, total, pdf_path, sent, buyer_snapshot, kind")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice?.["invoice_number"]) return { ok: false, error: "This invoice hasn't been issued yet." };

  const orgId = String(invoice["organization_id"]);
  const invoiceNumber = String(invoice["invoice_number"]);
  const total = Number(invoice["total"] ?? 0);
  const { money } = await import("@/lib/billing");
  const { notify } = await import("@/lib/billing.server");
  const sentSoFar = (invoice["sent"] ?? {}) as Record<string, unknown>;

  const queueFallback = async (reason: string) => {
    if (options.fallbackToQueue) {
      await notify(supabase, {
        organizationId: orgId,
        audience: "client",
        kind: "invoice_issued",
        payload: {
          invoice_id: invoiceId,
          invoice_number: invoiceNumber,
          amount: total,
          pdf_path: (invoice["pdf_path"] as string | null) ?? null,
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
          payload: { invoice_id: invoiceId, invoice_number: invoiceNumber, amount: total },
        });
      }
    }
    await supabase
      .from("invoices")
      .update({ sent: { ...sentSoFar, whatsapp_error: reason.slice(0, 300) } })
      .eq("id", invoiceId);
    return { ok: false as const, error: reason };
  };

  try {
    let pdfPath = (invoice["pdf_path"] as string | null) ?? null;
    if (!pdfPath) pdfPath = await ensureInvoicePdf(supabase, invoiceId);
    if (!pdfPath) return await queueFallback("pdf_missing");

    const { resolvePlatformOrg, recipientFor } = await import("@/lib/billing-notify.server");
    const platformOrgId = await resolvePlatformOrg(supabase);
    if (!platformOrgId) return await queueFallback("platform_org_missing");

    const to = await recipientFor(supabase, { organization_id: orgId, audience: "client" });
    if (!to) return await queueFallback("no_recipient");

    const { loadSenderContext, sendCampaignTemplate } = await import("@/lib/campaigns.server");
    const sender = await loadSenderContext(supabase, platformOrgId);
    if (!sender) return await queueFallback("platform_number_not_connected");

    const { data: template } = await supabase
      .from("message_templates")
      .select("name, language, status, components")
      .eq("organization_id", platformOrgId)
      .eq("name", "client_invoice_issued")
      .maybeSingle();
    if (!template || template["status"] !== "APPROVED") return await queueFallback("template_missing");

    const url = await invoiceDownloadUrl(supabase, pdfPath);
    if (!url) return await queueFallback("pdf_url_failed");

    const { data: org } = await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle();
    const orgName = String(org?.["name"] ?? "your workspace");

    const outcome = await sendCampaignTemplate(
      supabase,
      platformOrgId,
      sender,
      {
        contactId: null,
        phone: to,
        variables: {
          "1": orgName,
          "2": money(total),
          // Unpaid invoices carry their payment link; paid ones point home.
          "3": typeof sentSoFar["pay_url"] === "string" && sentSoFar["pay_url"]
            ? String(sentSoFar["pay_url"])
            : "https://aidwar.in/app/billing",
        },
      },
      {
        name: String(template["name"]),
        language: String(template["language"] ?? "en"),
        variableOrder: [1, 2, 3],
        components: (template["components"] as import("@/lib/templates").TemplateComponent[] | null) ?? null,
      },
      { campaignId: null, category: "utility", headerMediaUrl: url },
    );
    if (outcome.error) return await queueFallback(outcome.error);

    await supabase
      .from("invoices")
      .update({
        sent: {
          ...sentSoFar,
          whatsapp_at: new Date().toISOString(),
          message_id: outcome.messageId,
          whatsapp_to: to,
          whatsapp_error: null,
        },
      })
      .eq("id", invoiceId);
    return { ok: true, message_id: outcome.messageId };
  } catch (error) {
    const message = String((error as Error)?.message ?? error);
    console.error("[invoices] delivery failed", invoiceNumber, message);
    return await queueFallback(message);
  }
}

/**
 * Exactly one tax invoice per paid payment. Rebuilds nothing when one already
 * exists (void ones excluded) — safe to call from the webhook, the nightly job
 * and an admin repair alike.
 */
export async function invoiceForPayment(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<{ invoice_id: string; invoice_number: string | null; created: boolean } | { error: string }> {
  const { data: existing } = await supabase
    .from("invoices")
    .select("id, invoice_number")
    .eq("payment_id", paymentId)
    .eq("kind", "tax_invoice")
    .neq("status", "void")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) {
    const issued = await issueInvoice(supabase, String(existing["id"]));
    return {
      invoice_id: String(existing["id"]),
      invoice_number: "error" in issued ? null : issued.invoice_number,
      created: false,
    };
  }

  const { data: payment } = await supabase
    .from("payments")
    .select("id, organization_id, status, amount, purpose, credit_pack_id, raw")
    .eq("id", paymentId)
    .maybeSingle();
  if (!payment) return { error: "That payment no longer exists." };
  if (payment["status"] !== "paid") return { error: "Only a paid payment gets an invoice." };
  const organizationId = (payment["organization_id"] as string | null) ?? null;
  if (!organizationId) return { error: "This payment belongs to no workspace." };

  const raw = (payment["raw"] ?? {}) as Record<string, unknown>;
  const base = round2(Number(payment["amount"] ?? 0));
  if (base <= 0) return { error: "This payment carries no taxable amount." };

  const supplier = await loadSupplier(supabase);
  const purpose = String(payment["purpose"] ?? "");
  const lines: InvoiceLineInput[] = [];
  let invoicePurpose: InvoicePurpose = "adjustment";

  if (purpose === "credit_purchase") {
    invoicePurpose = "credit_purchase";
    let packName = (raw["pack_name"] as string | null) ?? null;
    if (payment["credit_pack_id"]) {
      const { data: pack } = await supabase
        .from("credit_packs")
        .select("name")
        .eq("id", payment["credit_pack_id"] as string)
        .maybeSingle();
      packName = (pack?.["name"] as string | null) ?? packName;
    }
    lines.push({
      line_type: "credits",
      description: `Prepaid messaging credits${packName ? ` — ${packName}` : ""}`,
      sac_code: supplier.sac_messaging,
      unit_price: base,
      metadata: { pack_id: payment["credit_pack_id"] ?? null },
    });
  } else if (purpose === "plan_fee") {
    invoicePurpose = "plan_fee";
    const planName = String(raw["plan_name"] ?? raw["plan_key"] ?? "Plan");
    const cycle = String(raw["cycle"] ?? "monthly");
    lines.push({
      line_type: "plan",
      description: `${planName} plan — ${cycle === "annual" ? "annual" : "monthly"} fee`,
      sac_code: supplier.sac_platform,
      unit_price: base,
      metadata: { plan_key: raw["plan_key"] ?? null, cycle },
    });
  } else {
    invoicePurpose = "usage";
    lines.push({
      line_type: "addon",
      description: String(raw["description"] ?? "AiDwar add-on"),
      sac_code: supplier.sac_platform,
      unit_price: base,
    });
  }

  const built = await buildInvoice(supabase, organizationId, {
    kind: "tax_invoice",
    purpose: invoicePurpose,
    lines,
    payment_id: paymentId,
  });
  if ("error" in built) return built;

  const issued = await issueInvoice(supabase, built.invoice_id);
  if ("error" in issued) {
    // A draft that can't be issued must not linger and be issued later by
    // accident with stale figures.
    await supabase.from("invoices").delete().eq("id", built.invoice_id);
    return issued;
  }

  const gross = Number(raw["gross_amount"] ?? raw["gross"] ?? 0);
  const { data: fresh } = await supabase
    .from("invoices")
    .select("total")
    .eq("id", built.invoice_id)
    .maybeSingle();
  const total = Number(fresh?.["total"] ?? gross);
  await markPaid(supabase, built.invoice_id, paymentId, gross > 0 ? Math.min(gross, total) : total);

  return { invoice_id: built.invoice_id, invoice_number: issued.invoice_number, created: true };
}

export async function markPaid(
  supabase: SupabaseClient,
  invoiceId: string,
  paymentId: string | null,
  amount: number,
): Promise<void> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("id, total, amount_paid, organization_id, purpose")
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

  // A settled plan fee undoes the whole dunning ladder — but only once no
  // other plan invoice for the workspace is still overdue.
  if (status === "paid" && invoice["purpose"] === "plan_fee" && invoice["organization_id"]) {
    const orgId = String(invoice["organization_id"]);
    const { data: stillOpen } = await supabase
      .from("invoices")
      .select("id")
      .eq("organization_id", orgId)
      .eq("purpose", "plan_fee")
      .in("status", ["issued", "partially_paid"])
      .neq("id", invoiceId)
      .limit(1);
    if (!((stillOpen as { id: string }[] | null)?.length)) {
      const { restoreAfterPayment } = await import("@/lib/dunning.server");
      await restoreAfterPayment(supabase, orgId);
    }
  }
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
  options: { force?: boolean } = {},
): Promise<string | null> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) return null;
  const existing = (invoice["pdf_path"] as string | null) ?? null;
  if (existing && !options.force) return existing;
  const invoiceNumber = (invoice["invoice_number"] as string | null) ?? null;
  if (!invoiceNumber) return null;

  const [supplier, { data: lines }] = await Promise.all([
    loadSupplier(supabase),
    supabase.from("invoice_lines").select("*").eq("invoice_id", invoiceId).order("line_no"),
  ]);

  const stored = await storeInvoicePdf(
    supabase,
    supplier,
    invoice as Record<string, unknown>,
    (lines ?? []) as Record<string, unknown>[],
  );
  return stored.path;
}

/**
 * Backfill, in three sweeps: paid payments with no invoice at all, drafts whose
 * payment has been paid, and numbered invoices still missing their PDF. Safe to
 * run repeatedly — nothing here draws a second number or files a second PDF.
 */
export async function issuePendingInvoices(
  supabase: SupabaseClient,
  limit = 100,
): Promise<{
  issued: string[];
  failed: { invoice_id: string; error: string }[];
  pdfs_regenerated: string[];
}> {
  const issued: string[] = [];
  const failed: { invoice_id: string; error: string }[] = [];
  const pdfsRegenerated: string[] = [];
  const cap = Math.min(Math.max(limit, 1), 200);

  // 1. Paid payments that never got an invoice (e.g. self-serve plan purchases
  //    settled before the invoice step existed).
  const { data: paidPayments } = await supabase
    .from("payments")
    .select("id")
    .eq("status", "paid")
    .in("purpose", ["credit_purchase", "plan_fee"])
    .order("paid_at", { ascending: true })
    .limit(500);
  const paymentIds = ((paidPayments ?? []) as { id: string }[]).map((p) => p.id);
  const { data: invoiced } = paymentIds.length
    ? await supabase
        .from("invoices")
        .select("payment_id")
        .in("payment_id", paymentIds)
        .eq("kind", "tax_invoice")
        .neq("status", "void")
    : { data: [] as { payment_id: string }[] };
  const covered = new Set(((invoiced ?? []) as { payment_id: string }[]).map((r) => r.payment_id));
  for (const paymentId of paymentIds.filter((id) => !covered.has(id)).slice(0, cap)) {
    const result = await invoiceForPayment(supabase, paymentId);
    if ("error" in result) failed.push({ invoice_id: paymentId, error: result.error });
    else if (result.invoice_number) issued.push(result.invoice_number);
  }

  // 2. Drafts whose payment has since been paid.
  const { data: drafts } = await supabase
    .from("invoices")
    .select("id, payment_id, kind, status")
    .eq("status", "draft")
    .eq("kind", "tax_invoice")
    .is("invoice_number", null)
    .order("created_at", { ascending: true })
    .limit(cap);

  for (const row of ((drafts ?? []) as Record<string, unknown>[])) {
    const invoiceId = String(row["id"]);
    const paymentId = (row["payment_id"] as string | null) ?? null;
    if (!paymentId) continue;

    const { data: payment } = await supabase
      .from("payments")
      .select("id, status, amount")
      .eq("id", paymentId)
      .maybeSingle();
    if ((payment as { status?: string } | null)?.status !== "paid") continue;

    const { data: before } = await supabase
      .from("invoices")
      .select("total, amount_paid")
      .eq("id", invoiceId)
      .maybeSingle();

    const result = await issueInvoice(supabase, invoiceId);
    if ("error" in result) {
      failed.push({ invoice_id: invoiceId, error: result.error });
      continue;
    }

    // Only settle what is still outstanding — never bank the same rupee twice.
    const total = Number((before as Record<string, unknown> | null)?.["total"] ?? 0);
    const already = Number((before as Record<string, unknown> | null)?.["amount_paid"] ?? 0);
    const outstanding = round2(Math.min(Number((payment as { amount?: number }).amount ?? 0), total - already));
    if (outstanding > 0) await markPaid(supabase, invoiceId, paymentId, outstanding);
    issued.push(result.invoice_number);
  }

  // 3. Numbered invoices whose PDF never landed.
  const { data: missingPdf } = await supabase
    .from("invoices")
    .select("id, invoice_number")
    .not("invoice_number", "is", null)
    .is("pdf_path", null)
    .neq("status", "void")
    .order("created_at", { ascending: true })
    .limit(cap);
  for (const row of (missingPdf ?? []) as Record<string, unknown>[]) {
    const path = await ensureInvoicePdf(supabase, String(row["id"]));
    if (path) pdfsRegenerated.push(String(row["invoice_number"]));
    else failed.push({ invoice_id: String(row["id"]), error: "pdf_not_generated" });
  }

  return { issued, failed, pdfs_regenerated: pdfsRegenerated };
}

/**
 * Repair: voids an invoice that should never have been issued and rebuilds a
 * correct one from the payment behind it. The old number is retired for good —
 * numbers are never reused — and the replacement passes the issue guard or
 * nothing is written at all.
 */
export async function voidAndReissueInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
  note: string,
): Promise<{ invoice_number: string; invoice_id: string } | { error: string }> {
  const { data: invoice } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!invoice) return { error: "That invoice no longer exists." };

  const paymentId = (invoice["payment_id"] as string | null) ?? null;
  if (!paymentId) return { error: "This invoice has no payment behind it to rebuild from." };

  const { data: payment } = await supabase
    .from("payments")
    .select("id, organization_id, amount, status, credit_pack_id, raw")
    .eq("id", paymentId)
    .maybeSingle();
  if (!payment) return { error: "The payment behind this invoice is missing." };

  const raw = ((payment["raw"] ?? {}) as Record<string, unknown>);
  let base = round2(Number(raw["pack_amount"] ?? 0));
  let packName = String(raw["pack_name"] ?? "");
  const packId = (payment["credit_pack_id"] as string | null) ?? null;
  if (packId) {
    const { data: pack } = await supabase
      .from("credit_packs")
      .select("name, amount")
      .eq("id", packId)
      .maybeSingle();
    if (pack) {
      base = round2(Number((pack as Record<string, unknown>)["amount"] ?? base));
      packName = String((pack as Record<string, unknown>)["name"] ?? packName);
    }
  }
  if (base <= 0) base = round2(Number(payment["amount"] ?? 0));
  if (base <= 0) return { error: "We couldn't work out what this payment was for." };

  const organizationId = String(payment["organization_id"]);
  const built = await buildInvoice(supabase, organizationId, {
    kind: "tax_invoice",
    purpose: ((invoice["purpose"] as InvoicePurpose | null) ?? "credit_purchase"),
    payment_id: paymentId,
    related_invoice_id: invoiceId,
    lines: [
      {
        line_type: "credits",
        description: packName ? `Message credits — ${packName}` : "Message credits",
        sac_code: "998314",
        quantity: 1,
        unit_price: base,
      },
    ],
  });
  if ("error" in built) return built;

  const issued = await issueInvoice(supabase, built.invoice_id);
  if ("error" in issued) {
    await supabase.from("invoices").delete().eq("id", built.invoice_id);
    return issued;
  }

  await markPaid(supabase, built.invoice_id, paymentId, round2(Number(payment["amount"] ?? 0)) || base);

  const oldNotes = (invoice["notes"] as string | null) ?? null;
  await supabase
    .from("invoices")
    .update({
      status: "void",
      notes: oldNotes ? `${oldNotes} · ${note}` : note,
      amount_paid: 0,
    })
    .eq("id", invoiceId);

  return { invoice_number: issued.invoice_number, invoice_id: built.invoice_id };
}
