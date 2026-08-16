import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpDown, Megaphone, Users } from "lucide-react";
import { ChartCard } from "@/components/analytics/chart-card";
import {
  fetchCampaignFailures,
  fetchCampaignRecipients,
  rate,
  type CampaignPerformance,
  type FailureReason,
  type RecipientRow,
} from "@/lib/analytics";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type SortKey = "name" | "date" | "recipients" | "delivered" | "read" | "replied" | "failed";

const PAGE_SIZE = 25;

function dateLabel(row: CampaignPerformance, timezone: string): string {
  const iso = row.started_at ?? row.created_at;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone || "UTC",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function RateCell({ count, denominator }: { count: number; denominator: number }) {
  const r = rate(count, denominator);
  return (
    <div className="text-right">
      <span className="font-medium text-foreground">{count.toLocaleString()}</span>
      <span className="ml-2 text-xs text-muted-foreground">{r.thin ? "" : r.text}</span>
    </div>
  );
}

export function AnalyticsCampaigns({
  organizationId,
  timezone,
  rows,
  loading,
}: {
  organizationId: string;
  timezone: string;
  rows: CampaignPerformance[];
  loading: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [asc, setAsc] = useState(false);
  const [selected, setSelected] = useState<CampaignPerformance | null>(null);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const value = (r: CampaignPerformance) => {
        switch (sortKey) {
          case "name":
            return r.name.toLowerCase();
          case "date":
            return r.started_at ?? r.created_at;
          default:
            return r[sortKey];
        }
      };
      const av = value(a);
      const bv = value(b);
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * (asc ? 1 : -1);
    });
    return copy;
  }, [rows, sortKey, asc]);

  const toggle = (key: SortKey) => {
    if (key === sortKey) setAsc((v) => !v);
    else {
      setSortKey(key);
      setAsc(key === "name");
    }
  };

  const header = (key: SortKey, label: string, align: "left" | "right" = "right") => (
    <TableHead className={align === "right" ? "text-right" : ""}>
      <button
        type="button"
        onClick={() => toggle(key)}
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        {label}
        <ArrowUpDown className="h-3 w-3" />
      </button>
    </TableHead>
  );

  return (
    <>
      <ChartCard
        title="Campaign performance"
        description="Every campaign that ran in this period. Click a row for the funnel and recipient list."
        loading={loading}
        isEmpty={rows.length === 0}
        emptyIcon={Megaphone}
        emptyTitle="No campaigns in this period"
        emptyDescription="Launch a broadcast and its delivery, read and reply performance will be tracked here."
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                {header("name", "Campaign", "left")}
                {header("date", "Date", "left")}
                {header("recipients", "Recipients")}
                {header("delivered", "Delivered")}
                {header("read", "Read")}
                {header("replied", "Replied")}
                {header("failed", "Failed")}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((row) => (
                <TableRow
                  key={row.campaign_id}
                  onClick={() => setSelected(row)}
                  className="cursor-pointer transition-colors duration-150"
                >
                  <TableCell className="font-medium text-foreground">{row.name}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                    {dateLabel(row, timezone)}
                  </TableCell>
                  <TableCell className="text-right">{row.recipients.toLocaleString()}</TableCell>
                  <TableCell>
                    <RateCell count={row.delivered} denominator={row.sent} />
                  </TableCell>
                  <TableCell>
                    <RateCell count={row.read} denominator={row.delivered} />
                  </TableCell>
                  <TableCell>
                    <RateCell count={row.replied} denominator={row.sent} />
                  </TableCell>
                  <TableCell>
                    <RateCell count={row.failed} denominator={row.recipients} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {rows.some((r) => r.recipients > 0 && r.recipients < 20) ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Rates are hidden for campaigns with fewer than 20 recipients — the raw counts tell the
              truth at that size.
            </p>
          ) : null}
        </div>
      </ChartCard>

      <CampaignDrilldown
        organizationId={organizationId}
        campaign={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}

function CampaignDrilldown({
  organizationId,
  campaign,
  onClose,
}: {
  organizationId: string;
  campaign: CampaignPerformance | null;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<string>("all");
  const [page, setPage] = useState(0);
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [failures, setFailures] = useState<FailureReason[]>([]);
  const [loading, setLoading] = useState(true);

  const campaignId = campaign?.campaign_id ?? null;

  useEffect(() => {
    setStatus("all");
    setPage(0);
  }, [campaignId]);

  const load = useCallback(async () => {
    if (!campaignId) return;
    setLoading(true);
    const [list, fails] = await Promise.all([
      fetchCampaignRecipients(
        organizationId,
        campaignId,
        status === "all" ? null : status,
        PAGE_SIZE,
        page * PAGE_SIZE,
      ),
      fetchCampaignFailures(organizationId, campaignId),
    ]);
    setRecipients(list.data ?? []);
    setFailures(fails.data ?? []);
    setLoading(false);
  }, [organizationId, campaignId, status, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = recipients[0]?.total_count ?? 0;
  const funnel = campaign
    ? [
        { label: "Recipients", value: campaign.recipients },
        { label: "Sent", value: campaign.sent },
        { label: "Delivered", value: campaign.delivered },
        { label: "Read", value: campaign.read },
        { label: "Replied", value: campaign.replied },
      ]
    : [];
  const widest = Math.max(1, ...funnel.map((f) => f.value));

  return (
    <Dialog open={!!campaign} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{campaign?.name}</DialogTitle>
          <DialogDescription>
            Funnel and recipient outcomes for this broadcast.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {funnel.map((step) => (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-24 shrink-0 text-xs text-muted-foreground">{step.label}</span>
              <div className="h-7 flex-1 overflow-hidden rounded-lg bg-muted/50">
                <div
                  className="h-full rounded-lg bg-gradient-to-r from-primary to-teal-500 transition-all duration-500"
                  style={{ width: `${Math.max((step.value / widest) * 100, step.value > 0 ? 4 : 0)}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right text-sm font-semibold text-foreground">
                {step.value}
              </span>
            </div>
          ))}
        </div>

        {failures.length > 0 ? (
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
            <p className="text-sm font-semibold text-destructive">
              {failures.reduce((sum, f) => sum + Number(f.recipients), 0)} failed
            </p>
            <ul className="mt-2 space-y-1 text-xs text-destructive/90">
              {failures.map((f) => (
                <li key={f.reason}>
                  <span className="font-medium">{Number(f.recipients)}</span> — {f.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{total.toLocaleString()} recipients</p>
          <Select
            value={status}
            onValueChange={(v) => {
              setStatus(v);
              setPage(0);
            }}
          >
            <SelectTrigger className="h-9 w-44">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {["queued", "sending", "sent", "delivered", "read", "failed", "skipped"].map((s) => (
                <SelectItem key={s} value={s}>
                  {s[0]?.toUpperCase()}
                  {s.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : recipients.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl border border-dashed border-border/70 bg-muted/30 px-6 py-10 text-center">
            <Users className="h-6 w-6 text-primary" />
            <p className="mt-3 text-sm font-medium text-foreground">No recipients match this filter</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try another status to see the rest of this campaign's audience.
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Contact</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipients.map((r) => (
                <TableRow key={r.recipient_id}>
                  <TableCell>
                    <span className="font-medium text-foreground">{r.contact_name ?? r.phone}</span>
                    {r.contact_name ? (
                      <span className="ml-2 text-xs text-muted-foreground">{r.phone}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.status === "failed" ? "destructive" : "secondary"}>
                      {r.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground">
                    {r.error ?? (r.replied_at ? "Replied" : "—")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {total > PAGE_SIZE ? (
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(p - 1, 0))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={(page + 1) * PAGE_SIZE >= total}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
