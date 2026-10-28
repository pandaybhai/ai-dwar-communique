import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  ArrowRight,
  BookOpen,
  Bot,
  CheckCircle2,
  Coins,
  HandHelping,
  Inbox,
  MessageSquare,
  Sparkles,
  Wallet,
} from "lucide-react";
import { AidenSetupCard } from "@/components/aiden-setup-card";
import { PersonaReviewBanner } from "@/components/persona-review-banner";
import { SendHealthBanner } from "@/components/send-health-banner";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ContactAvatar } from "@/components/inbox/contact-avatar";
import { cn } from "@/lib/utils";
import { useOrg } from "@/lib/org-context";
import { callApi } from "@/lib/whatsapp-client";
import { money } from "@/lib/billing";
import type { HomeSummary } from "@/lib/home.server";

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
  component: AppHome,
});

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

function AppHome() {
  const { active, loading } = useOrg();
  const orgId = active?.organization.id ?? null;
  const [data, setData] = useState<HomeSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);

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
      <PageHeader title="Home" description={`What's happening in ${name} today.`} />
      <SendHealthBanner organizationId={orgId} showLink className="mb-6" />
      <AidenSetupCard organizationId={orgId} showFinished />
      <PersonaReviewBanner organizationId={orgId} />
      {loading || (orgId && fetching && !data) ? (
        <PageSkeleton />
      ) : !active ? (
        <EmptyState
          icon={Inbox}
          title="No workspace selected"
          description="Pick a workspace from the switcher to see today's overview."
        />
      ) : error ? (
        <ErrorState message={error} />
      ) : data ? (
        <HomeBody data={data} />
      ) : null}
    </>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: typeof Inbox;
  label: string;
  value: string;
  hint?: string | undefined;
  /** Batch 41: "warning" when something is waiting on a person. */
  tone?: "warning" | undefined;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-3.5 sm:grid-cols-1 sm:content-start sm:px-6 sm:py-5">
      <div className="flex min-w-0 items-center gap-2 text-[0.8125rem] font-medium text-muted-foreground">
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
            tone === "warning" ? "bg-warning-soft text-warning-soft-foreground" : "bg-primary/10 text-primary",
          )}
        >
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        <span className="truncate">{label}</span>
      </div>
      <div className="tabular row-span-2 text-2xl font-bold leading-none tracking-[-0.02em] text-foreground sm:row-span-1 sm:mt-3 sm:text-[2rem]">
        {value}
      </div>
      {hint ? <div className="col-start-1 mt-1 text-xs text-muted-foreground sm:mt-2">{hint}</div> : null}
    </div>
  );
}

function SectionCard({
  title,
  link,
  children,
  className,
}: {
  title: string;
  link?: { to: string; label: string } | undefined;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <section className={cn("min-w-0 rounded-xl border border-border bg-card shadow-xs", className)}>
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5 sm:px-6">
        <h2 className="type-heading text-foreground">{title}</h2>
        {link ? (
          <Link
            to={link.to as never}
            className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline"
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

function HomeBody({ data }: { data: HomeSummary }) {
  // Batch 28: two decimals, the same as Billing (₹98.76, not ₹99).
  const credits = data.credits ? money(data.credits.balance, data.credits.currency || "INR") : "—";
  const planValue =
    data.plan.trial_days_left !== null
      ? `${data.plan.trial_days_left} day${data.plan.trial_days_left === 1 ? "" : "s"}`
      : (data.plan.name ?? "No plan");
  const planLabel = data.plan.trial_days_left !== null ? "Left in free trial" : "Plan";

  return (
    <div className="space-y-6">
      {/* Today's work, in one band; the account's facts beside it. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-label="Today" className="min-w-0 rounded-xl border border-border bg-card shadow-xs">
          <div className="grid h-full divide-y divide-border sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <Stat icon={MessageSquare} label="Conversations today" value={String(data.today.conversations)} />
            <Stat icon={Bot} label="Aiden answered" value={String(data.today.ai_answers)} hint="Today" />
            <Stat
              icon={HandHelping}
              label="Passed to you"
              value={String(data.today.escalations)}
              hint="Questions Aiden held back on today"
              tone={data.today.escalations > 0 ? "warning" : undefined}
            />
          </div>
        </section>
        <section aria-label="Your account" className="grid grid-cols-2 divide-x divide-border rounded-xl border border-border bg-card shadow-xs xl:grid-cols-1 xl:divide-x-0 xl:divide-y">
          <div className="min-w-0 px-5 py-4">
            <div className="flex items-center gap-2 text-[0.8125rem] font-medium text-muted-foreground">
              <Coins className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              Credits
            </div>
            <div className="tabular mt-1.5 truncate text-xl font-semibold tracking-[-0.01em] text-foreground">{credits}</div>
          </div>
          <div className="min-w-0 px-5 py-4">
            <div className="flex items-center gap-2 text-[0.8125rem] font-medium text-muted-foreground">
              <Wallet className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              {planLabel}
            </div>
            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="truncate text-xl font-semibold tracking-[-0.01em] text-foreground">{planValue}</span>
              {data.plan.status ? (
                <Badge variant={data.plan.status === "active" ? "success" : "muted"} className="rounded-full">
                  Status: {data.plan.status}
                </Badge>
              ) : null}
            </div>
          </div>
        </section>
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
                const who = w.contact_name ?? (w.source === "onboarding" ? "You, on the merchant chat" : "A customer");
                return (
                  <li key={w.id} className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-subtle sm:px-6">
                    <ContactAvatar seed={w.conversation_id ?? w.id} label={who} className="h-9 w-9" />
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

        <SectionCard title="What Aiden learned this week" link={{ to: "/app/employee", label: "Knowledge" }}>
          {data.learned.length === 0 ? (
            <p className="px-5 py-6 text-sm text-muted-foreground sm:px-6">
              Nothing new this week. Send Aiden a link, a photo of your price list or a PDF on the
              merchant chat and it shows up here.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {data.learned.map((l) => (
                <li key={l.source_id ?? "none"} className="flex items-center justify-between gap-4 px-5 py-3.5 sm:px-6">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
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
      </div>

      <nav aria-label="Shortcuts" className="grid gap-3 sm:grid-cols-3">
        {[
          { to: "/app/inbox", icon: Inbox, label: "Inbox", hint: "Reply to customers" },
          { to: "/app/employee", icon: BookOpen, label: "Knowledge", hint: "What Aiden knows" },
          { to: "/app/billing", icon: Wallet, label: "Billing", hint: "Credits and plan" },
        ].map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className="group flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3.5 shadow-xs transition-[box-shadow,border-color] duration-150 hover:border-border-strong hover:shadow-md"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-primary ring-1 ring-inset ring-border">
              <s.icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-foreground">{s.label}</div>
              <div className="truncate text-xs text-muted-foreground">{s.hint}</div>
            </div>
            <ArrowRight className="h-4 w-4 text-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-foreground" aria-hidden="true" />
          </Link>
        ))}
      </nav>
    </div>
  );
}
