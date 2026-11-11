import { round2 } from "@/lib/billing";
import { chargeFor } from "@/lib/gst-mode";

/**
 * Batch 68: a plan fee paid outside the payment gateway (bank transfer, UPI,
 * cheque, cash) and recorded by a Super Admin. Pure: the periods, the figures
 * and the words the sheet and the server share. The writes are in
 * plan-payment.server.ts.
 */

export const PLAN_PAYMENT_METHODS = [
  { value: "bank_transfer", label: "Bank transfer" },
  { value: "upi", label: "UPI" },
  { value: "cheque", label: "Cheque" },
  { value: "cash", label: "Cash" },
] as const;

export type PlanPaymentMethod = (typeof PLAN_PAYMENT_METHODS)[number]["value"];

export function isPlanPaymentMethod(value: unknown): value is PlanPaymentMethod {
  return PLAN_PAYMENT_METHODS.some((m) => m.value === value);
}

export function methodLabel(value: string): string {
  return PLAN_PAYMENT_METHODS.find((m) => m.value === value)?.label ?? value;
}

/** A real calendar date written YYYY-MM-DD. */
export function isDateOnly(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The same date next month, kept inside that month (31 Jan → 28 Feb), so a
 * period never skips a month.
 */
export function sameDateNextMonth(start: string): string {
  const d = new Date(`${start}T00:00:00Z`);
  const day = d.getUTCDate();
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0)).getUTCDate();
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, Math.min(day, last))));
}

/**
 * One month of the plan: from the start date to the day before the same date
 * next month (10 Nov → 9 Dec), and the next period's start.
 */
export function planPeriod(start: string): { start: string; end: string; next_start: string } {
  const next = sameDateNextMonth(start);
  const end = new Date(`${next}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() - 1);
  return { start, end: iso(end), next_start: next };
}

/** The billing day the next run invoices on: the period's day, at most 28 (as Settings allows). */
export function billingDayFor(start: string): number {
  return Math.min(Number(start.slice(8, 10)), 28);
}

/** The most recent date on `billingDay` that is not after `today` (the current period's start). */
export function currentPeriodStart(billingDay: number, today: string): string {
  const t = new Date(`${today}T00:00:00Z`);
  const at = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(Math.max(billingDay, 1), last)));
  };
  const thisMonth = at(t.getUTCFullYear(), t.getUTCMonth());
  return iso(thisMonth <= t ? thisMonth : at(t.getUTCFullYear(), t.getUTCMonth() - 1));
}

export type PlanFeeInvoiceRow = {
  period_start: string | null;
  status: string;
  total: number;
  amount_paid: number;
};

/**
 * The period the sheet offers first: the oldest plan-fee invoice still unpaid;
 * else the period after the latest paid one; else the current period on the
 * workspace's billing day.
 */
export function defaultPeriodStart(
  invoices: PlanFeeInvoiceRow[],
  billingDay: number,
  today: string,
): string {
  const live = invoices.filter((i) => i.status !== "void" && isDateOnly(i.period_start));
  const open = live
    .filter((i) => round2(Number(i.amount_paid ?? 0)) + 0.01 < Number(i.total ?? 0))
    .map((i) => i.period_start as string)
    .sort();
  if (open.length) return open[0]!;
  const paid = live.map((i) => i.period_start as string).sort();
  if (paid.length) return sameDateNextMonth(paid[paid.length - 1]!);
  return currentPeriodStart(billingDay, today);
}

export type PlanPaymentFigures = {
  base: number;
  gst: number;
  total: number;
  received: number;
  /** received − what is owed on the invoice: + over, − short. */
  difference: number;
  /** What goes onto the invoice now. */
  applied: number;
  /** Received beyond the invoice: left unapplied, never put in the wallet. */
  excess: number;
  /** Still owed on the invoice after this payment. */
  short: number;
};

/**
 * The money of one recorded payment. `owed` is what the invoice still wants
 * (its total less what it was already paid); without an invoice yet, the plan
 * fee under the current GST mode.
 */
export function planPaymentFigures(input: {
  base: number;
  gstRegistered: boolean;
  received: number;
  owed?: number | null;
}): PlanPaymentFigures {
  const charge = chargeFor(input.base, input.gstRegistered);
  const owed = round2(input.owed ?? charge.total);
  const received = round2(input.received);
  const applied = round2(Math.max(0, Math.min(owed, received)));
  return {
    base: charge.base,
    gst: charge.gst,
    total: charge.total,
    received,
    difference: round2(received - owed),
    applied,
    excess: round2(Math.max(0, received - applied)),
    short: round2(Math.max(0, owed - applied)),
  };
}

/** "Rs 1.00 over: left unapplied (not added to the wallet)." / "Rs 99.00 short: the invoice stays part paid." */
export function differenceText(f: PlanPaymentFigures, money: (n: number) => string): string | null {
  if (f.excess > 0) return `${money(f.excess)} over: left unapplied (not added to the wallet).`;
  if (f.short > 0) return `${money(f.short)} short: the invoice stays part paid.`;
  return null;
}

/** What the Super Admin sheet shows before saving (planPaymentPreview). */
export type PlanPaymentPreview = {
  organization_name: string;
  plan_name: string;
  plan_version: string | null;
  plan_status: string | null;
  trial_ends_at: string | null;
  billing_day: number;
  new_billing_day: number;
  default_period_start: string;
  period: { start: string; end: string; next_start: string };
  plan_fee: number;
  fee_from: "override" | "plan";
  gst_registered: boolean;
  figures: PlanPaymentFigures;
  invoice: {
    id: string;
    invoice_number: string | null;
    status: string;
    total: number;
    amount_paid: number;
    open_payment_link: boolean;
  } | null;
  already_recorded: { payment_id: string; reference: string } | null;
  billing_enabled: boolean;
  warnings: string[];
};

export type RecordPlanPaymentResult =
  | {
      ok: true;
      already: boolean;
      payment_id: string;
      invoice_id: string;
      invoice_number: string | null;
      invoice_status: string;
      period: { start: string; end: string };
      applied: number;
      excess: number;
      short: number;
      billing_day: number;
      delivered: boolean;
    }
  | { error: string };

/** "10 Nov 2026" for a YYYY-MM-DD date. */
export function dayText(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
