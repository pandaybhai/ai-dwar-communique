/**
 * Client-side shapes and wording for cash-on-delivery confirmation.
 *
 * Everything a merchant reads about COD comes from here, so the promise the UI
 * makes stays exactly what the product does: we record what the customer said,
 * and nothing more. AiDwar cannot cancel or change the order in Shopify.
 */

export type CodStatus = "pending" | "confirmed" | "cancelled" | "no_response";

export type CodRow = {
  id: string;
  order_id: string;
  status: CodStatus;
  asked_at: string | null;
  responded_at: string | null;
  created_at: string;
  orders?: {
    order_number: string | null;
    total: number | null;
    currency: string | null;
    external_id: string | null;
    integration_id: string | null;
  } | null;
  contacts?: { name: string | null; phone: string } | null;
};

export const COD_STATUS_LABELS: Record<CodStatus, string> = {
  pending: "Waiting for an answer",
  confirmed: "Customer confirmed",
  cancelled: "Customer said don't ship",
  no_response: "No answer in 24 hours",
};

/** Status is never carried by colour alone — each one keeps its own words. */
export const COD_STATUS_CLASSES: Record<CodStatus, string> = {
  pending: "border-border bg-muted text-foreground",
  confirmed: "border-emerald-600/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  cancelled: "border-destructive/40 bg-destructive/10 text-destructive",
  no_response: "border-amber-600/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
};

export type CodTotals = {
  asked: number;
  confirmed: number;
  cancelled: number;
  noResponse: number;
  pending: number;
  /** Money in orders the customer told us not to ship. */
  cancelledValue: number;
  /** Money in orders nobody answered for. */
  noResponseValue: number;
  currency: string | null;
};

export function summarise(rows: CodRow[]): CodTotals {
  const totals: CodTotals = {
    asked: 0,
    confirmed: 0,
    cancelled: 0,
    noResponse: 0,
    pending: 0,
    cancelledValue: 0,
    noResponseValue: 0,
    currency: null,
  };
  for (const row of rows) {
    if (row.asked_at) totals.asked += 1;
    const value = Number(row.orders?.total ?? 0) || 0;
    if (row.orders?.currency && !totals.currency) totals.currency = row.orders.currency;
    if (row.status === "confirmed") totals.confirmed += 1;
    if (row.status === "pending") totals.pending += 1;
    if (row.status === "cancelled") {
      totals.cancelled += 1;
      totals.cancelledValue += value;
    }
    if (row.status === "no_response") {
      totals.noResponse += 1;
      totals.noResponseValue += value;
    }
  }
  return totals;
}

/** Share of asked orders the customer confirmed. Null when nobody was asked. */
export function confirmationRate(totals: CodTotals): number | null {
  if (totals.asked === 0) return null;
  return Math.round((totals.confirmed / totals.asked) * 100);
}

export function formatMoney(value: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency ?? ""} ${Math.round(value).toLocaleString()}`.trim();
  }
}

/** Deep link to the order in the merchant's own Shopify admin. */
export function shopifyOrderUrl(
  shopDomain: string | null | undefined,
  externalId: string | null | undefined,
): string | null {
  if (!shopDomain || !externalId) return null;
  return `https://${shopDomain}/admin/orders/${externalId}`;
}

export const COD_PERIODS = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
] as const;
