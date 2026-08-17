import { IndianRupee, Megaphone, Workflow } from "lucide-react";
import { ChartCard } from "@/components/analytics/chart-card";
import { Badge } from "@/components/ui/badge";
import type { AttributionSourceRow, AttributionSummary } from "@/lib/analytics";

/**
 * "Sales from messages" — plain language throughout, and deliberately honest:
 * sales we couldn't link to a message are shown next to the ones we could, at
 * the same size. No ROAS is displayed because we hold no message cost data;
 * revenue per message sent is shown instead and labelled as exactly that.
 */

function money(amount: number, currency: string | null): string {
  const value = Number(amount) || 0;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency ?? ""} ${value.toLocaleString()}`.trim();
  }
}

function hours(value: number | null): string {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (n < 1) return `${Math.round(n * 60)} minutes`;
  if (n < 48) return `${n.toFixed(1)} hours`;
  return `${(n / 24).toFixed(1)} days`;
}

export function AnalyticsRevenue({
  summary,
  sources,
  loading,
}: {
  summary: AttributionSummary | null;
  sources: AttributionSourceRow[];
  loading: boolean;
}) {
  const currency = summary?.currency ?? null;
  const attributed = Number(summary?.revenue_attributed ?? 0);
  const unattributed = Number(summary?.revenue_unattributed ?? 0);
  const total = attributed + unattributed;
  const share = total > 0 ? Math.round((attributed / total) * 100) : 0;
  const active = sources.filter((s) => Number(s.messages_sent) > 0 || Number(s.orders) > 0);

  return (
    <div className="space-y-6">
      <ChartCard
        title="Sales we could link to a message"
        description={`We count a sale as coming from a message when the customer got a promotional message from you in the ${summary?.window_hours ?? 72} hours before they ordered. Order confirmations and other service messages never take credit.`}
        loading={loading}
        isEmpty={(summary?.orders_total ?? 0) === 0}
        emptyIcon={IndianRupee}
        emptyTitle="No orders in this period"
        emptyDescription="Once your store sends orders through, we'll show which of them followed one of your messages."
      >
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
              <p className="text-xs font-medium text-muted-foreground">Sales from your messages</p>
              <p className="mt-1 text-2xl font-semibold text-foreground">
                {money(attributed, currency)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {Number(summary?.orders_attributed ?? 0).toLocaleString()} order
                {Number(summary?.orders_attributed ?? 0) === 1 ? "" : "s"}
              </p>
            </div>
            <div className="rounded-xl border border-border/70 bg-muted/40 p-4">
              <p className="text-xs font-medium text-muted-foreground">
                We couldn&rsquo;t link these sales to any message
              </p>
              <p className="mt-1 text-2xl font-semibold text-foreground">
                {money(unattributed, currency)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {Number(summary?.orders_unattributed ?? 0).toLocaleString()} order
                {Number(summary?.orders_unattributed ?? 0) === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          <div>
            <div
              className="flex h-2.5 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${share}% of sales in this period came from your messages`}
            >
              <div
                className="bg-primary transition-all duration-500"
                style={{ width: `${share}%` }}
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {share}% of the {money(total, currency)} you took in this period followed one of your
              messages. Typical time from message to order: {hours(summary?.median_hours_to_conversion ?? null)}.
            </p>
          </div>
        </div>
      </ChartCard>

      <ChartCard
        title="Which messages brought in sales"
        description="Campaigns and flows side by side. We show sales for every message you sent — never an estimated return, because we don't hold what each message cost you."
        loading={loading}
        isEmpty={active.length === 0}
        emptyIcon={Megaphone}
        emptyTitle="No campaign or flow messages sent yet"
        emptyDescription="Send a campaign or switch on a flow, and any sales that follow will show up here."
      >
        <div className="space-y-3">
          {active.map((row) => {
            const sent = Number(row.messages_sent);
            const orders = Number(row.orders);
            const revenue = Number(row.revenue);
            const rate = sent > 0 ? (orders / sent) * 100 : 0;
            const perMessage = sent > 0 ? revenue / sent : 0;
            const Icon = row.source_type === "flow" ? Workflow : Megaphone;

            return (
              <div
                key={`${row.source_type}-${row.source_id}`}
                className="rounded-xl border border-border/70 bg-card p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <p className="font-medium text-foreground">{row.name}</p>
                    <Badge variant="outline">
                      {row.source_type === "flow" ? "Automatic message" : "Campaign"}
                    </Badge>
                  </div>
                  <p className="text-sm font-semibold text-foreground">
                    {money(revenue, row.currency ?? currency)}
                  </p>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground">Messages sent</dt>
                    <dd className="font-medium text-foreground">{sent.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Sales from this message</dt>
                    <dd className="font-medium text-foreground">{orders.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Bought after getting it</dt>
                    <dd className="font-medium text-foreground">{rate.toFixed(1)}%</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Sales per message sent</dt>
                    <dd className="font-medium text-foreground">
                      {sent > 0 ? money(perMessage, row.currency ?? currency) : "—"}
                    </dd>
                  </div>
                </dl>

                <p className="mt-3 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  Typical time from message to order: {hours(row.median_hours)}
                </p>
              </div>
            );
          })}
        </div>
      </ChartCard>
    </div>
  );
}
