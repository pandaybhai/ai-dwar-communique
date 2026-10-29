import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  Bot,
  CheckCircle2,
  Coins,
  CreditCard,
  GraduationCap,
  HandHelping,
  Inbox,
  Megaphone,
  MessageSquare,
  Send,
  Sparkles,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AidenSetupCard } from "@/components/aiden-setup-card";
import { JourneyResume } from "@/components/onboarding/journey-resume";
import { PersonaReviewBanner } from "@/components/persona-review-banner";
import { SendHealthBanner } from "@/components/send-health-banner";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ContactAvatar } from "@/components/inbox/contact-avatar";
import { CampaignStatusBadge, RateBars, count } from "@/components/campaigns/campaign-rates";
import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import { callApi } from "@/lib/whatsapp-client";
import { money, type BillingSummary } from "@/lib/billing";
import { aidwar } from "@/integrations/aidwar/client";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import {
  fetchTimeseries,
  localDate,
  makeFilters,
  periodForDays,
  shortDay,
  type SeriesPoint,
} from "@/lib/analytics";
import type { CampaignRow } from "@/lib/campaigns";
import type { HomeSummary } from "@/lib/home.server";
import { useNewDesign } from "@/lib/new-design";
import { NewHome } from "@/components/home-v2/new-home";

const DESCRIPTION = "Today at a glance: conversations, what Aiden answered, who is waiting on you.";

export const Route = createFileRoute("/app/")({
  head: () => ({
    meta: [
      { title: "Home — AiDwar" },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: "Home — AiDwar" },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: HomeRoute,
});

/**
 * Batch 45: the new design's Home (src/components/home-v2) when the
 * workspace has new_design on; otherwise the Batch 41 Home below, unchanged.
 */
function HomeRoute() {
  return useNewDesign() ? <NewHome /> : <AppHome />;
}

const SOURCE_LABEL: Record<string, string> = {
  website: "Website",
  upload: "Files you sent",
  manual_qa: "Answers you taught",
  pdf: "PDF",
  spreadsheet: "Spreadsheet",
  image: "Photo",
  docx: "Document",
  shopify: "Shopify",
  woocommerce: "WooCommerce",
  meta_catalog: "Catalogue",
};

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

/**
 * Batch 41: what Home shows beside its own summary — each from a query another
 * page already makes, read only when that page is on and the person may open
 * it, and simply left out when it can't be read.
 */
type HomeExtras = {
  /** The last 7 local days from Analytics (null: not shown). */
  series: SeriesPoint[] | null;
  /** The latest campaigns from Campaigns (null: not shown). */
  campaigns: CampaignRow[] | null;
  /** The wallet and allowance from Billing (null: not shown). */
  billing: BillingSummary | null;
};

function useHomeExtras(orgId: string | null, timezone: string): HomeExtras {
  const { can, loading: permsLoading } = usePermissions();
  const analytics = useFeatureFlag("analytics");
  const campaignsFlag = useFeatureFlag("campaigns");
  const billingFlag = useFeatureFlag("billing");
  const [extras, setExtras] = useState<HomeExtras>({
    series: null,
    campaigns: null,
    billing: null,
  });

  const showSeries =
    !analytics.loading && analytics.enabled && !permsLoading && can("analytics.view");
  const showCampaigns =
    !campaignsFlag.loading && campaignsFlag.enabled && !permsLoading && can("campaigns.view");
  const showBilling =
    !billingFlag.loading && billingFlag.enabled && !permsLoading && can("billing.view");

  useEffect(() => {
    if (!orgId || !showSeries) return;
    let cancelled = false;
    void fetchTimeseries(orgId, makeFilters(periodForDays(timezone, 7, "Last 7 days"))).then(
      (res) => {
        if (!cancelled && res.data) setExtras((e) => ({ ...e, series: res.data }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orgId, timezone, showSeries]);

  useEffect(() => {
    if (!orgId || !showCampaigns) return;
    let cancelled = false;
    void aidwar
      .from("campaigns")
      .select("*")
      .eq("organization_id", orgId)
      .neq("status", "draft")
      .order("created_at", { ascending: false })
      .limit(3)
      .then(({ data, error }) => {
        if (!cancelled && !error)
          setExtras((e) => ({ ...e, campaigns: (data ?? []) as CampaignRow[] }));
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, showCampaigns]);

  useEffect(() => {
    if (!orgId || !showBilling) return;
    let cancelled = false;
    void callApi<BillingSummary>(`/api/billing/summary?organization_id=${orgId}`, {
      method: "GET",
    }).then((res) => {
      if (!cancelled && res.data && !res.error) setExtras((e) => ({ ...e, billing: res.data }));
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, showBilling]);

  return extras;
}

function AppHome() {
  const { active, loading } = useOrg();
  const orgId = active?.organization.id ?? null;
  const timezone = active?.organization.timezone || "Asia/Kolkata";
  const [data, setData] = useState<HomeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);
  const extras = useHomeExtras(orgId, timezone);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    setFetching(true);
    setError(null);
    callApi<HomeSummary>(`/api/home/summary?organization_id=${orgId}`, { method: "GET" }).then(
      (res) => {
        if (cancelled) return;
        if (res.error) setError(res.error);
        else setData(res.data);
        setFetching(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const name = active?.organization.name ?? "your workspace";

  return (
    <>
      <PageHeader
        title="Home"
        description={`What's happening in ${name} today.`}
        actions={active ? <TodayChip timezone={timezone} /> : undefined}
      />
      <JourneyResume organizationId={orgId} isOwner={active?.role === "owner"} />
      <SendHealthBanner organizationId={orgId} showLink className="mb-6" />
      <AidenSetupCard organizationId={orgId} showFinished />
      <PersonaReviewBanner organizationId={orgId} />
      {loading || (orgId && fetching && !data) ? (
        <HomeSkeleton />
      ) : !active ? (
        <EmptyState
          icon={Inbox}
          title="No workspace selected"
          description="Pick a workspace from the switcher to see today's overview."
        />
      ) : error ? (
        <ErrorState message={error} />
      ) : data ? (
        <HomeBody data={data} extras={extras} timezone={timezone} />
      ) : null}
    </>
  );
}

/** "Thu, 29 Oct · IST" — the day Home's numbers count, in the workspace's own time. */
function TodayChip({ timezone }: { timezone: string }) {
  const now = new Date();
  const day = new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(now);
  const zone =
    new Intl.DateTimeFormat("en-IN", { timeZone: timezone, timeZoneName: "short" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName")?.value ?? "";
  return (
    <span className="inline-flex h-8 items-center gap-2 rounded-full border border-border bg-card px-3 text-[0.8125rem] font-medium text-muted-foreground shadow-xs">
      <span
        className="h-1.5 w-1.5 rounded-full bg-success motion-safe:animate-pulse"
        aria-hidden="true"
      />
      <span>
        Today · {day}
        {zone ? <span className="text-faint"> · {zone}</span> : null}
      </span>
    </span>
  );
}

function HomeSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton
            key={i}
            className={cn("h-[7.5rem] rounded-xl", i === 4 && "col-span-2 sm:col-span-1")}
          />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
    </div>
  );
}

/** A 7-day line under a number; decoration only (the chart below has the values). */
function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const w = 100;
  const h = 28;
  const pts = values.map(
    (v, i) => [(i / (values.length - 1)) * w, h - 2 - (v / max) * (h - 4)] as const,
  );
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-7 w-full overflow-visible", className)}
      aria-hidden="true"
    >
      <path d={`${line} L${w},${h} L0,${h} Z`} className="fill-primary/10" />
      <path
        d={line}
        className="fill-none stroke-primary"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Tile({
  icon: Icon,
  label,
  value,
  hint,
  tone,
  spark,
  className,
  children,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint?: ReactNode;
  /** "warning" when something needs a person (someone waiting, credits low). */
  tone?: "warning" | undefined;
  spark?: number[] | undefined;
  className?: string | undefined;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col rounded-xl border bg-card p-3.5 shadow-xs sm:p-4",
        tone === "warning" ? "border-warning-border" : "border-border",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2 text-[0.8125rem] font-medium leading-snug text-muted-foreground">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
            tone === "warning"
              ? "bg-warning-soft text-warning-soft-foreground"
              : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="min-w-0 pt-0.5">{label}</span>
      </div>
      <div className="tabular mt-3 truncate text-2xl font-bold leading-none tracking-[-0.02em] text-foreground sm:text-[1.75rem]">
        {value}
      </div>
      <div className="mt-auto pt-2">
        {spark && spark.length > 1 ? <Sparkline values={spark} className="mb-1" /> : null}
        {hint ? <div className="line-clamp-2 text-xs text-muted-foreground">{hint}</div> : null}
        {children}
      </div>
    </div>
  );
}

function SectionCard({
  title,
  description,
  link,
  children,
  className,
}: {
  title: string;
  description?: string | undefined;
  link?: { to: string; label: string } | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-border bg-card shadow-xs",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3.5 sm:px-6">
        <div className="min-w-0">
          <h2 className="type-heading text-foreground">{title}</h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {link ? (
          <Link
            to={link.to as never}
            className="inline-flex shrink-0 items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {link.label}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

const SHORTCUTS = [
  { to: "/app/inbox", icon: Inbox, label: "Inbox", hint: "Reply to customers" },
  { to: "/app/employee", icon: BookOpen, label: "Knowledge", hint: "What Aiden knows" },
  { to: "/app/billing", icon: Wallet, label: "Billing", hint: "Credits and plan" },
] as const;

type NextAction = {
  key: string;
  icon: LucideIcon;
  title: string;
  detail: string;
  to: string;
  params?: Record<string, string>;
  tone?: "warning";
};

/** What to do next, worked out from the numbers already on this page. */
function nextActions(data: HomeSummary, extras: HomeExtras): NextAction[] {
  const out: NextAction[] = [];
  if (data.waiting.length > 0)
    out.push({
      key: "waiting",
      icon: HandHelping,
      title: "Reply to the customers waiting on you",
      detail: `Latest: “${data.waiting[0]!.question}”`,
      to: "/app/inbox",
      tone: "warning",
    });
  const wallet = extras.billing?.wallet;
  if (wallet && extras.billing && wallet.available <= extras.billing.settings.low_credit_threshold)
    out.push({
      key: "credits",
      icon: CreditCard,
      title: "Top up your credits",
      detail: `${money(wallet.available, wallet.currency || "INR")} available. Campaigns pause when credits run out.`,
      to: "/app/billing",
      tone: "warning",
    });
  for (const c of extras.campaigns ?? []) {
    if (c.status === "awaiting_approval")
      out.push({
        key: `c-${c.id}`,
        icon: Megaphone,
        title: `Review “${c.name}”`,
        detail: "This campaign is waiting for approval before it sends.",
        to: "/app/campaigns/$id",
        params: { id: c.id },
      });
    else if (c.status === "paused")
      out.push({
        key: `c-${c.id}`,
        icon: Megaphone,
        title: `Check “${c.name}”`,
        detail: "This campaign is paused.",
        to: "/app/campaigns/$id",
        params: { id: c.id },
        tone: "warning",
      });
  }
  if (data.plan.trial_days_left !== null)
    out.push({
      key: "plan",
      icon: Wallet,
      title: "Choose a plan",
      detail: `${data.plan.trial_days_left} day${data.plan.trial_days_left === 1 ? "" : "s"} left in your free trial.`,
      to: "/app/billing",
    });
  if (data.learned.length === 0)
    out.push({
      key: "teach",
      icon: GraduationCap,
      title: "Teach Aiden about your shop",
      detail: "Send a link, a photo of your price list or a PDF.",
      to: "/app/employee",
    });
  const latest = extras.campaigns?.[0];
  if (
    extras.campaigns &&
    (!latest || Date.now() - new Date(latest.created_at).getTime() > 7 * 86_400_000)
  )
    out.push({
      key: "campaign",
      icon: Send,
      title: "Send a campaign",
      detail: "Reach every opted-in customer with one message.",
      to: "/app/campaigns",
    });
  return out.slice(0, 4);
}

function HomeBody({
  data,
  extras,
  timezone,
}: {
  data: HomeSummary;
  extras: HomeExtras;
  timezone: string;
}) {
  // Batch 28: two decimals, the same as Billing (₹98.76, not ₹99).
  const credits = data.credits ? money(data.credits.balance, data.credits.currency || "INR") : "—";
  const planValue =
    data.plan.trial_days_left !== null
      ? `${data.plan.trial_days_left} day${data.plan.trial_days_left === 1 ? "" : "s"}`
      : (data.plan.name ?? "No plan");
  const planLabel = data.plan.trial_days_left !== null ? "Left in free trial" : "Plan";

  const series = extras.series;
  const today = series?.find((p) => p.day === localDate(timezone)) ?? null;
  const billing = extras.billing;
  const low = billing ? billing.wallet.available <= billing.settings.low_credit_threshold : false;
  const actions = nextActions(data, extras);

  return (
    <div className="space-y-6">
      {/* Today at a glance. */}
      <section
        aria-label="Today"
        className={cn(
          "grid grid-cols-2 gap-3",
          today ? "sm:grid-cols-3 xl:grid-cols-5" : "lg:grid-cols-4",
        )}
      >
        <Tile
          icon={MessageSquare}
          label="Conversations today"
          value={count.format(data.today.conversations)}
          spark={series?.map((p) => p.conversations_opened)}
          hint={series ? "Opened per day, last 7 days" : undefined}
        />
        <Tile
          icon={HandHelping}
          label="Passed to you"
          value={count.format(data.today.escalations)}
          hint="Questions Aiden held back on today"
          tone={data.today.escalations > 0 ? "warning" : undefined}
        />
        <Tile
          icon={Bot}
          label="Aiden answered"
          value={count.format(data.today.ai_answers)}
          hint={
            billing && billing.ai_answers.included > 0
              ? `Today · ${count.format(billing.ai_answers.used)}/${count.format(billing.ai_answers.included)} this period`
              : "Today"
          }
        />
        {today ? (
          <Tile
            icon={Send}
            label="Messages sent today"
            value={count.format(today.sent)}
            spark={series?.map((p) => p.sent)}
            hint={`${count.format(today.read)} read · ${count.format(today.replies)} replies`}
          />
        ) : null}
        <Tile
          icon={Coins}
          label="Credits"
          value={credits}
          tone={low ? "warning" : undefined}
          className={today ? "col-span-2 xl:col-span-1" : undefined}
        >
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {low ? (
              <Link
                to="/app/billing"
                className="font-medium text-warning-soft-foreground underline underline-offset-4"
              >
                {money(billing!.wallet.available, billing!.wallet.currency || "INR")} available —
                top up
              </Link>
            ) : (
              <span className="min-w-0 truncate">
                {planLabel}: <span className="font-medium text-foreground">{planValue}</span>
              </span>
            )}
            {data.plan.status ? (
              <Badge
                variant={data.plan.status === "active" ? "success" : "muted"}
                className="rounded-full"
              >
                Status: {data.plan.status}
              </Badge>
            ) : null}
          </div>
        </Tile>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        {series ? <WeekChart series={series} /> : <AidenToday data={data} />}
        <SectionCard title="Next best actions" description="Worked out from today's numbers.">
          {actions.length === 0 ? (
            <div className="flex flex-1 items-center gap-3 px-5 py-6 sm:px-6">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-success-soft-foreground">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              </span>
              <p className="text-sm text-muted-foreground">
                You're all caught up. Nothing needs you right now.
              </p>
            </div>
          ) : (
            <ol className="divide-y divide-border">
              {actions.map((a) => (
                <li key={a.key}>
                  <Link
                    to={a.to as never}
                    params={a.params as never}
                    className="group flex items-start gap-3 px-5 py-3.5 transition-colors duration-150 hover:bg-subtle sm:px-6"
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        a.tone === "warning"
                          ? "bg-warning-soft text-warning-soft-foreground"
                          : "bg-subtle text-primary ring-1 ring-inset ring-border",
                      )}
                    >
                      <a.icon className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-foreground">{a.title}</span>
                      <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                        {a.detail}
                      </span>
                    </span>
                    <ArrowRight
                      className="mt-2 h-4 w-4 shrink-0 text-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
                      aria-hidden="true"
                    />
                  </Link>
                </li>
              ))}
            </ol>
          )}
          <nav aria-label="Shortcuts" className="mt-auto border-t border-border px-2 py-2 sm:px-3">
            {SHORTCUTS.map((sc) => (
              <Link
                key={sc.to}
                to={sc.to}
                className="group flex items-center gap-3 rounded-lg px-3 py-2 transition-colors duration-150 hover:bg-subtle"
              >
                <sc.icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                <span className="text-sm font-medium text-foreground">{sc.label}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {sc.hint}
                </span>
                <ArrowRight
                  className="h-3.5 w-3.5 shrink-0 text-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground"
                  aria-hidden="true"
                />
              </Link>
            ))}
          </nav>
        </SectionCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Waiting on you" link={{ to: "/app/inbox", label: "Open inbox" }}>
          {data.waiting.length === 0 ? (
            <div className="flex items-center gap-3 px-5 py-6 sm:px-6">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-success-soft-foreground">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              </span>
              <p className="text-sm text-muted-foreground">
                Nobody is waiting — every question so far has an answer.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {data.waiting.map((w) => {
                const who =
                  w.contact_name ??
                  (w.source === "onboarding" ? "You, on the merchant chat" : "A customer");
                return (
                  <li
                    key={w.id}
                    className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-subtle sm:px-6"
                  >
                    <ContactAvatar
                      seed={w.conversation_id ?? w.id}
                      label={who}
                      className="h-9 w-9"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">“{w.question}”</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {who}
                        {" · "}
                        {timeAgo(w.asked_at)}
                      </p>
                    </div>
                    {w.conversation_id ? (
                      <Button asChild size="sm" variant="soft" className="shrink-0">
                        <a href={`/app/inbox?c=${w.conversation_id}`}>Reply</a>
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </SectionCard>

        {series ? <AidenToday data={data} /> : <RecentCampaigns campaigns={extras.campaigns} />}
      </div>

      {series ? <RecentCampaigns campaigns={extras.campaigns} /> : null}
    </div>
  );
}

const compactNumber = new Intl.NumberFormat("en-IN", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const compact = (n: number) => compactNumber.format(n);

const SERIES = [
  { key: "sent", label: "Messages sent", color: "var(--chart-1)" },
  { key: "replies", label: "Replies received", color: "var(--chart-2)" },
] as const;

/** The last 7 days: messages out and replies back (Analytics' own daily series). */
function WeekChart({ series }: { series: SeriesPoint[] }) {
  const totals = SERIES.map((s) => ({ ...s, total: series.reduce((n, p) => n + p[s.key], 0) }));
  const empty = totals.every((t) => t.total === 0);
  return (
    <SectionCard
      title="Last 7 days"
      description="Replies are drawn on their own scale."
      link={{ to: "/app/analytics", label: "Analytics" }}
    >
      <div className="flex flex-1 flex-col px-5 pb-4 pt-4 sm:px-6">
        <dl className="flex flex-wrap gap-x-8 gap-y-2">
          {totals.map((t) => (
            <div key={t.key}>
              <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: t.color }}
                  aria-hidden="true"
                />
                {t.label}
              </dt>
              <dd className="tabular mt-0.5 text-lg font-semibold text-foreground">
                {count.format(t.total)}
              </dd>
            </div>
          ))}
        </dl>
        {empty ? (
          <p className="mt-6 rounded-lg border border-dashed border-border bg-subtle px-4 py-8 text-center text-sm text-muted-foreground">
            No messages this week yet. Send a campaign or reply to a customer and it shows here.
          </p>
        ) : (
          <figure
            className="mt-3 h-44 min-w-0 sm:h-52"
            aria-label="Messages sent and replies received per day, last 7 days"
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  {SERIES.map((s) => (
                    <linearGradient key={s.key} id={`home-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={s.color} stopOpacity={0.22} />
                      <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="day"
                  tickFormatter={shortDay}
                  stroke="var(--muted-foreground)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  yAxisId="sent"
                  stroke="var(--muted-foreground)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  width={40}
                  tickFormatter={compact}
                />
                {/* Replies run far below sends: their own scale keeps their shape readable. */}
                <YAxis yAxisId="replies" hide allowDecimals={false} />
                <Tooltip
                  labelFormatter={(d) => shortDay(String(d))}
                  contentStyle={{
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    background: "var(--popover)",
                    color: "var(--popover-foreground)",
                    fontSize: 12,
                    boxShadow: "var(--elev-lg)",
                  }}
                />
                {SERIES.map((s) => (
                  <Area
                    key={s.key}
                    yAxisId={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stroke={s.color}
                    strokeWidth={2}
                    fill={`url(#home-${s.key})`}
                    isAnimationActive={false}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </figure>
        )}
      </div>
    </SectionCard>
  );
}

/** A ring: how much of today Aiden handled without you. */
function Ring({ value }: { value: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 64 64" className="h-16 w-16 shrink-0 -rotate-90" aria-hidden="true">
      <circle cx="32" cy="32" r={r} className="fill-none stroke-muted" strokeWidth="7" />
      <circle
        cx="32"
        cy="32"
        r={r}
        className="fill-none stroke-primary transition-[stroke-dashoffset] duration-700 ease-out"
        strokeWidth="7"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value / 100)}
      />
    </svg>
  );
}

function AidenToday({ data }: { data: HomeSummary }) {
  const asked = data.today.ai_answers + data.today.escalations;
  const share = asked > 0 ? Math.round((data.today.ai_answers / asked) * 100) : null;
  return (
    <SectionCard title="What Aiden did today" link={{ to: "/app/employee", label: "Knowledge" }}>
      <div className="flex items-center gap-4 border-b border-border px-5 py-4 sm:px-6">
        {share !== null ? (
          <div className="relative">
            <Ring value={share} />
            <span
              aria-hidden="true"
              className="tabular absolute inset-0 grid place-items-center text-sm font-semibold text-foreground"
            >
              {share}%
            </span>
          </div>
        ) : (
          <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Bot className="h-6 w-6" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 text-sm">
          <p className="font-medium text-foreground">
            {share !== null
              ? `${count.format(data.today.ai_answers)} answered · ${count.format(data.today.escalations)} passed to you`
              : "No customer questions yet today"}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {share !== null
              ? `Aiden answered ${share}% of today's questions without you.`
              : "Its answers and hand-offs show here as they happen."}
          </p>
        </div>
      </div>
      <h3 className="type-label px-5 pt-3.5 text-muted-foreground sm:px-6">
        What Aiden learned this week
      </h3>
      {data.learned.length === 0 ? (
        <p className="px-5 pb-6 pt-2 text-sm text-muted-foreground sm:px-6">
          Nothing new this week. Send Aiden a link, a photo of your price list or a PDF on the
          merchant chat and it shows up here.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.learned.map((l) => (
            <li
              key={l.source_id ?? "none"}
              className="flex items-center justify-between gap-4 px-5 py-3 sm:px-6"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{l.source_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {SOURCE_LABEL[l.source_type] ?? l.source_type} · {timeAgo(l.latest_at)}
                  </p>
                </div>
              </div>
              <span className="tabular shrink-0 rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-foreground">
                {l.items} item{l.items === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function RecentCampaigns({ campaigns }: { campaigns: CampaignRow[] | null }) {
  if (campaigns === null) return null;
  return (
    <SectionCard title="Campaign results" link={{ to: "/app/campaigns", label: "All campaigns" }}>
      {campaigns.length === 0 ? (
        <div className="flex items-center gap-3 px-5 py-6 sm:px-6">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Megaphone className="h-4 w-4" aria-hidden="true" />
          </span>
          <p className="text-sm text-muted-foreground">
            No campaigns yet.{" "}
            <Link
              to="/app/campaigns"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Create one
            </Link>{" "}
            to reach every opted-in customer at once.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {campaigns.map((c) => (
            <li
              key={c.id}
              className="relative grid gap-3 px-5 py-3.5 transition-colors hover:bg-subtle sm:grid-cols-[minmax(0,1fr)_16rem] sm:items-center sm:px-6"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <Link
                    to="/app/campaigns/$id"
                    params={{ id: c.id }}
                    className="truncate text-sm font-medium text-foreground after:absolute after:inset-0 after:content-['']"
                  >
                    {c.name}
                  </Link>
                  <CampaignStatusBadge status={c.status} />
                </div>
                <p className="tabular mt-0.5 text-xs text-muted-foreground">
                  {count.format(c.sent_count)} of {count.format(c.total_recipients)} sent
                </p>
              </div>
              <RateBars campaign={c} labelled />
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
