import type { SupabaseClient } from "@supabase/supabase-js";
import { gstFromGross, round2, toPaise } from "@/lib/billing";
import { TAX_RATE, loadSupplier } from "@/lib/invoices.server";

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
  const rate = isExport ? 0 : TAX_RATE;

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
  if (invoice["kind"] !== "tax_invoice") return { error: "Only a tax invoice can be credited." };

  const supplier = await loadSupplier(supabase);
  if (!supplier.gstin?.trim()) {
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
