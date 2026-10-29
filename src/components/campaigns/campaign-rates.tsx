import {
  CAMPAIGN_STATUS_CLASSES,
  CAMPAIGN_STATUS_LABELS,
  percent,
  type CampaignRow,
} from "@/lib/campaigns";
import { cn } from "@/lib/utils";

/**
 * Batch 41: the small pieces a campaign is drawn with — on the list, the
 * results page and Home. Presentation only; every number is one the campaign
 * row already carries.
 */

export const count = new Intl.NumberFormat("en-IN");

/** A status chip; a live campaign's dot pulses. */
export function CampaignStatusBadge({ status }: { status: CampaignRow["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        CAMPAIGN_STATUS_CLASSES[status],
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full bg-current",
          status === "sending" && "motion-safe:animate-pulse",
        )}
      />
      {CAMPAIGN_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * "2,630/4,210" with a bar — sent out of everyone in the audience; sends that
 * failed show as a red end of the bar.
 */
export function ProgressCell({
  sent,
  failed,
  total,
  wide,
}: {
  sent: number;
  failed: number;
  total: number;
  wide?: boolean;
}) {
  const ok = total > 0 ? Math.min(100, (sent / total) * 100) : 0;
  const bad = total > 0 ? Math.min(100 - ok, (failed / total) * 100) : 0;
  return (
    <div className={cn("flex items-center gap-3", wide && "w-full")}>
      <div
        className={cn(
          "flex h-1.5 overflow-hidden rounded-full bg-muted",
          wide ? "flex-1" : "w-24 shrink-0",
        )}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent(sent + failed, total)}
        aria-label="Sent so far"
      >
        <div
          className="h-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${ok}%` }}
        />
        <div
          className="h-full bg-danger transition-[width] duration-500 ease-out"
          style={{ width: `${bad}%` }}
        />
      </div>
      <span className="tabular whitespace-nowrap text-xs text-muted-foreground">
        {count.format(sent)}/{count.format(total)}
      </span>
    </div>
  );
}

const RATE_TONE = {
  delivered: "bg-brand-500",
  read: "bg-primary",
  replied: "bg-chart-4",
} as const;

/** One rate as a number over a hairline bar (the list's Delivered / Read / Replied). */
export function RateBar({
  kind,
  part,
  total,
  label,
  labelled,
  pending,
  className,
}: {
  kind: keyof typeof RATE_TONE;
  part: number;
  total: number;
  label: string;
  /** Show the label above the number (where there's no column header). */
  labelled?: boolean | undefined;
  /** Nothing has been sent yet: a dash, not a misleading 0%. */
  pending?: boolean | undefined;
  className?: string | undefined;
}) {
  const value = percent(part, total);
  if (pending)
    return (
      <div className={cn("min-w-0", className)}>
        {labelled ? (
          <div className="text-2xs text-muted-foreground" aria-hidden="true">
            {label}
          </div>
        ) : null}
        <div className="text-sm text-faint">
          —<span className="sr-only"> {label.toLowerCase()}: nothing sent yet</span>
        </div>
        <div className="mt-1 h-1 rounded-full bg-muted" aria-hidden="true" />
      </div>
    );
  return (
    <div
      className={cn("min-w-0", className)}
      title={`${count.format(part)} ${label.toLowerCase()}`}
    >
      {labelled ? (
        <div className="text-2xs text-muted-foreground" aria-hidden="true">
          {label}
        </div>
      ) : null}
      <div className="tabular text-sm font-medium text-foreground">
        {value}%
        <span className="sr-only">
          {" "}
          {label.toLowerCase()} ({count.format(part)})
        </span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            RATE_TONE[kind],
          )}
          style={{ width: `${Math.min(100, value)}%` }}
        />
      </div>
    </div>
  );
}

/** Delivered, read and replied side by side, each as a share of the audience. */
export function RateBars({
  campaign,
  labelled,
  className,
}: {
  campaign: CampaignRow;
  labelled?: boolean | undefined;
  className?: string | undefined;
}) {
  const total = campaign.total_recipients;
  const pending = campaign.sent_count === 0;
  return (
    <div className={cn("grid grid-cols-3 gap-3", className)}>
      <RateBar
        kind="delivered"
        label="Delivered"
        part={campaign.delivered_count}
        total={total}
        labelled={labelled}
      />
      <RateBar
        kind="read"
        label="Read"
        part={campaign.read_count}
        total={total}
        labelled={labelled}
      />
      <RateBar
        kind="replied"
        label="Replied"
        part={campaign.replied_count}
        total={total}
        labelled={labelled}
      />
    </div>
  );
}
