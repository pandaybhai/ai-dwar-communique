/**
 * Shared, client-safe billing types and money formatting.
 *
 * Money is rupees as a number with up to four decimals (message rates are
 * paise-fractional). Never compare with a truthiness check — ₹0 is a real
 * balance and a real rate.
 */

export const GST_RATE = 0.18;

export type MessageCategory = "marketing" | "utility" | "authentication" | "service";

export const MESSAGE_CATEGORIES: MessageCategory[] = [
  "marketing",
  "utility",
  "authentication",
  "service",
];

export type WalletSummary = {
  balance: number;
  held: number;
  available: number;
  currency: string;
  lifetime_purchased: number;
  lifetime_consumed: number;
};

export type PlanSummary = {
  key: string | null;
  name: string | null;
  tagline: string | null;
  status: string | null;
  price_monthly: number | null;
  limits: Record<string, number>;
  highlights: string[];
  trial_ends_at: string | null;
  billing_day: number | null;
};

export type UsageBucket = {
  category: "messaging" | "automation" | "inbox" | "ai";
  label: string;
  amount: number;
  count: number;
};

export type ClientRate = {
  category: MessageCategory;
  rate: number | null;
  currency: string;
};

export type LedgerEntry = {
  id: string;
  entry_type: string;
  amount: number;
  balance_after: number;
  currency: string;
  description: string | null;
  reference_type: string | null;
  created_at: string;
};

export type CreditPack = {
  id: string;
  name: string;
  amount: number;
  bonus_amount: number;
  currency: string;
};

export type BillingSummary = {
  organization_id: string;
  enabled: boolean;
  wallet: WalletSummary;
  plan: PlanSummary;
  ai_answers: { included: number; used: number };
  usage: UsageBucket[];
  usage_total: number;
  rates: ClientRate[];
  packs: CreditPack[];
  settings: {
    low_credit_threshold: number;
    auto_topup_enabled: boolean;
    monthly_budget_cap: number | null;
    campaign_approval_threshold: number | null;
    overdraft_limit: number;
    credits_expire_months: number;
  };
  billing_account: {
    id: string | null;
    name: string | null;
    gstin: string | null;
    billing_email: string | null;
    state_code: string | null;
  };
  period: { start: string; end: string };
};

const INR = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  maximumFractionDigits: 2,
});

/** ₹1,234.50 — always shows the symbol, even for zero. */
export function money(value: number | null | undefined, currency = "INR"): string {
  const amount = Number(value ?? 0);
  if (currency !== "INR") {
    return new Intl.NumberFormat("en-IN", { style: "currency", currency }).format(amount);
  }
  return INR.format(amount);
}

/** Rates run to fractions of a paisa; show four decimals so they stay honest. */
export function rateMoney(value: number | null | undefined, currency = "INR"): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(Number(value));
}

export function withGst(amount: number): { base: number; gst: number; total: number } {
  const base = round2(amount);
  const gst = round2(base * GST_RATE);
  return { base, gst, total: round2(base + gst) };
}

export function round2(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function round4(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

/** Plain-language ledger labels — the client never sees an entry_type string. */
export const LEDGER_LABELS: Record<string, string> = {
  credit_purchase: "Credits bought",
  bonus_credits: "Bonus credits",
  starter_credits: "Starter credits",
  coupon_credits: "Coupon credits",
  debit_message: "Messages sent",
  debit_ai: "AI answers",
  debit_addon: "Add-on",
  hold: "Held for a campaign",
  hold_release: "Hold released",
  refund: "Refund",
  adjustment: "Adjustment",
  expiry: "Credits expired",
};

export function ledgerLabel(entryType: string): string {
  return LEDGER_LABELS[entryType] ?? entryType.replace(/_/g, " ");
}

export type CampaignCostEstimate = {
  enabled: boolean;
  recipients: number;
  category: MessageCategory;
  rate: number;
  currency: string;
  estimate: number;
  available: number;
  shortfall: number;
  can_send: boolean;
  needs_approval: boolean;
  approval_threshold: number | null;
  daily_limit: number | null;
  over_daily_limit: boolean;
  days_needed: number;
};
