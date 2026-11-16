import { AlertTriangle } from "lucide-react";
import { NOTICE_LABEL, type UndeliveredBadge } from "@/lib/notice-delivery";

/**
 * Batch 81: a red "Not delivered" badge on a workspace whose last invoice /
 * receipt / welcome message from AiDwar's number failed at Meta (cleared once
 * a later one is delivered). The title says what, when and why.
 */
export function NotDeliveredBadge({ badge }: { badge: UndeliveredBadge | null | undefined }) {
  if (!badge) return null;
  const what = `${NOTICE_LABEL[badge.kind]}${badge.invoice_number ? ` ${badge.invoice_number}` : ""}`;
  const when = new Date(badge.at).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const title = `${what} not delivered on ${when}: ${badge.error}. Call them.`;
  return (
    <span
      data-testid="not-delivered-badge"
      title={title}
      aria-label={title}
      className="mt-1 inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive"
    >
      <AlertTriangle className="h-3 w-3" aria-hidden />
      Not delivered
    </span>
  );
}
