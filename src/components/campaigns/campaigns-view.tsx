import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Megaphone, Plus } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import {
  CAMPAIGN_STATUS_CLASSES,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_ORDER,
  percent,
  type CampaignRow,
} from "@/lib/campaigns";
import { formatDate } from "@/lib/contacts";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/data-pagination";
import { CampaignWizard } from "@/components/campaigns/campaign-wizard";
import { useAppCommand } from "@/lib/app-commands";
import { QualityBanner } from "@/components/whatsapp-quality-banner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/hooks/use-permissions";

const count = new Intl.NumberFormat("en-IN");

/** Batch 41: a status chip; a live campaign's dot pulses. */
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
        className={cn("h-1.5 w-1.5 rounded-full bg-current", status === "sending" && "animate-pulse")}
      />
      {CAMPAIGN_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * "2,630/4,210" with a bar — sent out of everyone in the audience; sends that
 * failed show as a red end of the bar.
 */
export function ProgressCell({ sent, failed, total, wide }: { sent: number; failed: number; total: number; wide?: boolean }) {
  const ok = total > 0 ? Math.min(100, (sent / total) * 100) : 0;
  const bad = total > 0 ? Math.min(100 - ok, (failed / total) * 100) : 0;
  return (
    <div className={cn("flex items-center gap-3", wide && "w-full")}>
      <div
        className={cn("flex h-1.5 overflow-hidden rounded-full bg-muted", wide ? "flex-1" : "w-24 shrink-0")}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent(sent + failed, total)}
        aria-label="Sent so far"
      >
        <div className="h-full bg-primary transition-[width] duration-500 ease-out" style={{ width: `${ok}%` }} />
        <div className="h-full bg-danger transition-[width] duration-500 ease-out" style={{ width: `${bad}%` }} />
      </div>
      <span className="tabular whitespace-nowrap text-xs text-muted-foreground">
        {count.format(sent)}/{count.format(total)}
      </span>
    </div>
  );
}

export function CampaignsView({
  organizationId,
  timezone,
  role,
}: {
  organizationId: string;
  timezone: string;
  role: string | null;
}) {
  const { can } = usePermissions();
  const isAdmin = can("campaigns.create");
  void role;
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Batch 39: "New campaign" in the command palette opens the same wizard.
  useAppCommand("new-campaign", () => {
    if (isAdmin) setWizardOpen(true);
  });
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const load = useCallback(async () => {
    setError(null);
    const { data, error: qErr } = await aidwar
      .from("campaigns")
      .select("*")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });
    if (qErr) setError("We couldn't load your campaigns. Please try again.");
    else setRows((data ?? []) as CampaignRow[]);
    setLoading(false);
  }, [organizationId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const visible =
    statusFilter === "all" ? rows : rows.filter((r) => r.status === statusFilter);

  if (loading) return <TableSkeleton />;
  if (error) return <ErrorState message={error} />;

  return (
    <>
      <QualityBanner organizationId={organizationId} className="mb-4" />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          role="group"
          aria-label="Show campaigns"
          className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0"
        >
          {(["all", ...CAMPAIGN_STATUS_ORDER] as const).map((key) => {
            const label = key === "all" ? "All" : CAMPAIGN_STATUS_LABELS[key];
            const count =
              key === "all" ? rows.length : rows.filter((r) => r.status === key).length;
            if (key !== "all" && count === 0 && statusFilter !== key) return null;
            const on = statusFilter === key;
            return (
              <button
                key={key}
                type="button"
                aria-pressed={on}
                onClick={() => setStatusFilter(key)}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[0.8125rem] font-medium transition-colors duration-150",
                  on
                    ? "border-foreground/15 bg-foreground text-background"
                    : "border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground",
                )}
              >
                {label}
                <span className={cn("tabular text-xs", on ? "opacity-70" : "text-faint")}>{count}</span>
              </button>
            );
          })}
        </div>
        {isAdmin && (
          <Button className="shrink-0" onClick={() => setWizardOpen(true)}>
            <Plus className="h-4 w-4" /> Create campaign
          </Button>
        )}
      </div>

      {visible.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title={rows.length === 0 ? "No campaigns yet" : "Nothing in this list"}
          description={
            rows.length === 0
              ? "Pick an audience, choose an approved template, and reach every opted-in customer in one go."
              : "No campaign is in that state right now. Try another one above."
          }
          action={
            isAdmin && rows.length === 0 ? (
              <Button onClick={() => setWizardOpen(true)}>
                <Plus className="h-4 w-4" /> Create your first campaign
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Desktop: a dense table; the whole row opens the campaign. */}
          <div className="hidden overflow-hidden rounded-xl border border-border bg-card shadow-xs md:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-subtle text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-4 py-2.5 font-medium">Campaign</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Progress</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Delivered</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Read</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Replied</th>
                    <th scope="col" className="px-4 py-2.5 text-right font-medium">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {visible.map((c) => (
                    <tr key={c.id} className="group relative transition-colors duration-100 hover:bg-subtle">
                      <td className="max-w-[18rem] px-4 py-3">
                        <Link
                          to="/app/campaigns/$id"
                          params={{ id: c.id }}
                          className="block truncate font-medium text-foreground after:absolute after:inset-0 after:content-[''] group-hover:text-primary"
                        >
                          {c.name}
                        </Link>
                        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{c.template_name}</p>
                      </td>
                      <td className="px-4 py-3">
                        <CampaignStatusBadge status={c.status} />
                      </td>
                      <td className="px-4 py-3">
                        <ProgressCell sent={c.sent_count} failed={c.failed_count} total={c.total_recipients} />
                      </td>
                      <td className="tabular px-4 py-3 text-right">{percent(c.delivered_count, c.total_recipients)}%</td>
                      <td className="tabular px-4 py-3 text-right">{percent(c.read_count, c.total_recipients)}%</td>
                      <td className="tabular px-4 py-3 text-right">{c.replied_count}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-right text-muted-foreground">{formatDate(c.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Phones: one card per campaign. */}
          <ul className="space-y-2.5 md:hidden">
            {visible.map((c) => (
              <li key={c.id}>
                <Link
                  to="/app/campaigns/$id"
                  params={{ id: c.id }}
                  className="block rounded-xl border border-border bg-card p-4 shadow-xs transition-colors active:bg-subtle"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">{c.name}</p>
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{c.template_name}</p>
                    </div>
                    <CampaignStatusBadge status={c.status} />
                  </div>
                  <div className="mt-3">
                    <ProgressCell sent={c.sent_count} failed={c.failed_count} total={c.total_recipients} wide />
                  </div>
                  <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                    <div>
                      <dt className="text-muted-foreground">Delivered</dt>
                      <dd className="tabular mt-0.5 font-semibold text-foreground">{percent(c.delivered_count, c.total_recipients)}%</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Read</dt>
                      <dd className="tabular mt-0.5 font-semibold text-foreground">{percent(c.read_count, c.total_recipients)}%</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">Replied</dt>
                      <dd className="tabular mt-0.5 font-semibold text-foreground">{c.replied_count}</dd>
                    </div>
                  </dl>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      <CampaignWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        organizationId={organizationId}
        timezone={timezone}
        onLaunched={() => void load()}
      />
    </>
  );
}
