/**
 * Batch 57: every word the new Billing and wallet page shows, in one place
 * (a later Hindi pass changes this file only).
 *
 * Only the words around the money changed (page line, empty and error
 * states). Everything that states an amount, a price, GST, what a charge is,
 * what is held, a payment's result or a plan's state is Batch 50/55's wording,
 * moved here byte for byte under "Unchanged" below.
 */

export const BILLING_COPY = {
  title: "Billing and wallet",
  description: "Your credits, what each message costs, and every payment and invoice, in one place.",
  loadingLabel: "Loading your billing",
  noWorkspace: {
    title: "Pick a workspace first",
    body: "Choose one from Switch workspace in your profile menu to see its credits and invoices.",
  },
  notOn: {
    title: "Billing isn't on for this workspace yet",
    body: "Credits and invoices for this workspace aren't kept here yet. Write to us if you'd like them switched on.",
    action: "Write to us",
    href: "mailto:hello@aidwar.in?subject=Billing%20for%20my%20workspace",
  },
  restricted: {
    title: "Billing is open to some people only",
    body: "Ask an owner or admin of this workspace to give you the “View billing” permission.",
  },
  loadFailed: {
    title: "Couldn't load your billing",
    body: "Check your internet and tap Try again.",
    retry: "Try again",
  },
  usageEmpty:
    "Nothing spent yet this month. Once you send your first campaign, you'll see here where your credits went.",

  /* ---- Unchanged (Batch 50 / 55): amounts, charges, holds, plans, payments. ---- */
  paymentFailed: "That payment didn't go through. You can try again.",
  walletTitle: "Credits available",
  held: (amount: string) => `${amount} held for campaigns`,
  ready: "Ready to spend",
  lowTitle: "Credits are running low.",
  lowBody: "Top up so your campaigns and replies keep going out.",
  topUp: "Top up",
  requestTopUp: "Request a top-up",
  planFirst: "Pick a plan first — a locked or cancelled workspace can't buy credits.",
  monthTitle: "This month",
  spentSince: (date: string) => `Spent since ${date}`,
  aiAnswers: "AI answers",
  aiIncluded: "Included in your plan this month",
  aiPayAsYouGo: "Charged as you go",
  aiBar: (used: number, included: number) => `${used} of ${included} included AI answers used`,
  yourPlan: "Your plan",
  planPickAbove: "Pick a plan above to start",
  planPerMonth: (price: string) => `${price} a month`,
  planTalk: "Talk to us about a plan",
  planTrial: "Trial — no plan yet",
  planNone: "No plan yet",
  usageTitle: "Where your credits went",
  ratesTitle: "What a message costs you",
  ratesNoGst: "Prices are per message.",
  ratesGst: "Prices are per message, before 18% GST.",
  ratesFree: "Replies inside the 24-hour window are free.",
  plansTitle: "Plans",
  plansChange: "To change your plan, write to",
  currentPlan: "Current plan",
  custom: "Custom",
  perMonth: "/ month",
  plusGst: "+ 18% GST",
  stateLabel: "Plan status",
} as const;

/** What each message kind is, in the rates table (Batch 50, unchanged: it says what a charge is). */
export const CATEGORY_COPY: Record<string, string> = {
  marketing: "Promotions and offers",
  utility: "Order and account updates",
  authentication: "One-time passcodes",
  service: "Replies inside the 24-hour window",
};

/**
 * The plan-state notes (billing-v2.ts billingStateNote). Batch 50 wording,
 * unchanged: they follow the shell's plan banner and the dunning rules.
 */
export const STATE_COPY = {
  trial: {
    titleUnknown: "You're on a free trial.",
    titleToday: "Your free trial ends today.",
    titleDays: (days: number) => `${days} day${days === 1 ? "" : "s"} left in your free trial.`,
    body: "Pick a plan and everything carries over.",
    action: "Choose a plan",
  },
  locked: {
    title: "This workspace is paused.",
    body: "Reactivate to switch everything back on. Nothing has been deleted.",
    action: "Reactivate",
  },
  paused: {
    title: "This workspace is paused.",
    body: "Pay the open invoice to switch everything back on.",
    action: "See open invoices",
  },
  pastDue: {
    title: "Your plan payment is overdue.",
    body: "Pay the open invoice and everything stays switched on.",
    action: "See open invoices",
  },
  cancelled: {
    title: "This workspace's plan is cancelled.",
    body: "Write to us to start a plan again.",
    action: "Write to us",
  },
} as const;
