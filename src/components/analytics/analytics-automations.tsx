import { Bot } from "lucide-react";
import { ChartCard } from "@/components/analytics/chart-card";
import type { AutomationRow } from "@/lib/analytics";
import { Badge } from "@/components/ui/badge";

function reasonLabel(reason: string): string {
  return reason.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function AnalyticsAutomations({
  rows,
  loading,
}: {
  rows: AutomationRow[];
  loading: boolean;
}) {
  const active = rows.filter((r) => Number(r.runs) > 0);

  return (
    <ChartCard
      title="Automation runs"
      description="Every trigger evaluation, split into messages actually sent and runs deliberately skipped."
      loading={loading}
      isEmpty={active.length === 0}
      emptyIcon={Bot}
      emptyTitle="No automation runs in this period"
      emptyDescription="Turn on a welcome, keyword or away-hours automation and every run will be accounted for here."
    >
      <div className="space-y-4">
        {active.map((row) => {
          const runs = Number(row.runs) || 1;
          const sent = Number(row.sent);
          const skipped = Number(row.skipped);
          const failed = Number(row.failed);
          const reasons = Object.entries(row.skip_reasons ?? {}).sort(
            (a, b) => Number(b[1]) - Number(a[1]),
          );

          return (
            <div
              key={row.automation_id}
              className="rounded-xl border border-border/70 bg-card p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-foreground">{row.name}</p>
                  <Badge variant={row.is_active ? "secondary" : "outline"}>
                    {row.is_active ? "Active" : "Paused"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  {Number(row.runs).toLocaleString()} run{Number(row.runs) === 1 ? "" : "s"}
                </p>
              </div>

              <div className="mt-3 flex h-2.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="bg-primary transition-all duration-500"
                  style={{ width: `${(sent / runs) * 100}%` }}
                />
                <div
                  className="bg-amber-400 transition-all duration-500"
                  style={{ width: `${(skipped / runs) * 100}%` }}
                />
                <div
                  className="bg-destructive transition-all duration-500"
                  style={{ width: `${(failed / runs) * 100}%` }}
                />
              </div>

              <div className="mt-2 flex flex-wrap gap-4 text-xs text-muted-foreground">
                <span>
                  <span className="font-semibold text-primary">{sent}</span> sent
                </span>
                <span>
                  <span className="font-semibold text-amber-500">{skipped}</span> skipped
                </span>
                {failed > 0 ? (
                  <span>
                    <span className="font-semibold text-destructive">{failed}</span> failed
                  </span>
                ) : null}
              </div>

              {reasons.length > 0 ? (
                <ul className="mt-3 space-y-1 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                  {reasons.map(([reason, count]) => (
                    <li key={reason}>
                      <span className="font-medium text-foreground">{Number(count)}</span>{" "}
                      {reasonLabel(reason)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
}
