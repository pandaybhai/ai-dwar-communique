import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { UNREACHABLE_CODES } from "@/lib/wa-reachability";
import { indiaDayStart, refusedHeadline } from "@/lib/api-refusals";

/**
 * Batch 63 (B): Home's "Needs attention" item — template messages (API,
 * campaign, flow, Inbox) that couldn't be delivered in the last 24 hours,
 * with how many were numbers not on WhatsApp. Two head counts through the
 * member's own client; nothing when there were none (or a read fails).
 * Shown by SendHealthBanner where it links out (both Homes).
 *
 * Batch 67: also "N API sends were refused today" — Public API requests we
 * refused before sending (public.api_refusals since the start of the India
 * day), one more head count; shown only when N > 0, with or without failures.
 */
export function failedSendsHeadline(failed: number, unreachable: number): string {
  const what = `${failed} template message${failed === 1 ? "" : "s"} couldn't be delivered in the last 24 hours`;
  return unreachable > 0
    ? `${what} — ${unreachable === failed ? (failed === 1 ? "the number isn't" : "the numbers aren't") : `${unreachable} to numbers not`} on WhatsApp`
    : what;
}

export function SendFailuresAttention({
  organizationId,
  className,
}: {
  organizationId: string | null | undefined;
  className?: string | undefined;
}) {
  const [counts, setCounts] = useState<{
    failed: number;
    unreachable: number;
    refused: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!organizationId) return;
    const since = new Date(Date.now() - 864e5).toISOString();
    const base = () =>
      aidwar
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("direction", "outbound")
        .eq("type", "template")
        .eq("status", "failed")
        .gte("created_at", since);
    const today = new Date(indiaDayStart(Date.now())).toISOString();
    void Promise.all([
      base(),
      base().or([...UNREACHABLE_CODES].map((c) => `error_detail.ilike.*${c}*`).join(",")),
      aidwar
        .from("api_refusals")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .gte("created_at", today),
    ]).then(
      ([all, unreachable, refused]) => {
        if (cancelled) return;
        const refusedCount = refused.error ? 0 : (refused.count ?? 0);
        if (all.error && !refusedCount) return;
        setCounts({
          failed: all.error ? 0 : (all.count ?? 0),
          unreachable: unreachable.error ? 0 : (unreachable.count ?? 0),
          refused: refusedCount,
        });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  if (!counts || (counts.failed === 0 && counts.refused === 0)) return null;
  return (
    <div
      role="status"
      data-testid="needs-attention-failed-sends"
      className={[
        "flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-900 shadow-sm dark:text-amber-100",
        className ?? "",
      ].join(" ")}
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="text-sm">
        <p className="font-semibold">Needs attention</p>
        {counts.failed > 0 ? (
          <p className="mt-0.5 opacity-90">
            {failedSendsHeadline(counts.failed, counts.unreachable)}.{" "}
            <Link to="/app/templates" className="font-semibold underline underline-offset-2">
              See them under Templates → Sent
            </Link>
          </p>
        ) : null}
        {counts.refused > 0 ? (
          <p className="mt-0.5 opacity-90" data-testid="needs-attention-refused-sends">
            {refusedHeadline(counts.refused)}: nothing was sent.{" "}
            <Link to="/app/templates" className="font-semibold underline underline-offset-2">
              See them under Templates → Sent (Refused)
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}
