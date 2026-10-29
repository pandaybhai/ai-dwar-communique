import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Pause, Play, Search, XCircle } from "lucide-react";
import { toast } from "sonner";
import { NumberTicker } from "@/components/design-v2";
import { ErrorState } from "@/components/empty-state";
import { Pagination } from "@/components/data-pagination";
import { CardPreview } from "@/components/cards/card-preview";
import { TemplatePhone } from "@/components/templates-v2/template-phone";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useWhatsAppNumbers } from "@/hooks/use-whatsapp-numbers";
import {
  CAMPAIGN_STATUS_LABELS,
  formatDateTime,
  percent,
  type CampaignRecipientRow,
  type CampaignRow,
  type RecipientStatus,
} from "@/lib/campaigns";
import type { CustomerCardKind } from "@/lib/customer-cards";
import type { TemplateRow } from "@/lib/templates";
import { cn } from "@/lib/utils";
import {
  RECIPIENT_FILTERS,
  RECIPIENT_PAGE_SIZE,
  campaignCost,
  campaignPreviewModel,
  campaignTimeline,
  controlCampaign,
  count,
  funnelSteps,
  loadCampaignResults,
  loadCampaignSales,
  loadCampaignTemplate,
  loadOfferNumbers,
  mappingLabels,
  wholeMoney,
  type CampaignSales,
  type OfferNumbers,
} from "./data";
import { StatusTag } from "./new-campaigns";

/**
 * Batch 47: one campaign's results (the preview's .cres) and the message it
 * sends (the preview's .phone). Every number is the campaign row's own
 * counter or one of the Batch 41 results page's reads.
 */
export function CampaignResults({
  organizationId,
  campaignId,
  timezone,
  listRow,
  onChanged,
}: {
  organizationId: string;
  campaignId: string;
  timezone: string;
  /** The list's copy of the row, drawn at once while the full read runs. */
  listRow: CampaignRow | null;
  onChanged: () => void;
}) {
  const { can } = usePermissions();
  const canControl = can("campaigns.send");
  const revenueFlag = useFeatureFlag("revenue_attribution");
  const canSeeSales = revenueFlag.enabled && can("analytics.view");
  const { numbers } = useWhatsAppNumbers({ activeOnly: false });

  const [campaign, setCampaign] = useState<CampaignRow | null>(listRow);
  const [recipients, setRecipients] = useState<CampaignRecipientRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<RecipientStatus | "all">("all");
  const [phoneQuery, setPhoneQuery] = useState("");
  const [phoneDigits, setPhoneDigits] = useState("");
  const [busy, setBusy] = useState(false);
  const [offer, setOffer] = useState<OfferNumbers | null>(null);
  const [sales, setSales] = useState<CampaignSales | null>(null);
  const [template, setTemplate] = useState<TemplateRow | null | undefined>(undefined);

  useEffect(() => {
    const t = setTimeout(() => setPhoneDigits(phoneQuery.replace(/\D/g, "")), 250);
    return () => clearTimeout(t);
  }, [phoneQuery]);
  useEffect(() => setPage(0), [status, phoneDigits]);

  const load = useCallback(async () => {
    const out = await loadCampaignResults({
      organizationId,
      campaignId,
      page,
      status,
      phoneDigits,
    });
    setError(out.error);
    if (out.campaign) setCampaign(out.campaign);
    setRecipients(out.recipients);
    setTotal(out.total);
    if (out.campaign) setOffer(await loadOfferNumbers(out.campaign));
  }, [organizationId, campaignId, page, status, phoneDigits]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!canSeeSales) return;
    let live = true;
    void loadCampaignSales(organizationId, campaignId).then((s) => {
      if (live) setSales(s);
    });
    return () => {
      live = false;
    };
  }, [canSeeSales, organizationId, campaignId]);

  const accountId = (campaign as (CampaignRow & { whatsapp_account_id?: string | null }) | null)
    ?.whatsapp_account_id;
  const wabaId = numbers.find((n) => n.id === accountId)?.waba_id ?? null;
  const templateKey = campaign
    ? `${campaign.template_name}:${campaign.template_language}:${wabaId}`
    : "";
  useEffect(() => {
    if (!campaign) return;
    let live = true;
    void loadCampaignTemplate(organizationId, campaign, wabaId).then((t) => {
      if (live) setTemplate(t);
    });
    return () => {
      live = false;
    };
    // Only a different template (or library) needs a new read; the 5-second refresh doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, templateKey]);

  const control = async (action: "pause" | "resume" | "cancel" | "approve") => {
    setBusy(true);
    const { error: err } = await controlCampaign(organizationId, campaignId, action);
    setBusy(false);
    if (err) toast.error(err);
    else {
      toast.success(
        action === "pause"
          ? "Campaign paused."
          : action === "resume"
            ? "Campaign resumed."
            : action === "approve"
              ? "Approved, sending starts now."
              : "Campaign cancelled.",
      );
      void load();
      onChanged();
    }
  };

  if (error && !campaign) return <ErrorState message={error} />;
  if (!campaign) return <ResultsSkeleton />;

  const running = campaign.status === "sending" || campaign.status === "scheduled";
  const cost = campaignCost(campaign);
  const settings = (campaign.send_settings ?? {}) as Record<string, unknown>;
  const couponCode = String(settings["coupon_code"] ?? "").trim();

  return (
    // Wide: results and their lists on the left, the phone beside them. Phones
    // and tablets: results, then the phone, then the timeline and recipients.
    <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-7 [grid-template-areas:'top'_'phone'_'rest'] min-[1001px]:grid-cols-[minmax(0,1fr)_minmax(0,260px)] min-[1001px]:[grid-template-areas:'top_phone'_'rest_phone']">
      <section aria-labelledby="cres-title" className="flex min-w-0 flex-col gap-5 [grid-area:top]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h2
            id="cres-title"
            className="min-w-0 font-display text-[1.375rem] font-semibold leading-tight text-foreground"
          >
            {campaign.name}
          </h2>
          {campaign.status !== "completed" ? (
            <StatusTag status={campaign.status} label={CAMPAIGN_STATUS_LABELS[campaign.status]} />
          ) : null}
          {canControl ? (
            <div className="flex flex-wrap gap-2 wide:ml-auto">
              {campaign.status === "awaiting_approval" && (
                <Button
                  variant="gold"
                  size="sm"
                  disabled={busy}
                  onClick={() => void control("approve")}
                >
                  <Play className="h-4 w-4" aria-hidden="true" /> Approve and send
                </Button>
              )}
              {running && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void control("pause")}
                >
                  <Pause className="h-4 w-4" aria-hidden="true" /> Pause
                </Button>
              )}
              {campaign.status === "paused" && (
                <Button size="sm" disabled={busy} onClick={() => void control("resume")}>
                  <Play className="h-4 w-4" aria-hidden="true" /> Resume
                </Button>
              )}
              {!["completed", "cancelled", "failed"].includes(campaign.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void control("cancel")}
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <XCircle className="h-4 w-4" aria-hidden="true" />
                  )}
                  Cancel
                </Button>
              )}
            </div>
          ) : null}
        </div>

        {campaign.status === "paused" && campaign.pause_reason === "insufficient_credits" ? (
          <p className="m-0 rounded-[14px] border border-gold-line bg-gold-bg px-4 py-3 text-sm font-semibold text-gold-ink">
            Paused: not enough credits for the rest of this campaign. Add credits, then resume.
          </p>
        ) : null}

        <Funnel campaign={campaign} />

        <dl className="m-0 flex flex-wrap gap-x-10 gap-y-4">
          {cost ? <Figure label={cost.label} value={wholeMoney(cost.amount)} /> : null}
          {sales ? (
            <Figure
              label="Sales from this campaign"
              value={wholeMoney(sales.revenue, sales.currency)}
              note={`${count.format(sales.orders)} order${sales.orders === 1 ? "" : "s"}`}
            />
          ) : null}
          {campaign.failed_count > 0 ? (
            <Figure
              label="Failed"
              value={count.format(campaign.failed_count)}
              note={`${percent(campaign.failed_count, campaign.total_recipients)}% of the audience`}
            />
          ) : null}
          {couponCode && offer ? (
            <>
              <Figure label={`Took code ${couponCode}`} value={count.format(offer.tapped)} />
              <Figure label="Used it" value={count.format(offer.redeemed)} />
            </>
          ) : null}
        </dl>
      </section>

      <div className="flex min-w-0 flex-col gap-7 [grid-area:rest]">
        <Timeline campaign={campaign} timezone={timezone} />

        <Recipients
          rows={recipients}
          total={total}
          page={page}
          onPage={setPage}
          status={status}
          onStatus={setStatus}
          phoneQuery={phoneQuery}
          onPhoneQuery={setPhoneQuery}
          filtered={status !== "all" || Boolean(phoneDigits)}
          timezone={timezone}
        />
      </div>

      <CampaignPhone campaign={campaign} template={template} />
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 font-display text-2xl font-semibold tabular-nums text-foreground">
        {value}
      </dd>
      {note ? <dd className="m-0 text-sm text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

/** Sent, delivered, read, replied: the preview's funnel, numbers ticking up, bars filling. */
function Funnel({ campaign }: { campaign: CampaignRow }) {
  const steps = funnelSteps(campaign);
  return (
    <ol className="m-0 flex list-none flex-col gap-4 p-0" aria-label="Results">
      {steps.map((s, i) => (
        <li key={s.key} className="grid grid-cols-[110px_auto] items-baseline gap-x-4 gap-y-1">
          <span className="text-muted-foreground">{s.label}</span>
          <b className="font-display text-[1.75rem] font-semibold leading-none text-foreground">
            <NumberTicker value={s.value} />
            <span className="sr-only">, {s.share}% of the audience</span>
          </b>
          <span
            aria-hidden="true"
            className="col-span-full block h-3 overflow-hidden rounded-full bg-line"
          >
            <i
              className={cn(
                "nd-bar-grow block h-full rounded-full",
                i === 3 ? "bg-gold" : "bg-gradient-to-r from-aiden to-aiden-deep",
              )}
              style={{ width: `${Math.max(s.share, s.value > 0 ? 1 : 0)}%` }}
            />
          </span>
        </li>
      ))}
    </ol>
  );
}

function Timeline({ campaign, timezone }: { campaign: CampaignRow; timezone: string }) {
  const events = campaignTimeline(campaign);
  return (
    <section aria-labelledby="ctime" className="flex flex-col gap-3">
      <h3 id="ctime" className="m-0 font-display text-lg font-semibold text-foreground">
        Timeline
      </h3>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {events.map((e, i) => (
          <li
            key={`${e.label}-${i}`}
            className="flex flex-wrap items-baseline justify-between gap-x-4"
          >
            <span className={cn("font-semibold", e.live ? "text-aiden-deep" : "text-foreground")}>
              {e.label}
            </span>
            <span className="text-sm tabular-nums text-muted-foreground">
              {e.at ? formatDateTime(e.at, timezone) : (e.detail ?? "Now")}
              {e.at && e.detail ? `, ${e.detail}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Recipients({
  rows,
  total,
  page,
  onPage,
  status,
  onStatus,
  phoneQuery,
  onPhoneQuery,
  filtered,
  timezone,
}: {
  rows: CampaignRecipientRow[] | null;
  total: number;
  page: number;
  onPage: (p: number) => void;
  status: RecipientStatus | "all";
  onStatus: (s: RecipientStatus | "all") => void;
  phoneQuery: string;
  onPhoneQuery: (q: string) => void;
  filtered: boolean;
  timezone: string;
}) {
  return (
    <section aria-labelledby="crec" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3
          id="crec"
          className="m-0 flex items-baseline gap-2 font-display text-lg font-semibold text-foreground"
        >
          Recipients
          <span className="font-sans text-sm font-medium tabular-nums text-muted-foreground">
            {count.format(total)}
          </span>
        </h3>
        <div className="relative w-full wide:w-56">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            inputMode="tel"
            value={phoneQuery}
            onChange={(e) => onPhoneQuery(e.target.value)}
            placeholder="Search by phone"
            aria-label="Search recipients by phone"
            className="pl-9"
          />
        </div>
      </div>
      <div role="group" aria-label="Show recipients" className="flex flex-wrap gap-1.5">
        {RECIPIENT_FILTERS.map((key) => {
          const on = status === key;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => onStatus(key)}
              className={cn(
                "rounded-full border px-3 py-1 text-sm font-semibold capitalize transition-colors duration-200",
                on
                  ? "border-transparent bg-aiden-soft text-aiden-deep"
                  : "border-line bg-surface text-foreground hover:bg-bubble-in",
              )}
            >
              {key === "all" ? "All" : key}
            </button>
          );
        })}
      </div>
      {!rows ? (
        <Skeleton className="h-40 rounded-[20px]" />
      ) : rows.length === 0 ? (
        <p className="m-0 rounded-[20px] border border-line bg-surface px-4 py-8 text-center text-muted-foreground">
          {filtered ? "No recipients match. Try another status or number." : "No recipients yet."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-[20px] border border-line bg-surface phone:rounded-none phone:border-0 phone:bg-transparent">
          <table className="w-full border-collapse text-[0.9375rem]">
            <thead className="phone:hidden">
              <tr className="text-left text-sm text-muted-foreground">
                <th scope="col" className="border-b border-line px-4 py-3 font-semibold">
                  Phone
                </th>
                <th scope="col" className="border-b border-line px-4 py-3 font-semibold">
                  Status
                </th>
                <th scope="col" className="border-b border-line px-4 py-3 font-semibold">
                  Detail
                </th>
                <th scope="col" className="border-b border-line px-4 py-3 text-right font-semibold">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody className="phone:flex phone:flex-col phone:gap-2.5">
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="transition-colors duration-200 hover:bg-ground phone:grid phone:grid-cols-[minmax(0,1fr)_auto] phone:gap-1 phone:rounded-2xl phone:border phone:border-line phone:bg-surface phone:p-3"
                >
                  <td className="border-b border-line px-4 py-3 tabular-nums phone:border-0 phone:p-0">
                    {r.phone}
                  </td>
                  <td className="border-b border-line px-4 py-3 capitalize phone:border-0 phone:p-0 phone:text-right">
                    <span
                      className={cn(
                        "font-semibold",
                        r.status === "failed"
                          ? "text-danger-soft-foreground"
                          : r.status === "read"
                            ? "text-aiden-deep"
                            : "text-foreground",
                      )}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td
                    className={cn(
                      "max-w-xs truncate border-b border-line px-4 py-3 text-sm text-muted-foreground phone:col-span-2 phone:max-w-none phone:whitespace-normal phone:border-0 phone:p-0",
                      !r.error && "phone:hidden",
                    )}
                  >
                    {r.error ?? (
                      <>
                        <span aria-hidden="true">–</span>
                        <span className="sr-only">Nothing to report</span>
                      </>
                    )}
                  </td>
                  <td className="whitespace-nowrap border-b border-line px-4 py-3 text-right text-sm text-muted-foreground phone:col-span-2 phone:border-0 phone:p-0 phone:text-left">
                    {formatDateTime(r.updated_at, timezone)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pagination page={page} pageSize={RECIPIENT_PAGE_SIZE} total={total} onPageChange={onPage} />
    </section>
  );
}

function CampaignPhone({
  campaign,
  template,
}: {
  campaign: CampaignRow;
  template: TemplateRow | null | undefined;
}) {
  const model = useMemo(
    () => campaignPreviewModel(campaign, template ?? null),
    [campaign, template],
  );
  const settings = (campaign.send_settings ?? {}) as Record<string, unknown>;
  const card = settings["card"] as { kind?: string; vars?: Record<string, string> } | undefined;
  const usesName = Object.values(campaign.variable_mappings ?? {}).some(
    (m) => m?.source === "name",
  );
  return (
    <aside
      aria-label="The message this campaign sends"
      className="flex flex-col items-center gap-3 [grid-area:phone] min-[1001px]:sticky min-[1001px]:top-4 min-[1001px]:row-span-2"
    >
      {template === undefined ? (
        <Skeleton className="h-[450px] w-full max-w-[260px] rounded-[36px]" />
      ) : (
        <TemplatePhone
          model={model}
          label={`${campaign.name}: the message`}
          after={
            card?.kind ? (
              <CardPreview kind={card.kind as CustomerCardKind} vars={card.vars ?? {}} />
            ) : null
          }
        />
      )}
      <p className="m-0 max-w-[260px] text-center text-sm text-muted-foreground">
        {template === null
          ? `The template ${campaign.template_name ?? ""} isn’t in your library any more.`
          : usesName
            ? "{{name}} is each customer’s own name."
            : "What every customer gets."}
      </p>
    </aside>
  );
}

function ResultsSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading results">
      <Skeleton className="h-7 w-1/2 rounded-lg" />
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-14 rounded-xl" />
      ))}
    </div>
  );
}
