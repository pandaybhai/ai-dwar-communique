import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCheck,
  Eye,
  Loader2,
  Pause,
  Play,
  Send,
  Users,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import {
  CAMPAIGN_STATUS_CLASSES,
  CAMPAIGN_STATUS_LABELS,
  percent,
  RECIPIENT_STATUS_CLASSES,
  type CampaignRecipientRow,
  type CampaignRow,
} from "@/lib/campaigns";
import { ErrorState } from "@/components/empty-state";
import { NoResults, Pagination, TableSkeleton } from "@/components/data-pagination";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;

function useCountUp(value: number) {
  const [display, setDisplay] = useState(value);
  const previous = useRef(value);
  useEffect(() => {
    const from = previous.current;
    previous.current = value;
    if (from === value) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 500);
      setDisplay(Math.round(from + (value - from) * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return display;
}

function Stat({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof Send;
  tone?: "danger";
}) {
  const shown = useCountUp(value);
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
      <div
        className={cn(
          "flex items-center gap-2 text-xs font-medium",
          tone === "danger" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <Icon className="h-3.5 w-3.5" /> {label}
      </div>
      <p
        className={cn(
          "mt-1.5 text-2xl font-semibold tabular-nums",
          tone === "danger" && "text-destructive",
        )}
      >
        {shown}
      </p>
    </div>
  );
}

export function CampaignDetail({
  campaignId,
  organizationId,
  role,
}: {
  campaignId: string;
  organizationId: string;
  role: string | null;
}) {
  const isAdmin = role === "owner" || role === "admin";
  const [campaign, setCampaign] = useState<CampaignRow | null>(null);
  const [recipients, setRecipients] = useState<CampaignRecipientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [{ data: c, error: cErr }, { data: r, count }] = await Promise.all([
      aidwar
        .from("campaigns")
        .select("*")
        .eq("id", campaignId)
        .eq("organization_id", organizationId)
        .maybeSingle(),
      aidwar
        .from("campaign_recipients")
        .select("id, contact_id, phone, resolved_variables, status, error, updated_at", {
          count: "exact",
        })
        .eq("campaign_id", campaignId)
        .order("updated_at", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1),
    ]);
    if (cErr || !c) setError("We couldn't find this campaign.");
    else setCampaign(c as CampaignRow);
    setRecipients((r ?? []) as CampaignRecipientRow[]);
    setTotal(count ?? 0);
    setLoading(false);
  }, [campaignId, organizationId, page]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const control = async (action: "pause" | "resume" | "cancel") => {
    setBusy(true);
    const { error: err } = await callApi("/api/campaigns/control", {
      body: { organization_id: organizationId, campaign_id: campaignId, action },
    });
    setBusy(false);
    if (err) toast.error(err);
    else {
      toast.success(
        action === "pause" ? "Campaign paused." : action === "resume" ? "Campaign resumed." : "Campaign cancelled.",
      );
      void load();
    }
  };

  if (loading) return <TableSkeleton />;
  if (error || !campaign) return <ErrorState message={error ?? "Campaign not found."} />;

  const queued = Math.max(
    0,
    campaign.total_recipients - campaign.sent_count - campaign.failed_count,
  );
  const progress = percent(campaign.sent_count + campaign.failed_count, campaign.total_recipients);
  const running = campaign.status === "sending" || campaign.status === "scheduled";

  return (
    <div className="space-y-5">
      <Link
        to="/app/campaigns"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> All campaigns
      </Link>

      <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-xl font-semibold">{campaign.name}</h1>
              <span
                className={cn(
                  "inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium",
                  CAMPAIGN_STATUS_CLASSES[campaign.status],
                )}
              >
                {CAMPAIGN_STATUS_LABELS[campaign.status]}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {campaign.template_name} · {campaign.template_language} ·{" "}
              {campaign.total_recipients} recipients
            </p>
          </div>

          {isAdmin && (
            <div className="flex flex-wrap gap-2">
              {running && (
                <Button
                  variant="outline"
                  className="rounded-full"
                  disabled={busy}
                  onClick={() => void control("pause")}
                >
                  <Pause className="mr-1.5 h-4 w-4" /> Pause
                </Button>
              )}
              {campaign.status === "paused" && (
                <Button
                  className="rounded-full"
                  disabled={busy}
                  onClick={() => void control("resume")}
                >
                  <Play className="mr-1.5 h-4 w-4" /> Resume
                </Button>
              )}
              {!["completed", "cancelled", "failed"].includes(campaign.status) && (
                <Button
                  variant="outline"
                  className="rounded-full text-destructive hover:text-destructive"
                  disabled={busy}
                  onClick={() => void control("cancel")}
                >
                  {busy ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <XCircle className="mr-1.5 h-4 w-4" />
                  )}
                  Cancel
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Queued" value={queued} icon={Users} />
        <Stat label="Sent" value={campaign.sent_count} icon={Send} />
        <Stat label="Delivered" value={campaign.delivered_count} icon={CheckCheck} />
        <Stat label="Read" value={campaign.read_count} icon={Eye} />
        <Stat label="Failed" value={campaign.failed_count} icon={AlertTriangle} tone="danger" />
      </div>

      <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border/70 bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 font-medium">Phone</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => (
                <tr key={r.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-3 tabular-nums">{r.phone}</td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        "inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize",
                        RECIPIENT_STATUS_CLASSES[r.status],
                      )}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="max-w-sm truncate px-4 py-3 text-xs text-muted-foreground">
                    {r.error ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {recipients.length === 0 && <NoResults message="No recipients on this page." />}
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      </div>
    </div>
  );
}
