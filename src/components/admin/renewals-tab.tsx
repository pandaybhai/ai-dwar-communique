import { useCallback, useEffect, useState } from "react";
import { CalendarClock, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/data-pagination";
import { callApi } from "@/lib/whatsapp-client";
import { money } from "@/lib/billing";
import { daysLeft, periodDate, type RenewalRow } from "@/lib/renewals";
import { cn } from "@/lib/utils";

/**
 * Batch 82: Admin → Billing → Renewals due — every workspace with an access
 * period (organizations.plan_period_ends_at), soonest end first, for the team
 * to call: the owner's first name and only the last 4 digits of the phone.
 */
export function RenewalsTab() {
  const [rows, setRows] = useState<RenewalRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await callApi<{ rows: RenewalRow[] }>("/api/admin/billing", {
      body: { action: "renewals" },
    });
    setLoading(false);
    if (err || !data) {
      setError(err ?? "We couldn't load renewals.");
      return;
    }
    setError(null);
    setRows(data.rows);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <ErrorState message={error} />;
  if (!rows) return <TableSkeleton rows={5} />;
  return <RenewalsTable rows={rows} onRefresh={() => void load()} loading={loading} />;
}

/** The table itself (also rendered by the tests and screenshots). */
export function RenewalsTable({
  rows,
  onRefresh,
  loading = false,
  now = Date.now(),
}: {
  rows: RenewalRow[];
  onRefresh?: () => void;
  loading?: boolean;
  now?: number;
}) {
  return (
    <div className="space-y-3" data-testid="renewals-tab">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Access periods ending soonest first. Nothing renews or locks by itself — call them.
        </p>
        {onRefresh ? (
          <Button variant="outline" size="sm" className="rounded-full" onClick={onRefresh}>
            <RefreshCw className={cn("mr-2 h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </Button>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No renewals due"
          description="Workspaces show up here once they have paid a plan fee."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-background shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Workspace</th>
                  <th className="px-4 py-3 font-medium">Owner</th>
                  <th className="px-4 py-3 font-medium">Phone</th>
                  <th className="px-4 py-3 font-medium">Access ends</th>
                  <th className="px-4 py-3 text-right font-medium">Last paid</th>
                  <th className="px-4 py-3 font-medium">Offer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {rows.map((r) => {
                  const left = daysLeft(r.plan_period_ends_at, now);
                  return (
                    <tr key={r.organization_id} data-testid="renewal-row">
                      <td className="px-4 py-3 font-medium text-foreground">{r.name}</td>
                      <td className="px-4 py-3">{r.owner_first_name}</td>
                      <td className="px-4 py-3 tabular-nums">{r.phone_last4}</td>
                      <td className="px-4 py-3">
                        <div>{periodDate(r.plan_period_ends_at)}</div>
                        <div
                          className={cn(
                            "text-xs",
                            left <= 5 ? "font-semibold text-destructive" : "text-muted-foreground",
                          )}
                        >
                          {left < 0
                            ? `ended ${-left} day${left === -1 ? "" : "s"} ago`
                            : left === 0
                              ? "ends today"
                              : `${left} day${left === 1 ? "" : "s"} left`}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {r.last_amount === null ? "—" : money(r.last_amount)}
                      </td>
                      <td className="px-4 py-3">
                        {r.offer === "paid_trial_199" ? (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-800">
                            ₹199 paid trial
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{r.offer ?? "—"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
