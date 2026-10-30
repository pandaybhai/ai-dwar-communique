import type { ReactNode } from "react";

/**
 * The pricing page's plan helpers and words (moved here unchanged in Batch
 * 50), so the current pricing page and the new one (switch new_site) show the
 * same plans and say exactly the same things.
 */

export type Plan = {
  key: string;
  name: string;
  tagline: string | null;
  currency: string;
  price_monthly: number | null;
  price_annual: number | null;
  limits: Record<string, number>;
  highlights: string[];
};

export const FEATURED = "growth";

export function inr(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

export function limitLine(limits: Record<string, number>): string[] {
  const lines: string[] = [];
  const members = Number(limits["members"] ?? 0);
  const numbers = Number(limits["numbers"] ?? 0);
  const ai = Number(limits["ai_answers"] ?? 0);
  lines.push(members === -1 ? "Unlimited team members" : `${members} team members`);
  lines.push(
    numbers === -1
      ? "Unlimited business numbers"
      : `${numbers} business ${numbers === 1 ? "number" : "numbers"}`,
  );
  lines.push(
    ai === -1 ? "Unlimited AI answers" : `${ai.toLocaleString("en-IN")} AI answers a month`,
  );
  return lines;
}

/** "How message credits work": the three paragraphs, word for word. */
/** Batch 55: gstRegistered false = no GST is charged, so no tax invoice is promised. */
export function CreditsExplained({ gstRegistered = true }: { gstRegistered?: boolean } = {}): ReactNode {
  return (
    <>
      <p>
        Meta charges per conversation, and the rate depends on what you're sending —
        promotions, order updates or one-time passcodes. We pass that through with a clear
        margin, show you the exact rate in your billing page before you send, and never
        bill you for replies inside the 24-hour service window.
      </p>
      <p>
        Credits are prepaid: top up whenever you like, and every campaign tells you what it
        will cost before it goes out. If a campaign would take you below zero, we stop it
        and ask you first.
      </p>
      {gstRegistered ? (
        <p>
          Every payment gets a GST tax invoice with your GSTIN on it, downloadable from your
          billing page. Turn on auto-pay and the plan fee takes care of itself.
        </p>
      ) : (
        <p>
          Every payment gets an invoice, downloadable from your billing page. Turn on auto-pay
          and the plan fee takes care of itself.
        </p>
      )}
    </>
  );
}
