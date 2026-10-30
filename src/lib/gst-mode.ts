import { withGst } from "@/lib/billing";

/**
 * Batch 55: whether AiDwar charges GST at all.
 *
 * Meezoy Ventures is not GST-registered yet. Until platform_settings.gst_registered
 * is true (switched in Super Admin, only with a real supplier GSTIN), no GST is
 * added anywhere: a plan fee, a credit pack or a payment link charges the base
 * price exactly, and a new invoice is a plain "Invoice" with no GST, no GSTIN
 * and the not-registered line. Registered, every figure is today's withGst()
 * exactly. Client-safe: no server imports.
 */

/** The placeholder supplier identity that went out on invoices before Batch 55. */
export const DEMO_SUPPLIER_GSTIN = "36AAACM0000D1Z5";
export const DEMO_SUPPLIER_PAN = "AAACM0000D";

/** Printed on every no-GST invoice. */
export const NOT_REGISTERED_LINE = "Supplier not registered under GST; no GST charged.";

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

const clean = (value: string | null | undefined) =>
  String(value ?? "")
    .trim()
    .toUpperCase();

/** The pre-Batch-55 demo GSTIN. */
export function isDemoGstin(value: string | null | undefined): boolean {
  return clean(value) === DEMO_SUPPLIER_GSTIN;
}

/** A GSTIN that may go on a tax invoice: well formed and not the demo one. */
export function isRealGstin(value: string | null | undefined): boolean {
  const v = clean(value);
  return v !== "" && v !== DEMO_SUPPLIER_GSTIN && GSTIN_PATTERN.test(v);
}

/** A PAN that may be printed: set and not the demo one. */
export function isRealPan(value: string | null | undefined): boolean {
  const v = clean(value);
  return v !== "" && v !== DEMO_SUPPLIER_PAN && PAN_PATTERN.test(v);
}

/**
 * Only an explicit true is registered: a missing row, a missing column
 * (20261290 not applied) or any other value means no GST.
 */
export function gstRegisteredFrom(row: Record<string, unknown> | null | undefined): boolean {
  return row?.["gst_registered"] === true;
}

/**
 * What a base price costs the customer. Registered: withGst() exactly (today's
 * figures, to the paisa). Not registered: the base price, nothing added.
 */
export function chargeFor(
  amount: number,
  registered: boolean,
): { base: number; gst: number; total: number } {
  if (registered) return withGst(amount);
  const { base } = withGst(amount);
  return { base, gst: 0, total: base };
}

/**
 * Why Super Admin may not switch GST on, or null when it may: a real GSTIN
 * must be on file first.
 */
export function gstSwitchBlock(supplierGstin: string | null | undefined): string | null {
  const v = clean(supplierGstin);
  if (!v) return "Enter the company's real GSTIN first — GST can't be charged without one.";
  if (v === DEMO_SUPPLIER_GSTIN) {
    return "That is the demo GSTIN. Enter the GSTIN from the registration certificate first.";
  }
  if (!GSTIN_PATTERN.test(v)) {
    return "That GSTIN doesn't look right — it should be 15 characters, like 36AAAAA0000A1Z5.";
  }
  return null;
}

/** "[DEMO GSTIN …]" (any wording inside the brackets) taken out of a footer. */
export function stripDemoFooter(footer: string | null | undefined): string | null {
  if (footer === null || footer === undefined) return null;
  const out = footer
    .replace(/\s*\[\s*DEMO\s+GSTIN[^\]]*\]\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out === "" ? null : out;
}
