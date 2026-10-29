import type { UsageBucket } from "@/lib/billing";

/**
 * Batch 50: pure helpers for the new Billing and wallet page, kept apart so a
 * test can walk every plan state without a browser.
 */

export type BillingStateNote = {
  state: "trial" | "locked" | "paused" | "past_due" | "cancelled";
  tone: "aiden" | "gold" | "danger";
  title: string;
  body: string;
  /** The one next step. */
  action: string;
  /** Where the step scrolls to on this page… */
  target: "plans" | "invoices";
  /** …or a link instead. */
  href?: string;
};

/**
 * What the workspace's plan state means and the one thing to do about it.
 * The words follow the shell's plan banner (PlanBanner) and the dunning
 * rules: paying the open invoice switches a paused or past-due workspace
 * back on; locked reactivates by paying a plan here. Active (and a trial with
 * a plan already bought) needs no note.
 */
export function billingStateNote(input: {
  planStatus: string | null;
  hasPlan: boolean;
  trialEndsAt: string | null;
  now: number;
}): BillingStateNote | null {
  const status = String(input.planStatus ?? "").toLowerCase();
  if (status === "trial" && !input.hasPlan) {
    const days = input.trialEndsAt
      ? Math.max(0, Math.ceil((new Date(input.trialEndsAt).getTime() - input.now) / 864e5))
      : null;
    return {
      state: "trial",
      tone: "aiden",
      title:
        days === null
          ? "You're on a free trial."
          : days === 0
            ? "Your free trial ends today."
            : `${days} day${days === 1 ? "" : "s"} left in your free trial.`,
      body: "Pick a plan and everything carries over.",
      action: "Choose a plan",
      target: "plans",
    };
  }
  if (status === "locked") {
    return {
      state: "locked",
      tone: "danger",
      title: "This workspace is paused.",
      body: "Reactivate to switch everything back on. Nothing has been deleted.",
      action: "Reactivate",
      target: "plans",
    };
  }
  if (status === "paused") {
    return {
      state: "paused",
      tone: "danger",
      title: "This workspace is paused.",
      body: "Pay the open invoice to switch everything back on.",
      action: "See open invoices",
      target: "invoices",
    };
  }
  if (status === "past_due") {
    return {
      state: "past_due",
      tone: "gold",
      title: "Your plan payment is overdue.",
      body: "Pay the open invoice and everything stays switched on.",
      action: "See open invoices",
      target: "invoices",
    };
  }
  if (status === "cancelled") {
    return {
      state: "cancelled",
      tone: "danger",
      title: "This workspace's plan is cancelled.",
      body: "Write to us to start a plan again.",
      action: "Write to us",
      target: "plans",
      href: "mailto:hello@aidwar.in?subject=Start%20my%20plan%20again",
    };
  }
  return null;
}

/** The month's usage as bars: spent kinds only, largest first, share of the largest. */
export function usageBars(usage: UsageBucket[]): Array<UsageBucket & { share: number }> {
  const spent = usage.filter((b) => Number(b.amount) > 0);
  const top = Math.max(0, ...spent.map((b) => Number(b.amount)));
  return [...spent]
    .sort((a, b) => Number(b.amount) - Number(a.amount))
    .map((b) => ({ ...b, share: top > 0 ? Math.max(2, (Number(b.amount) / top) * 100) : 0 }));
}
