import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Ticket,

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
import { usePermissions } from "@/hooks/use-permissions";

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
  const { can } = usePermissions();
  const isAdmin = can("campaigns.send");
  void role;
  const [campaign, setCampaign] = useState<CampaignRow | null>(null);
  const [recipients, setRecipients] = useState<CampaignRecipientRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState({ received: 0, tapped: 0, redeemed: 0 });

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

    // Offer numbers only matter when this campaign actually carried a coupon.
    const settings = ((c as CampaignRow | null)?.send_settings ?? {}) as Record<string, unknown>;
    if (String(settings["coupon_code"] ?? "").trim()) {
      const [received, tapped, redeemed] = await Promise.all([
        aidwar
          .from("campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", campaignId)
          .in("status", ["sent", "delivered", "read", "replied"]),
        aidwar
          .from("campaign_offer_events")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", campaignId)
          .eq("event", "tapped"),
        aidwar
          .from("campaign_offer_events")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", campaignId)
          .eq("event", "redeemed"),
      ]);
      setOffer({
        received: received.count ?? 0,
        tapped: tapped.count ?? 0,
        redeemed: redeemed.count ?? 0,
      });
    }
  }, [campaignId, organizationId, page]);


  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const control = async (action: "pause" | "resume" | "cancel" | "approve") => {
    setBusy(true);
    const { error: err } = await callApi("/api/campaigns/control", {
      body: { organization_id: organizationId, campaign_id: campaignId, action },
    });
    setBusy(false);
    if (err) toast.error(err);
    else {
      toast.success(
        action === "pause"
          ? "Campaign paused."
          : action === "resume"
            ? "Campaign resumed."
            : action === "approve"
              ? "Approved — sending starts now."
              : "Campaign cancelled.",
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
  const sendSettings = (campaign.send_settings ?? {}) as Record<string, unknown>;
  const couponCode = String(sendSettings["coupon_code"] ?? "").trim();
  const offerEndsAt = String(sendSettings["offer_expires_at"] ?? "").trim() || null;



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
              {campaign.status === "awaiting_approval" && (
                <Button
                  className="rounded-full"
                  disabled={busy}
                  onClick={() => void control("approve")}
                >
                  <Play className="mr-1.5 h-4 w-4" /> Approve and send
                </Button>
              )}

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

      {hasSpend && (
        <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
          <h2 className="text-sm font-semibold">What this campaign cost</h2>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted-foreground">Estimated</p>
              <p className="text-lg font-semibold tabular-nums">
                {money(campaign.estimated_cost ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Charged</p>
              <p className="text-lg font-semibold tabular-nums">
                {money(campaign.charged_amount ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Returned to credits</p>
              <p className="text-lg font-semibold tabular-nums">
                {money(campaign.returned_amount ?? 0)}
              </p>
            </div>
          </div>
        </div>
      )}


      {couponCode && (
        <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Offer performance</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Code{" "}
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono">{couponCode}</span>
                {offerEndsAt ? ` · ends ${new Date(offerEndsAt).toLocaleString()}` : ""}
              </p>
            </div>
            {offerEndsAt && (
              <span
                className={cn(
                  "inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium",
                  new Date(offerEndsAt).getTime() > Date.now()
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border bg-muted text-muted-foreground",
                )}
              >
                {new Date(offerEndsAt).getTime() > Date.now() ? "Live" : "Ended"}
              </span>
            )}
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Stat label="Received" value={offer.received} icon={Send} />
            <Stat label="Took the code" value={offer.tapped} icon={Ticket} />
            <Stat label="Used it" value={offer.redeemed} icon={BadgeCheck} />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {offer.received === 0
              ? "Nothing to measure yet — the numbers fill in once the campaign starts sending."
              : offer.tapped === 0
                ? "No one has come back with the code yet. Give it a day before reading anything into it."
                : `${percent(offer.redeemed, offer.received)}% of everyone who got this message has placed an order with the code.`}
          </p>
        </div>
      )}


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
