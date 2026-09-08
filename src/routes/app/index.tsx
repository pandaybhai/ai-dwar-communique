import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Bot,
  Coins,
  HandHelping,
  Inbox,
  MessageSquare,
  Sparkles,
  Wallet,
} from "lucide-react";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { useOrg } from "@/lib/org-context";
import { callApi } from "@/lib/whatsapp-client";
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
}: {
  icon: typeof Inbox;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-shadow duration-200 hover:shadow-md">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4 text-primary" />
        {label}
      </div>
      <div className="mt-2 text-3xl font-bold tracking-tight text-foreground">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

function HomeBody({ data }: { data: HomeSummary }) {
  const credits = data.credits
    ? new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: data.credits.currency || "INR",
        maximumFractionDigits: 0,
      }).format(data.credits.balance)
    : "—";
  const planValue =
    data.plan.trial_days_left !== null
      ? `${data.plan.trial_days_left} day${data.plan.trial_days_left === 1 ? "" : "s"}`
      : (data.plan.name ?? "No plan");
  const planLabel = data.plan.trial_days_left !== null ? "Left in free trial" : "Plan";

  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat icon={MessageSquare} label="Conversations today" value={String(data.today.conversations)} />
        <Stat icon={Bot} label="Aiden answered" value={String(data.today.ai_answers)} hint="Today" />
        <Stat
          icon={HandHelping}
          label="Passed to you"
          value={String(data.today.escalations)}
          hint="Questions Aiden held back on today"
        />
        <Stat icon={Coins} label="Credits" value={credits} />
        <Stat
          icon={Wallet}
          label={planLabel}
          value={planValue}
          hint={data.plan.status ? `Status: ${data.plan.status}` : undefined}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold text-foreground">Waiting on you</h2>
            <Link to="/app/inbox" className="text-sm font-medium text-primary hover:underline">
              Open inbox
            </Link>
          </div>
          {data.waiting.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Nobody is waiting — every question so far has an answer.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-border/70">
              {data.waiting.map((w) => (
                <li key={w.id} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">“{w.question}”</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {w.contact_name ?? (w.source === "onboarding" ? "You, on the merchant chat" : "A customer")}
                      {" · "}
                      {timeAgo(w.asked_at)}
                    </p>
                  </div>
                  {w.conversation_id ? (
                    <Button asChild size="sm" variant="outline" className="shrink-0">
                      <a href={`/app/inbox?c=${w.conversation_id}`}>Reply</a>
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-2xl border border-border/70 bg-card p-6 shadow-sm">
          <div className="flex items-center justify-between gap-4">
            <h2 className="text-lg font-semibold text-foreground">What Aiden learned this week</h2>
            <Link to="/app/employee" className="text-sm font-medium text-primary hover:underline">
              Knowledge
            </Link>
          </div>
          {data.learned.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">
              Nothing new this week. Send Aiden a link, a photo of your price list or a PDF on the
              merchant chat and it shows up here.
            </p>
          ) : (
            <ul className="mt-4 divide-y divide-border/70">
              {data.learned.map((l) => (
                <li key={l.source_id ?? "none"} className="flex items-center justify-between gap-4 py-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                      <Sparkles className="h-4 w-4 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{l.source_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {SOURCE_LABEL[l.source_type] ?? l.source_type} · {timeAgo(l.latest_at)}
                      </p>
                    </div>
                  </div>
                  <span className="shrink-0 text-sm font-semibold text-foreground">
                    {l.items} item{l.items === 1 ? "" : "s"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { to: "/app/inbox", icon: Inbox, label: "Inbox", hint: "Reply to customers" },
          { to: "/app/employee", icon: BookOpen, label: "Knowledge", hint: "What Aiden knows" },
          { to: "/app/billing", icon: Wallet, label: "Billing", hint: "Credits and plan" },
        ].map((s) => (
          <Link
            key={s.to}
            to={s.to}
            className="group flex items-center justify-between rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
          >
            <div className="flex items-center gap-3">
              <s.icon className="h-5 w-5 text-primary" />
              <div>
                <div className="text-sm font-semibold text-foreground">{s.label}</div>
                <div className="text-xs text-muted-foreground">{s.hint}</div>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        ))}
      </div>
    </div>
  );
}
