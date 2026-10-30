import { money, type UsageBucket } from "@/lib/billing";
import { STATE_COPY } from "./copy";

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
          ? STATE_COPY.trial.titleUnknown
          : days === 0
            ? STATE_COPY.trial.titleToday
            : STATE_COPY.trial.titleDays(days),
      body: STATE_COPY.trial.body,
      action: STATE_COPY.trial.action,
      target: "plans",
    };
  }
  if (status === "locked") {
    return {
      state: "locked",
      tone: "danger",
      title: STATE_COPY.locked.title,
      body: STATE_COPY.locked.body,
      action: STATE_COPY.locked.action,
      target: "plans",
    };
  }
  if (status === "paused") {
    return {
      state: "paused",
      tone: "danger",
      title: STATE_COPY.paused.title,
      body: STATE_COPY.paused.body,
      action: STATE_COPY.paused.action,
      target: "invoices",
    };
  }
  if (status === "past_due") {
    return {
      state: "past_due",
      tone: "gold",
      title: STATE_COPY.pastDue.title,
      body: STATE_COPY.pastDue.body,
      action: STATE_COPY.pastDue.action,
      target: "invoices",
    };
  }
  if (status === "cancelled") {
    return {
      state: "cancelled",
      tone: "danger",
      title: STATE_COPY.cancelled.title,
      body: STATE_COPY.cancelled.body,
      action: STATE_COPY.cancelled.action,
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

/**
 * Batch 57: an amount the wallet's ticker may count. `text` is money()'s own
 * text; the ticker counts `whole` rupees with "₹" and Indian grouping, and
 * `rest` (the paise, ".50") sits beside it, so where it lands is exactly
 * `text`. Null (show `text` as it is) below zero, in another currency, or
 * for any shape that wouldn't land on the same text.
 */
export function amountParts(
  value: number,
  currency: string,
): { text: string; whole: number; rest: string } | null {
  const text = money(value, currency);
  if (currency !== "INR" || !(value >= 0) || !text.startsWith("₹")) return null;
  const dot = text.lastIndexOf(".");
  if (dot < 0) return null;
  const whole = Number(text.slice(1, dot).replace(/,/g, ""));
  if (!Number.isSafeInteger(whole)) return null;
  const rest = text.slice(dot);
  return "₹" + new Intl.NumberFormat("en-IN").format(whole) + rest === text
    ? { text, whole, rest }
    : null;
}
