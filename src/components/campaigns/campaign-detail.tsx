import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  Ticket,
  Clock,
  Loader2,
  Pause,
  Play,
  Search,
  Send,
  Users,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { money } from "@/lib/billing";
import { callApi } from "@/lib/whatsapp-client";
import {
  formatDateTime,
  percent,
  RECIPIENT_STATUS_CLASSES,
  type CampaignRecipientRow,
  type CampaignRow,
  type RecipientStatus,
} from "@/lib/campaigns";
import { ErrorState } from "@/components/empty-state";
import { NoResults, Pagination, TableSkeleton } from "@/components/data-pagination";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { CampaignStatusBadge, count } from "@/components/campaigns/campaign-rates";
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
  share,
}: {
  label: string;
  value: number;
  icon: typeof Send;
  tone?: "danger";
  /** Batch 41: this step's share of everyone in the audience, shown under the number. */
  share?: number | undefined;
}) {
  const shown = useCountUp(value);
  return (
    <div className="min-w-0 px-4 py-4 sm:px-5">
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs font-medium",
          tone === "danger" ? "text-danger-soft-foreground" : "text-muted-foreground",
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
      </div>
      <p
        className={cn(
          "tabular mt-2 text-2xl font-bold tracking-[-0.02em]",
          tone === "danger" && value > 0 ? "text-danger-soft-foreground" : "text-foreground",
        )}
      >
        {count.format(shown)}
      </p>
      {share !== undefined ? (
        <p className="tabular mt-0.5 text-xs text-muted-foreground">{share}% of audience</p>
      ) : null}
    </div>
  );
}

/** Batch 41: the recipient statuses the table can be narrowed to. */
const RECIPIENT_FILTERS: Array<RecipientStatus | "all"> = [
  "all",
  "read",
  "delivered",
  "sent",
  "sending",
  "queued",
  "failed",
  "skipped",
];

const FUNNEL = [
  { key: "sent_count", label: "Sent", of: null, bar: "bg-brand-300" },
  { key: "delivered_count", label: "Delivered", of: "sent", bar: "bg-brand-500" },
  { key: "read_count", label: "Read", of: "delivered", bar: "bg-primary" },
  { key: "replied_count", label: "Replied", of: "read", bar: "bg-chart-4" },
] as const;

/** Sent → delivered → read → replied, each bar a share of the whole audience. */
function Funnel({ campaign }: { campaign: CampaignRow }) {
  const total = campaign.total_recipients;
  return (
    <ol className="space-y-4">
      {FUNNEL.map((step, i) => {
        const value = campaign[step.key];
        const prev = i > 0 ? campaign[FUNNEL[i - 1]!.key] : null;
        return (
          <li key={step.key}>
            <FunnelRow
              label={step.label}
              value={value}
              share={percent(value, total)}
              bar={step.bar}
              note={
                step.of && prev !== null
                  ? `${percent(value, prev)}% of ${step.of}`
                  : `of ${count.format(total)} in the audience`
              }
            />
          </li>
        );
      })}
    </ol>
  );
}

function FunnelRow({
  label,
  value,
  share,
  bar,
  note,
}: {
  label: string;
  value: number;
  share: number;
  bar: string;
  note: string;
}) {
  const shown = useCountUp(value);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="flex items-baseline gap-2">
          <span className="tabular text-base font-semibold text-foreground">
            {count.format(shown)}
          </span>
          <span className="tabular w-10 text-right text-xs text-muted-foreground">{share}%</span>
        </span>
      </div>
      <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={cn("h-full rounded-full transition-[width] duration-700 ease-out", bar)}
          style={{ width: `${Math.max(share, value > 0 ? 1 : 0)}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

type TimelineEvent = {
  label: string;
  at: string | null;
  detail?: string | undefined;
  live?: boolean;
};

/** What happened to this campaign, oldest first, from its own timestamps. */
function timeline(c: CampaignRow): TimelineEvent[] {
  const events: TimelineEvent[] = [{ label: "Created", at: c.created_at }];
  if (c.approved_at) events.push({ label: "Approved", at: c.approved_at });
  if (c.scheduled_at)
    events.push({ label: c.started_at ? "Scheduled for" : "Sends at", at: c.scheduled_at });
  if (c.status === "awaiting_approval")
    events.push({ label: "Waiting for approval", at: null, live: true });
  if (c.started_at) events.push({ label: "Started sending", at: c.started_at });
  if (c.status === "sending")
    events.push({
      label: "Sending now",
      at: null,
      detail: `${percent(c.sent_count + c.failed_count, c.total_recipients)}% done`,
      live: true,
    });
  if (c.status === "paused")
    events.push({
      label: "Paused",
      at: null,
      detail: c.pause_reason === "insufficient_credits" ? "Not enough credits" : undefined,
      live: true,
    });
  if (c.status === "completed") events.push({ label: "Finished", at: c.completed_at });
  if (c.status === "cancelled") events.push({ label: "Cancelled", at: c.completed_at });
  if (c.status === "failed") events.push({ label: "Failed", at: c.completed_at });
  return events;
}

function Timeline({
  campaign,
  timezone,
}: {
  campaign: CampaignRow;
  timezone?: string | undefined;
}) {
  const events = timeline(campaign);
  return (
    <ol className="relative space-y-4">
      {events.map((e, i) => (
        <li key={`${e.label}-${i}`} className="relative flex gap-3">
          {i < events.length - 1 ? (
            <span
              className="absolute left-[5px] top-4 h-[calc(100%+0.25rem)] w-px bg-border"
              aria-hidden="true"
            />
          ) : null}
          <span
            className={cn(
              "relative mt-1 h-[11px] w-[11px] shrink-0 rounded-full border-2",
              e.live
                ? "border-primary bg-primary motion-safe:animate-pulse"
                : "border-border-strong bg-card",
            )}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{e.label}</p>
            <p className="text-xs text-muted-foreground">
              {e.at ? formatDateTime(e.at, timezone) : (e.detail ?? "Now")}
              {e.at && e.detail ? ` · ${e.detail}` : ""}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function CampaignDetail({
  campaignId,
  organizationId,
  role,
  timezone,
}: {
  campaignId: string;
  organizationId: string;
  role: string | null;
  /** The workspace's timezone, for the timeline's times. */
  timezone?: string | undefined;
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
  // Batch 41: narrow the recipients table by status and by phone number.
  const [statusFilter, setStatusFilter] = useState<RecipientStatus | "all">("all");
  const [phoneQuery, setPhoneQuery] = useState("");
  const [phoneDigits, setPhoneDigits] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setPhoneDigits(phoneQuery.replace(/\D/g, "")), 250);
    return () => clearTimeout(t);
  }, [phoneQuery]);
  useEffect(() => setPage(0), [statusFilter, phoneDigits]);

  const load = useCallback(async () => {
    let recipientsQuery = aidwar
      .from("campaign_recipients")
      .select("id, contact_id, phone, resolved_variables, status, error, updated_at", {
        count: "exact",
      })
      .eq("campaign_id", campaignId);
    if (statusFilter !== "all") recipientsQuery = recipientsQuery.eq("status", statusFilter);
    if (phoneDigits) recipientsQuery = recipientsQuery.ilike("phone", `%${phoneDigits}%`);
    const [{ data: c, error: cErr }, { data: r, count }] = await Promise.all([
      aidwar
        .from("campaigns")
        .select("*")
        .eq("id", campaignId)
        .eq("organization_id", organizationId)
        .maybeSingle(),
      recipientsQuery
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
  }, [campaignId, organizationId, page, statusFilter, phoneDigits]);

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
  const hasSpend =
    Number(campaign.estimated_cost ?? 0) > 0 || Number(campaign.charged_amount ?? 0) > 0;
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

      <div className="rounded-xl border border-border bg-card p-5 shadow-xs sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="type-title min-w-0 text-foreground">{campaign.name}</h1>
              <CampaignStatusBadge status={campaign.status} />
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">
              <span className="font-mono text-[0.8125rem]">{campaign.template_name}</span> ·{" "}
              {campaign.template_language} ·{" "}
              <span className="tabular">{count.format(campaign.total_recipients)}</span> recipients
            </p>
            {campaign.status === "paused" && campaign.pause_reason === "insufficient_credits" && (
              <p className="mt-3 inline-flex items-center gap-2 rounded-lg border border-danger-border bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
                Paused: not enough credits to cover this campaign. Add credits, then resume.
              </p>
            )}
          </div>

          {isAdmin && (
            <div className="flex shrink-0 flex-wrap gap-2">
              {campaign.status === "awaiting_approval" && (
                <Button disabled={busy} onClick={() => void control("approve")}>
                  <Play className="h-4 w-4" /> Approve and send
                </Button>
              )}

              {running && (
                <Button variant="outline" disabled={busy} onClick={() => void control("pause")}>
                  <Pause className="h-4 w-4" /> Pause
                </Button>
              )}
              {campaign.status === "paused" && (
                <Button disabled={busy} onClick={() => void control("resume")}>
                  <Play className="h-4 w-4" /> Resume
                </Button>
              )}
              {!["completed", "cancelled", "failed"].includes(campaign.status) && (
                <Button
                  variant="outline"
                  className="text-danger-soft-foreground hover:border-danger-border hover:bg-danger-soft hover:text-danger-soft-foreground"
                  disabled={busy}
                  onClick={() => void control("cancel")}
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <XCircle className="h-4 w-4" />
                  )}
                  Cancel
                </Button>
              )}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center gap-3">
          <div
            className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label="Sent so far"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="tabular shrink-0 text-sm font-medium text-foreground">{progress}%</span>
        </div>
      </div>

      {/* Batch 41: how far the message got, beside what happened when. */}
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section
          aria-labelledby="funnel-heading"
          className="rounded-xl border border-border bg-card shadow-xs"
        >
          <div className="border-b border-border px-5 py-3.5">
            <h2 id="funnel-heading" className="type-heading text-foreground">
              Results
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Each bar is a share of everyone in the audience.
            </p>
          </div>
          <div className="px-5 py-4">
            <Funnel campaign={campaign} />
          </div>
          <div className="grid grid-cols-2 gap-px border-t border-border bg-border [&>*]:bg-card">
            <Stat label="Queued" value={queued} icon={Users} />
            <Stat
              label="Failed"
              value={campaign.failed_count}
              icon={AlertTriangle}
              tone="danger"
              share={percent(campaign.failed_count, campaign.total_recipients)}
            />
          </div>
        </section>
        <section
          aria-labelledby="timeline-heading"
          className="rounded-xl border border-border bg-card shadow-xs"
        >
          <div className="border-b border-border px-5 py-3.5">
            <h2 id="timeline-heading" className="type-heading text-foreground">
              Timeline
            </h2>
          </div>
          <div className="px-5 py-4">
            <Timeline campaign={campaign} timezone={timezone} />
          </div>
        </section>
      </div>

      <div
        className={cn(
          "grid gap-3",
          hasSpend && couponCode ? "lg:grid-cols-[20rem_minmax(0,1fr)]" : "",
        )}
      >
        {hasSpend && (
          <section className="rounded-xl border border-border bg-card p-5 shadow-xs">
            <h2 className="type-heading text-foreground">What this campaign cost</h2>
            <dl
              className={cn(
                "mt-4 grid gap-4",
                couponCode ? "grid-cols-3 lg:grid-cols-1" : "grid-cols-3",
              )}
            >
              <div>
                <dt className="text-xs text-muted-foreground">Estimated</dt>
                <dd className="tabular mt-0.5 text-lg font-semibold text-foreground">
                  {money(campaign.estimated_cost ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Charged</dt>
                <dd className="tabular mt-0.5 text-lg font-semibold text-foreground">
                  {money(campaign.charged_amount ?? 0)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Returned to credits</dt>
                <dd className="tabular mt-0.5 text-lg font-semibold text-foreground">
                  {money(campaign.returned_amount ?? 0)}
                </dd>
              </div>
            </dl>
          </section>
        )}

        {couponCode && (
          <section className="rounded-xl border border-border bg-card p-5 shadow-xs">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="type-heading text-foreground">Offer performance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Code{" "}
                  <span className="rounded-md border border-border bg-subtle px-1.5 py-0.5 font-mono text-foreground">
                    {couponCode}
                  </span>
                  {offerEndsAt
                    ? ` · ends ${new Date(offerEndsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`
                    : ""}
                </p>
              </div>
              {offerEndsAt && (
                <Badge
                  variant={new Date(offerEndsAt).getTime() > Date.now() ? "success" : "muted"}
                  className="rounded-full"
                >
                  {new Date(offerEndsAt).getTime() > Date.now() ? "Live" : "Ended"}
                </Badge>
              )}
            </div>
            <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-border bg-border [&>*]:bg-card">
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
          </section>
        )}
      </div>

      <section
        aria-label="Recipients"
        className="overflow-hidden rounded-xl border border-border bg-card shadow-xs"
      >
        <div className="space-y-3 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="type-heading flex items-baseline gap-2 text-foreground">
              Recipients
              <span className="tabular text-xs font-normal text-muted-foreground">
                {count.format(total)}
              </span>
            </h2>
            <div className="relative w-full sm:w-56">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-faint"
                aria-hidden="true"
              />
              <Input
                type="search"
                inputMode="tel"
                value={phoneQuery}
                onChange={(e) => setPhoneQuery(e.target.value)}
                placeholder="Search by phone"
                aria-label="Search recipients by phone"
                className="h-8 pl-8 text-sm"
              />
            </div>
          </div>
          <div
            role="group"
            aria-label="Show recipients"
            className="-mx-4 flex gap-1 overflow-x-auto px-4 [scrollbar-width:none]"
          >
            {RECIPIENT_FILTERS.map((key) => {
              const on = statusFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setStatusFilter(key)}
                  className={cn(
                    "inline-flex h-7 shrink-0 items-center rounded-full border px-2.5 text-xs font-medium capitalize transition-colors duration-150",
                    on
                      ? "border-foreground/15 bg-foreground text-background"
                      : "border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground",
                  )}
                >
                  {key === "all" ? "All" : key}
                </button>
              );
            })}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-subtle text-left text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Phone
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  Detail
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  <span className="inline-flex items-center gap-1">
                    <Clock className="h-3 w-3" aria-hidden="true" /> Updated
                  </span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {recipients.map((r) => (
                <tr key={r.id} className="transition-colors duration-100 hover:bg-subtle">
                  <td className="tabular whitespace-nowrap px-4 py-2.5">{r.phone}</td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium capitalize",
                        RECIPIENT_STATUS_CLASSES[r.status],
                      )}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="max-w-sm truncate px-4 py-2.5 text-xs text-muted-foreground">
                    {r.error ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right text-xs text-muted-foreground">
                    {formatDateTime(r.updated_at, timezone)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {recipients.length === 0 && (
          <NoResults
            message={
              statusFilter !== "all" || phoneDigits
                ? "No recipients match. Try another status or number."
                : "No recipients on this page."
            }
          />
        )}
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      </section>
    </div>
  );
}
