import type { SupabaseClient } from "@supabase/supabase-js";
import { round2, toPaise } from "@/lib/billing";
import type { InvoiceLineInput, InvoicePurpose } from "@/lib/invoices.server";

/**
 * Batch 55: "Re-issue without GST", a Super Admin action on one past tax
 * invoice that charged GST while Meezoy Ventures was not GST-registered.
 *
 *   1. a credit note for the whole original (the existing credit-note path,
 *      issueCreditNote, refundToWallet false);
 *   2. a new no-GST invoice (kind "invoice") for the same base amount, the
 *      same lines and the same payment, marked paid by it;
 *   3. the GST that was collected credited back to the wallet with
 *      wallet_apply('credit_note'), referencing the credit note.
 *
 * Nothing runs on its own: the founder picks each invoice. Every step looks
 * for its own earlier result first, so a re-issue that stopped half way
 * finishes on the next click and never doubles a note, an invoice or a credit.
 */

/** Marks the credit note this action issued (and how a retry finds it). */
export const REISSUE_REASON = "Re-issued without GST: supplier not registered under GST";

export type GstInvoiceRow = {
  id: string;
  organization_id: string;
  organization_name: string | null;
  invoice_number: string;
  purpose: string | null;
  status: string;
  issue_date: string | null;
  taxable_value: number;
  gst: number;
  total: number;
  amount_paid: number;
  payment_id: string | null;
  /** null = can be re-issued now; else why not. */
  blocked: string | null;
  reissued_as: string | null;
};

const num = (v: unknown) => round2(Number(v ?? 0));
const gstOf = (r: Record<string, unknown>) =>
  num(Number(r["cgst"] ?? 0) + Number(r["sgst"] ?? 0) + Number(r["igst"] ?? 0));

/** Why this tax invoice can't be re-issued without GST, or null. */
export function reissueBlock(
  invoice: Record<string, unknown>,
  input: { creditNotes: Record<string, unknown>[]; gstRegistered: boolean },
): string | null {
  if (input.gstRegistered) return "The platform is GST-registered — GST invoices stand.";
  if (invoice["kind"] !== "tax_invoice") return "Only a GST tax invoice is re-issued.";
  if (!invoice["invoice_number"]) return "This invoice was never issued.";
  if (invoice["status"] === "void") return "This invoice is void.";
  if (!(gstOf(invoice) > 0)) return "No GST was charged on this invoice.";
  if (invoice["status"] !== "paid") {
    return "Not paid in full — no GST was collected to give back. Decide on this one by hand.";
  }
  const foreign = input.creditNotes.filter(
    (n) => n["status"] === "issued" && String(n["reason"] ?? "") !== REISSUE_REASON,
  );
  if (foreign.length > 0) return "This invoice already has a credit note — handle it by hand.";
  return null;
}

/** Every GST tax invoice ever issued, with whether it can be re-issued. Read only. */
export async function listGstInvoices(supabase: SupabaseClient): Promise<GstInvoiceRow[]> {
  const { loadGstRegistered } = await import("@/lib/gst-mode.server");
  const gstRegistered = (await loadGstRegistered(supabase)) !== false;
  const { data } = await supabase
    .from("invoices")
    .select(
      "id, organization_id, invoice_number, kind, purpose, status, issue_date, taxable_value, cgst, sgst, igst, total, amount_paid, payment_id, organizations(name)",
    )
    .eq("kind", "tax_invoice")
    .not("invoice_number", "is", null)
    .order("issue_date", { ascending: true })
    .limit(1000);
  const rows = ((data ?? []) as Record<string, unknown>[]).filter((r) => gstOf(r) > 0);
  if (rows.length === 0) return [];

  const ids = rows.map((r) => String(r["id"]));
  const [{ data: notes }, { data: replacements }] = await Promise.all([
    supabase.from("credit_notes").select("invoice_id, status, reason").in("invoice_id", ids),
    supabase
      .from("invoices")
      .select("related_invoice_id, invoice_number")
      .in("related_invoice_id", ids)
      .eq("kind", "invoice")
      .neq("status", "void"),
  ]);
  const notesBy = new Map<string, Record<string, unknown>[]>();
  for (const n of (notes ?? []) as Record<string, unknown>[]) {
    const key = String(n["invoice_id"]);
    notesBy.set(key, [...(notesBy.get(key) ?? []), n]);
  }
  const replacedBy = new Map<string, string>();
  for (const r of (replacements ?? []) as Record<string, unknown>[]) {
    replacedBy.set(String(r["related_invoice_id"]), String(r["invoice_number"] ?? "draft"));
  }

  return rows.map((r) => {
    const id = String(r["id"]);
    const reissuedAs = replacedBy.get(id) ?? null;
    return {
      id,
      organization_id: String(r["organization_id"]),
      organization_name:
        ((r["organizations"] as Record<string, unknown> | null)?.["name"] as string) ?? null,
      invoice_number: String(r["invoice_number"]),
      purpose: (r["purpose"] as string | null) ?? null,
      status: String(r["status"]),
      issue_date: (r["issue_date"] as string | null) ?? null,
      taxable_value: num(r["taxable_value"]),
      gst: gstOf(r),
      total: num(r["total"]),
      amount_paid: num(r["amount_paid"]),
      payment_id: (r["payment_id"] as string | null) ?? null,
      reissued_as: reissuedAs,
      blocked: reissuedAs
        ? `Already re-issued as ${reissuedAs}.`
        : reissueBlock(r, { creditNotes: notesBy.get(id) ?? [], gstRegistered }),
    };
  });
}

export type ReissueResult = {
  original: string;
  credit_note: string;
  invoice_id: string;
  invoice_number: string;
  wallet_credit: number;
};

export async function reissueWithoutGst(
  supabase: SupabaseClient,
  input: { invoiceId: string; actorId: string; confirmed: boolean },
): Promise<ReissueResult | { error: string }> {
  if (!input.confirmed) return { error: "Confirm the re-issue first." };

  const { data: original } = await supabase
    .from("invoices")
    .select("*")
    .eq("id", input.invoiceId)
    .maybeSingle();
  if (!original) return { error: "That invoice no longer exists." };
  const orig = original as Record<string, unknown>;
  const organizationId = String(orig["organization_id"]);
  const originalNumber = String(orig["invoice_number"] ?? "");

  const { loadSupplier, buildInvoice, issueInvoice, markPaid } =
    await import("@/lib/invoices.server");
  const supplier = await loadSupplier(supabase);

  const { data: noteRows, error: notesError } = await supabase
    .from("credit_notes")
    .select("id, number, status, reason, amount, ledger_entry_id")
    .eq("invoice_id", input.invoiceId);
  if (notesError) return { error: "We couldn't read this invoice's credit notes." };
  const notes = (noteRows ?? []) as Record<string, unknown>[];
  const ownNote = notes.find(
    (n) => n["status"] === "issued" && String(n["reason"] ?? "") === REISSUE_REASON,
  );

  const blocked = reissueBlock(orig, {
    creditNotes: notes,
    gstRegistered: supplier.gst_registered,
  });
  // A half-finished re-issue (its own credit note is there) may always finish.
  if (blocked && !ownNote) return { error: blocked };
  if (supplier.gst_registered)
    return { error: "The platform is GST-registered — GST invoices stand." };

  const gst = gstOf(orig);
  const base = num(orig["taxable_value"]);
  const paid = num(orig["amount_paid"]);

  // 1. The credit note for the whole original.
  let note = ownNote ? { id: String(ownNote["id"]), number: String(ownNote["number"]) } : null;
  if (!note) {
    const { issueCreditNote } = await import("@/lib/credit-notes.server");
    const issued = await issueCreditNote(supabase, {
      invoiceId: input.invoiceId,
      amount: num(orig["total"]),
      reason: REISSUE_REASON,
      refundToWallet: false,
      actorId: input.actorId,
    });
    if ("error" in issued) return { error: `Credit note not issued: ${issued.error}` };
    note = { id: issued.credit_note_id, number: issued.number };
  }

  // 2. The no-GST invoice for the same base amount.
  const { data: existingNew } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, amount_paid, total")
    .eq("related_invoice_id", input.invoiceId)
    .eq("kind", "invoice")
    .neq("status", "void")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  let newId = (existingNew?.["id"] as string | undefined) ?? null;
  if (!newId) {
    const { data: lineRows } = await supabase
      .from("invoice_lines")
      .select("*")
      .eq("invoice_id", input.invoiceId)
      .order("line_no");
    const lines: InvoiceLineInput[] = ((lineRows ?? []) as Record<string, unknown>[]).map((l) => {
      const meta = { ...((l["metadata"] ?? {}) as Record<string, unknown>) };
      const informational = meta["informational"] === true;
      delete meta["informational"];
      return {
        line_type: l["line_type"] as InvoiceLineInput["line_type"],
        description: String(l["description"] ?? ""),
        sac_code: (l["sac_code"] as string | null) ?? null,
        quantity: Number(l["quantity"] ?? 1),
        unit: (l["unit"] as string | null) ?? null,
        unit_price: Number(l["unit_price"] ?? 0),
        ...(informational ? { informational: true } : {}),
        metadata: meta,
      };
    });
    if (lines.length === 0) return { error: `The lines of ${originalNumber} are missing.` };

    const built = await buildInvoice(supabase, organizationId, {
      kind: "invoice",
      purpose: (orig["purpose"] as InvoicePurpose | null) ?? "adjustment",
      lines,
      supplier,
      payment_id: (orig["payment_id"] as string | null) ?? null,
      related_invoice_id: input.invoiceId,
      period:
        orig["period_start"] && orig["period_end"]
          ? { start: String(orig["period_start"]), end: String(orig["period_end"]) }
          : null,
      roi_snapshot: (orig["roi_snapshot"] as Record<string, unknown> | null) ?? null,
      notes: `Re-issued without GST in place of ${originalNumber} (credit note ${note.number}).`,
      created_by: input.actorId,
    });
    if ("error" in built) return { error: `New invoice not built: ${built.error}` };
    newId = built.invoice_id;
  }

  const issued = await issueInvoice(supabase, newId, { deliver: true });
  if ("error" in issued) return { error: `New invoice not issued: ${issued.error}` };

  // Paid by what the original's payment paid for the base.
  const { data: fresh } = await supabase
    .from("invoices")
    .select("total, amount_paid")
    .eq("id", newId)
    .maybeSingle();
  const newTotal = num(fresh?.["total"]);
  const outstanding = round2(newTotal - num(fresh?.["amount_paid"]));
  if (outstanding > 0) {
    const settled = await markPaid(
      supabase,
      newId,
      (orig["payment_id"] as string | null) ?? null,
      Math.min(outstanding, Math.max(paid - gst, 0) || newTotal),
    );
    if (settled.error) return { error: `New invoice not marked paid: ${settled.error}` };
  }

  // 3. The GST collected goes back to the wallet, once.
  const { data: already, error: ledgerError } = await supabase
    .from("wallet_ledger")
    .select("id")
    .eq("reference_type", "credit_note")
    .eq("reference_id", note.id)
    .eq("entry_type", "credit_note")
    .limit(1);
  if (ledgerError) return { error: "We couldn't check the wallet for an earlier credit." };
  if (!(already as { id: string }[] | null)?.length && gst > 0 && toPaise(gst) > 0) {
    const { data: entryId, error: walletError } = await supabase.rpc("wallet_apply", {
      p_org: organizationId,
      p_type: "credit_note",
      p_amount: gst,
      p_ref_type: "credit_note",
      p_ref_id: note.id,
      p_description: `GST of ${originalNumber} given back — re-issued without GST as ${issued.invoice_number}`,
      p_metadata: {
        invoice_id: input.invoiceId,
        credit_note: note.number,
        reissued_invoice_id: newId,
        reason: "gst_not_registered",
      },
      p_actor: input.actorId,
    });
    if (walletError && walletError.code !== "23505") {
      return { error: `GST not credited to the wallet: ${walletError.message}` };
    }
    if (!walletError) {
      await supabase
        .from("credit_notes")
        .update({ ledger_entry_id: typeof entryId === "string" ? entryId : null })
        .eq("id", note.id);
    }
  }

  await supabase.from("activity_log").insert({
    organization_id: organizationId,
    user_id: input.actorId,
    action: "invoice_reissued_without_gst",
    details: {
      original: originalNumber,
      original_id: input.invoiceId,
      credit_note: note.number,
      invoice: issued.invoice_number,
      invoice_id: newId,
      base,
      gst_credited: gst,
    },
  });

  return {
    original: originalNumber,
    credit_note: note.number,
    invoice_id: newId,
    invoice_number: issued.invoice_number,
    wallet_credit: gst,
  };
}
