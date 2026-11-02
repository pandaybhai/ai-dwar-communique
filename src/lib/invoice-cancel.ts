import { toPaise } from "@/lib/billing";

/**
 * Batch 58: an invoice "cancelled by credit note".
 *
 * An issued invoice is never edited or deleted, and its number stays in the
 * series. When the issued credit notes against it add up to its whole total
 * (to the paisa) and it was never paid in full, it is cancelled: nothing is
 * owed on it, dunning and overdue reminders skip it, and every screen shows
 * "Cancelled (credit note CN/…)" instead of "Due".
 *
 * A paid invoice that was later credited in full (the Batch 55 GST re-issue,
 * a Cashfree refund) keeps its "paid" status: the money moved, and its credit
 * note is shown next to it already.
 *
 * This is computed from invoices + credit_notes every time; nothing is
 * stored, so it can never drift from the notes.
 */

/** Statuses that still ask the buyer for money. */
export const OPEN_INVOICE_STATUSES = ["issued", "partially_paid", "overdue"] as const;

export type CreditNoteLike = {
  invoice_id?: unknown;
  number?: unknown;
  amount?: unknown;
  status?: unknown;
};

export type CreditCover = {
  /** Sum of issued credit notes, in rupees. */
  credited: number;
  /** Their numbers, oldest first as given. */
  numbers: string[];
};

/** Issued credit notes per invoice id. Void notes never count. */
export function creditCoverByInvoice(notes: CreditNoteLike[]): Map<string, CreditCover> {
  const out = new Map<string, { paise: number; numbers: string[] }>();
  for (const n of notes) {
    if (n.status !== undefined && n.status !== "issued") continue;
    const id = String(n.invoice_id ?? "");
    if (!id) continue;
    const entry = out.get(id) ?? { paise: 0, numbers: [] };
    entry.paise += toPaise(Number(n.amount ?? 0));
    if (n.number) entry.numbers.push(String(n.number));
    out.set(id, entry);
  }
  const result = new Map<string, CreditCover>();
  for (const [id, e] of out) result.set(id, { credited: e.paise / 100, numbers: e.numbers });
  return result;
}

/**
 * The credit notes that cancel this invoice, or null when it isn't cancelled:
 * open (issued / part paid / overdue), a total above zero, and issued credit
 * notes covering the whole total.
 */
export function cancellingNotes(
  invoice: { status?: unknown; total?: unknown },
  cover: CreditCover | undefined,
): string[] | null {
  if (!cover) return null;
  const status = String(invoice.status ?? "");
  if (!(OPEN_INVOICE_STATUSES as readonly string[]).includes(status)) return null;
  const totalP = toPaise(Number(invoice.total ?? 0));
  if (!(totalP > 0)) return null;
  return toPaise(cover.credited) >= totalP ? cover.numbers : null;
}

/** "Cancelled (credit note CN/2026-27/00004)" — the words every screen uses. */
export function cancelledLabel(numbers: string[]): string {
  if (numbers.length === 0) return "Cancelled (credit note)";
  return `Cancelled (credit note${numbers.length > 1 ? "s" : ""} ${numbers.join(", ")})`;
}

/** Keeps only the invoices still owed: drops the ones credit notes cancel. */
export function withoutCancelled<T extends { id?: unknown; status?: unknown; total?: unknown }>(
  invoices: T[],
  cover: Map<string, CreditCover>,
): T[] {
  return invoices.filter((i) => cancellingNotes(i, cover.get(String(i.id ?? ""))) === null);
}
