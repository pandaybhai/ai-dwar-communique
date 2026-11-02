import type { SupabaseClient } from "@supabase/supabase-js";
import { gstFromGross, round2, toPaise } from "@/lib/billing";
import { TAX_RATE, loadSupplier } from "@/lib/invoices.server";
import {
  cancellingNotes,
  creditCoverByInvoice,
  withoutCancelled,
  type CreditCover,
  type CreditNoteLike,
} from "@/lib/invoice-cancel";

/**
 * Credit notes against an issued invoice.
 *
 * A credit note carries its own CN-series number, mirrors the tax treatment
 * of the invoice it credits (intra → CGST+SGST, inter → IGST, export → nil),
 * and never touches the wallet directly: any refund goes through wallet_apply
 * with entry_type 'credit_note', like every other rupee in the ledger.
 */

export type CreditNoteInput = {
  invoiceId: string;
  /** Gross amount to credit (what the buyer actually paid), in INR. */
  amount: number;
  reason: string;
  refundToWallet: boolean;
  actorId: string;
};

type CreditNotePlan = {
  taxable: number;
  cgst: number;
  sgst: number;
  igst: number;
  rate: number;
};

/**
 * The money on a credit note, worked out in whole paise:
 *   - the credit can never take the invoice past its total (not even by a
 *     paisa) once earlier issued notes are counted;
 *   - the tax treatment mirrors the invoice (intra → CGST+SGST, inter → IGST,
 *     export → nil), and CGST + SGST always equals the tax backed out;
 *   - the note that credits the last of the invoice reverses exactly what is
 *     left of the invoice's taxable value and each tax head, so the notes
 *     together undo the invoice to the paisa.
 */
export function planCreditNote(
  invoice: Record<string, unknown>,
  priorNotes: Record<string, unknown>[],
  amount: number,
): CreditNotePlan | { error: string } {
  const sumP = (key: string) =>
    priorNotes.reduce((s, r) => s + toPaise(Number(r[key] ?? 0)), 0);
  const amountP = toPaise(amount);
  const totalP = toPaise(Number(invoice["total"] ?? 0));
  const remainingP = totalP - sumP("amount");
  if (amountP > remainingP) {
    return {
      error: `That's more than the invoice: ₹${round2(Math.max(remainingP, 0) / 100)} is the most you can still credit.`,
    };
  }

  const isExport = invoice["is_export"] === true;
  const isInterstate = invoice["is_interstate"] === true;
  // Batch 55: a plain invoice carried no GST, so its credit note carries none.
  const rate = isExport || invoice["kind"] === "invoice" ? 0 : TAX_RATE;

  if (amountP === remainingP) {
    const left = {
      taxable: toPaise(Number(invoice["taxable_value"] ?? 0)) - sumP("taxable_value"),
      cgst: toPaise(Number(invoice["cgst"] ?? 0)) - sumP("cgst"),
      sgst: toPaise(Number(invoice["sgst"] ?? 0)) - sumP("sgst"),
      igst: toPaise(Number(invoice["igst"] ?? 0)) - sumP("igst"),
    };
    const consistent =
      left.taxable >= 0 &&
      left.cgst >= 0 &&
      left.sgst >= 0 &&
      left.igst >= 0 &&
      left.taxable + left.cgst + left.sgst + left.igst === amountP;
    if (consistent) {
      return {
        taxable: left.taxable / 100,
        cgst: left.cgst / 100,
        sgst: left.sgst / 100,
        igst: left.igst / 100,
        rate,
      };
    }
  }

  const split = gstFromGross(amountP / 100, { isExport, isInterstate, ratePercent: rate });
  return { taxable: split.taxable, cgst: split.cgst, sgst: split.sgst, igst: split.igst, rate };
}

export async function issueCreditNote(
  supabase: SupabaseClient,
  input: CreditNoteInput,
): Promise<
  | { credit_note_id: string; number: string; amount: number; refunded: boolean; pdf_path: string | null }
  | { error: string }
> {
  const amount = round2(Number(input.amount));
  if (!(amount > 0)) return { error: "Enter an amount above zero." };
  const reason = input.reason.trim();
  if (reason.length < 3) return { error: "Say why the credit note is being issued." };

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", input.invoiceId)
    .maybeSingle();
  if (!invoice) return { error: "That invoice no longer exists." };
  if (!invoice["invoice_number"] || invoice["status"] === "void" || invoice["status"] === "draft") {
    return { error: "You can only credit an issued invoice." };
  }
  if (invoice["kind"] !== "tax_invoice" && invoice["kind"] !== "invoice") {
    return { error: "Only a tax invoice or an invoice can be credited." };
  }

  const supplier = await loadSupplier(supabase);
  // A GSTIN is needed only while GST is charged (Batch 55): not registered,
  // a credit note (even one reversing an old GST invoice) shows none.
  if (supplier.gst_registered && !supplier.gstin?.trim()) {
    return { error: "Supplier GSTIN is missing — add it under platform billing settings first." };
  }

  const { data: priorNotes } = await supabase
    .from("credit_notes")
    .select("amount, taxable_value, cgst, sgst, igst")
    .eq("invoice_id", input.invoiceId)
    .eq("status", "issued");
  const plan = planCreditNote(
    invoice as Record<string, unknown>,
    (priorNotes ?? []) as Record<string, unknown>[],
    amount,
  );
  if ("error" in plan) return plan;
  const { taxable, cgst, sgst, igst, rate } = plan;

  const today = new Date().toISOString().slice(0, 10);
  const { data: numberData, error: numberError } = await supabase.rpc("next_invoice_number", {
    p_series: "CN",
    p_date: today,
  });
  const number = typeof numberData === "string" ? numberData : "";
  if (numberError || !number) return { error: "We couldn't allocate a credit note number." };

  const organizationId = String(invoice["organization_id"]);
  const { data: note, error: insertError } = await supabase
    .from("credit_notes")
    .insert({
      organization_id: organizationId,
      invoice_id: input.invoiceId,
      number,
      reason,
      amount,
      taxable_value: taxable,
      cgst,
      sgst,
      igst,
      status: "issued",
      refund_mode: input.refundToWallet ? "wallet" : "none",
      created_by: input.actorId,
    })
    .select("id")
    .maybeSingle();
  if (insertError || !note) return { error: "We couldn't record the credit note." };
  const creditNoteId = String(note["id"]);

  // Wallet refund — only ever through wallet_apply.
  let refunded = false;
  if (input.refundToWallet) {
    const { data: entryId, error: walletError } = await supabase.rpc("wallet_apply", {
      p_org: organizationId,
      p_type: "credit_note",
      p_amount: amount,
      p_ref_type: "credit_note",
      p_ref_id: creditNoteId,
      p_description: `Credit note ${number} against ${String(invoice["invoice_number"])} — ${reason}`,
      p_metadata: { invoice_id: input.invoiceId, credit_note: number },
      p_actor: input.actorId,
    });
    if (walletError) {
      console.error("[credit-notes] wallet refund failed", number, walletError.message);
    } else {
      refunded = true;
      await supabase
        .from("credit_notes")
        .update({ ledger_entry_id: typeof entryId === "string" ? entryId : null })
        .eq("id", creditNoteId);
    }
  }

  // The PDF reuses the invoice renderer with the credit-note title.
  let pdfPath: string | null = null;
  try {
    const { renderInvoicePdf } = await import("@/lib/invoice-pdf.server");
    const bytes = await renderInvoicePdf({
      supplier,
      invoice: {
        ...(invoice as Record<string, unknown>),
        id: creditNoteId,
        kind: "credit_note",
        credited_kind: invoice["kind"],
        invoice_number: number,
        issue_date: today,
        due_date: null,
        status: "issued",
        subtotal: taxable,
        taxable_value: taxable,
        discount: 0,
        cgst,
        sgst,
        igst,
        total: amount,
        amount_paid: 0,
        tds_expected: 0,
        roi_snapshot: null,
        notes: `Credit note against ${String(invoice["invoice_number"])} — ${reason}${
          input.refundToWallet ? ". Amount credited to your AiDwar wallet." : ""
        }`,
      },
      lines: [
        {
          line_no: 1,
          line_type: "adjustment",
          description: `Credit against invoice ${String(invoice["invoice_number"])}`,
          sac_code: supplier.sac_platform,
          quantity: 1,
          unit: null,
          unit_price: taxable,
          amount: taxable,
          tax_rate: rate,
          metadata: {},
        },
      ],
    });
    pdfPath = `${organizationId}/${number.replace(/\//g, "-")}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("invoices")
      .upload(pdfPath, bytes, { contentType: "application/pdf", upsert: true });
    if (uploadError) {
      console.error("[credit-notes] pdf upload failed", number, uploadError.message);
      pdfPath = null;
    } else {
      await supabase.from("credit_notes").update({ pdf_path: pdfPath }).eq("id", creditNoteId);
    }
  } catch (error) {
    console.error("[credit-notes] pdf render failed", number, String((error as Error)?.message ?? error));
    pdfPath = null;
  }

  await supabase.from("activity_log").insert({
    organization_id: organizationId,
    user_id: input.actorId,
    action: "credit_note_issued",
    details: {
      credit_note: number,
      invoice: invoice["invoice_number"],
      amount,
      refunded_to_wallet: refunded,
    },
  });

  return { credit_note_id: creditNoteId, number, amount, refunded, pdf_path: pdfPath };
}

export async function listCreditNotes(
  supabase: SupabaseClient,
  filter: { organizationId?: string | null; invoiceId?: string | null },
) {
  let query = supabase
    .from("credit_notes")
    .select("id, organization_id, invoice_id, number, reason, amount, taxable_value, cgst, sgst, igst, status, refund_mode, pdf_path, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  if (filter.organizationId) query = query.eq("organization_id", filter.organizationId);
  if (filter.invoiceId) query = query.eq("invoice_id", filter.invoiceId);
  const { data } = await query;
  return (data ?? []) as Record<string, unknown>[];
}

/**
 * Batch 58: the issued credit notes against these invoices, per invoice (see
 * invoice-cancel.ts). A failed read answers an empty map, so a screen shows
 * the stored status; callers that chase money read it with `strict`.
 */
export async function loadCreditCover(
  supabase: SupabaseClient,
  invoiceIds: string[],
  options: { strict?: boolean } = {},
): Promise<Map<string, CreditCover>> {
  const ids = [...new Set(invoiceIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const notes: CreditNoteLike[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("credit_notes")
      .select("invoice_id, number, amount, status, created_at")
      .in("invoice_id", ids.slice(i, i + 200))
      .eq("status", "issued")
      .order("created_at", { ascending: true });
    if (error) {
      if (options.strict) throw new Error(`credit notes read failed: ${error.message}`);
      return new Map();
    }
    notes.push(...((data ?? []) as CreditNoteLike[]));
  }
  return creditCoverByInvoice(notes);
}

/**
 * Batch 58 "Cancel invoice" (Super Admin): the existing credit-note path,
 * issueCreditNote, for whatever is still uncredited on an unpaid invoice,
 * with the wallet switch forced OFF and a required reason. The invoice row is
 * never edited; it reads as cancelled from its credit notes from then on.
 * A plan fee whose cancel leaves the workspace with nothing else overdue
 * lifts the dunning ladder exactly as a payment would (restoreAfterPayment).
 */
export async function cancelInvoice(
  supabase: SupabaseClient,
  input: { invoiceId: string; reason: string; actorId: string },
): Promise<
  | { credit_note_id: string; number: string; amount: number; dunning_lifted: boolean }
  | { error: string }
> {
  const reason = input.reason.trim();
  if (reason.length < 3) return { error: "Say why the invoice is being cancelled." };

  const { data: invoice, error: readError } = await supabase
    .from("invoices")
    .select("id, organization_id, invoice_number, kind, purpose, status, total, amount_paid")
    .eq("id", input.invoiceId)
    .maybeSingle();
  if (readError) return { error: "We couldn't read that invoice." };
  if (!invoice) return { error: "That invoice no longer exists." };
  const row = invoice as Record<string, unknown>;
  if (row["status"] === "paid" || Number(row["amount_paid"] ?? 0) > 0) {
    return { error: "Money was paid against this invoice — issue a credit note (or a refund) instead." };
  }
  if (!["issued", "overdue"].includes(String(row["status"]))) {
    return { error: "Only an issued, unpaid invoice can be cancelled." };
  }

  let cover: Map<string, CreditCover>;
  try {
    cover = await loadCreditCover(supabase, [input.invoiceId], { strict: true });
  } catch {
    return { error: "We couldn't read this invoice's credit notes." };
  }
  if (cancellingNotes(row, cover.get(input.invoiceId))) {
    return { error: "This invoice is already cancelled by its credit notes." };
  }
  const remainingP =
    toPaise(Number(row["total"] ?? 0)) - toPaise(cover.get(input.invoiceId)?.credited ?? 0);
  if (!(remainingP > 0)) return { error: "Nothing is left to cancel on this invoice." };

  const issued = await issueCreditNote(supabase, {
    invoiceId: input.invoiceId,
    amount: remainingP / 100,
    reason: `Invoice cancelled: ${reason}`,
    refundToWallet: false,
    actorId: input.actorId,
  });
  if ("error" in issued) return issued;

  const orgId = String(row["organization_id"] ?? "");
  await supabase.from("activity_log").insert({
    organization_id: orgId,
    user_id: input.actorId,
    action: "invoice_cancelled",
    details: {
      invoice: row["invoice_number"],
      credit_note: issued.number,
      amount: issued.amount,
      reason,
      refunded_to_wallet: false,
    },
  });

  let dunningLifted = false;
  if (row["purpose"] === "plan_fee" && orgId) {
    try {
      dunningLifted = await liftDunningIfNothingOwed(supabase, orgId);
    } catch (error) {
      console.error("[credit-notes] dunning lift after cancel failed", orgId, String(error));
    }
  }
  return {
    credit_note_id: issued.credit_note_id,
    number: issued.number,
    amount: issued.amount,
    dunning_lifted: dunningLifted,
  };
}

/**
 * The plan-fee invoices of a workspace that are still owed: open and not
 * cancelled by credit notes. Throws when it can't tell.
 */
export async function openPlanInvoices(
  supabase: SupabaseClient,
  organizationId: string,
  exceptId?: string,
): Promise<string[]> {
  let query = supabase
    .from("invoices")
    .select("id, status, total")
    .eq("organization_id", organizationId)
    .eq("purpose", "plan_fee")
    .in("status", ["issued", "partially_paid"]);
  if (exceptId) query = query.neq("id", exceptId);
  const { data, error } = await query.limit(100);
  if (error) throw new Error(`open invoices read failed: ${error.message}`);
  const rows = (data ?? []) as Record<string, unknown>[];
  const cover = await loadCreditCover(
    supabase,
    rows.map((r) => String(r["id"])),
    { strict: true },
  );
  return withoutCancelled(rows, cover).map((r) => String(r["id"]));
}

/** Lifts the dunning ladder when it is up and no plan invoice is still owed. */
async function liftDunningIfNothingOwed(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data: settings, error } = await supabase
    .from("organization_billing_settings")
    .select("dunning_stage")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error || !settings?.["dunning_stage"]) return false;
  if ((await openPlanInvoices(supabase, organizationId)).length > 0) return false;
  const { restoreAfterPayment } = await import("@/lib/dunning.server");
  await restoreAfterPayment(supabase, organizationId);
  return true;
}
