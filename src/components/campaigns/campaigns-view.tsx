import { useCallback, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Megaphone, Plus } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import {
  CAMPAIGN_STATUS_CLASSES,
  CAMPAIGN_STATUS_LABELS,
  percent,
  type CampaignRow,
} from "@/lib/campaigns";
import { formatDate } from "@/lib/contacts";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { TableSkeleton } from "@/components/data-pagination";
import { CampaignWizard } from "@/components/campaigns/campaign-wizard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CampaignsView({
  organizationId,
  timezone,
  role,
}: {
  organizationId: string;
  timezone: string;
  role: string | null;
}) {
  const isAdmin = role === "owner" || role === "admin";
  const [rows, setRows] = useState<CampaignRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

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

  if (loading) return <TableSkeleton />;
  if (error) return <ErrorState message={error} />;

  return (
    <>
      <QualityBanner organizationId={organizationId} className="mb-4" />
      <div className="mb-4 flex justify-end">
        {isAdmin && (
          <Button className="rounded-full" onClick={() => setWizardOpen(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Create campaign
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No campaigns yet"
          description="Pick an audience, choose an approved template, and reach every opted-in customer in one go."
          action={
            isAdmin ? (
              <Button className="rounded-full" onClick={() => setWizardOpen(true)}>
                <Plus className="mr-1.5 h-4 w-4" /> Create your first campaign
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border/70 bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Campaign</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Progress</th>
                  <th className="px-4 py-3 font-medium">Delivered</th>
                  <th className="px-4 py-3 font-medium">Read</th>
                  <th className="px-4 py-3 font-medium">Replied</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b border-border/50 transition-colors last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-3">
                      <Link
                        to="/app/campaigns/$id"
                        params={{ id: c.id }}
                        className="font-medium text-foreground hover:text-primary"
                      >
                        {c.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{c.template_name}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium",
                          CAMPAIGN_STATUS_CLASSES[c.status],
                        )}
                      >
                        {CAMPAIGN_STATUS_LABELS[c.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-muted-foreground">
                      {c.sent_count}/{c.total_recipients}
                    </td>
                    <td className="px-4 py-3 tabular-nums">{percent(c.delivered_count, c.total_recipients)}%</td>
                    <td className="px-4 py-3 tabular-nums">{percent(c.read_count, c.total_recipients)}%</td>
                    <td className="px-4 py-3 tabular-nums">{c.replied_count}</td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
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
