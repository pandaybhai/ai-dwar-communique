import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { Check, Lock, Wallet } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageSkeleton } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NumberTicker } from "@/components/design-v2";
import { InvoicesPanel } from "@/components/billing/invoices-panel";
import { PlanChooser, limitLines, type PlanState } from "@/components/billing/plan-chooser";
import {
  BuyCreditsDialog,
  HistoryTabs,
  RequestTopupDialog,
} from "@/components/billing/billing-view";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { useOrg } from "@/lib/org-context";
import { callApi } from "@/lib/whatsapp-client";
import { confirmCashfreeReturn } from "@/lib/cashfree-checkout";
import { creditPurchaseBlock, money, rateMoney, type BillingSummary } from "@/lib/billing";
import { cn } from "@/lib/utils";
import { amountParts, billingStateNote, usageBars, type BillingStateNote } from "./billing-v2";
import { BILLING_COPY as C, CATEGORY_COPY } from "./copy";

/** Staggered entrance (with the nd-rise class): block n arrives n × 70ms after the first. */
const rise = (d: number) => ({ style: { "--d": d } as CSSProperties });

/**
 * An amount that counts up once (Batch 57). It lands on money()'s own text
 * (amountParts: whole rupees tick with ₹ and Indian grouping, the paise sit
 * beside them exact from the start); below zero or another currency it is
 * money()'s text as it was. Screen readers get money().
 */
function Amount({ value, currency }: { value: number; currency: string }) {
  const parts = amountParts(value, currency);
  const text = parts?.text ?? money(value, currency);
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {parts ? (
          <>
            <NumberTicker value={parts.whole} prefix="₹" />
            {parts.rest}
          </>
        ) : (
          text
        )}
      </span>
    </>
  );
}

/** A plain count that ticks while its text is the same either way (no grouping under 1,000). */
function Count({ n }: { n: number }) {
  return Number.isInteger(n) && n >= 0 && n < 1000 ? (
    <>
      <span className="sr-only">{String(n)}</span>
      <NumberTicker value={n} aria-hidden="true" />
    </>
  ) : (
    <>{String(n)}</>
  );
}

/**
 * Batch 50: Billing and wallet in the new design (flag new_design on). The
 * same states as the classic page in the same order — trial and locked pick a
 * plan (PlanChooser, before the billing flag), then the flag, then the
 * billing.view permission — and every payment goes through the classic
 * pieces: PlanChooser (/api/billing/plan), BuyCreditsDialog
 * (/api/billing/purchase → Cashfree checkout), RequestTopupDialog, the
 * invoices panel and the history. Nothing here charges or writes on its own.
 */
export function NewBillingPage() {
  const { active, loading, reload } = useOrg();
  const { can, loading: permsLoading } = usePermissions();
  const { enabled, loading: flagLoading } = useFeatureFlag("billing");

  const org = active?.organization;
  const noPlan = Boolean(org) && !org?.plan_version_id;
  const locked = org?.plan_status === "locked";
  const canTopUp = Boolean(org) && !creditPurchaseBlock(org?.plan_status);

  const note = org
    ? billingStateNote({
        planStatus: org.plan_status ?? null,
        hasPlan: !noPlan,
        trialEndsAt: org.trial_ends_at ?? null,
        now: Date.now(),
      })
    : null;

  return (
    <div className="pb-6">
      <header className="nd-rise mb-7 flex flex-col gap-2">
        <h1 className="min-w-0 font-display text-[clamp(1.75rem,3.4vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-foreground">
          {C.title}
        </h1>
        <p className="max-w-2xl text-body text-muted-foreground">{C.description}</p>
      </header>

      {loading || permsLoading || flagLoading ? (
        <PageSkeleton />
      ) : !active || !org ? (
        <EmptyState icon={Wallet} title={C.noWorkspace.title} description={C.noWorkspace.body} />
      ) : noPlan || locked ? (
        <div className="flex flex-col gap-10">
          {note ? <StateNote note={note} /> : null}
          <div id="plans" className="scroll-mt-4">
            <PlanChooser
              organizationId={org.id}
              mode={locked ? "locked" : "trial"}
              onActivated={() => void reload()}
            />
          </div>
          {enabled && can("billing.view") ? (
            <BillingBody organizationId={org.id} planActive={canTopUp} onTrial={!locked} />
          ) : null}
        </div>
      ) : !enabled ? (
        <EmptyState
          icon={Wallet}
          title={C.notOn.title}
          description={C.notOn.body}
          action={
            <Button asChild variant="outline" className="phone:min-h-11">
              <a href={C.notOn.href}>{C.notOn.action}</a>
            </Button>
          }
        />
      ) : !can("billing.view") ? (
        <EmptyState icon={Lock} title={C.restricted.title} description={C.restricted.body} />
      ) : (
        <div className="flex flex-col gap-10">
          {note ? <StateNote note={note} /> : null}
          <BillingBody organizationId={org.id} planActive={canTopUp} />
          <PlanCards organizationId={org.id} />
        </div>
      )}
    </div>
  );
}

/** Trial, past due, paused, locked or cancelled: what it means and the one thing to do. */
function StateNote({ note }: { note: BillingStateNote }) {
  const go = () =>
    document.getElementById(note.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <section
      aria-label={C.stateLabel}
      className={cn(
        "nd-rise flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[18px] border px-5 py-4",
        note.tone === "danger"
          ? "border-danger-border bg-danger-soft"
          : note.tone === "gold"
            ? "border-gold-line bg-gold-bg"
            : "border-aiden-line bg-aiden-soft",
      )}
      data-state={note.state}
    >
      <div className="min-w-0 flex-1">
        <h2 className="font-display text-lg font-semibold text-foreground">{note.title}</h2>
        <p className="text-body text-foreground">{note.body}</p>
      </div>
      {note.action ? (
        note.href ? (
          <Button
            asChild
            variant={note.tone === "gold" ? "gold" : "default"}
            className="phone:min-h-11"
          >
            <a href={note.href}>{note.action}</a>
          </Button>
        ) : (
          <Button
            variant={note.tone === "gold" ? "gold" : "default"}
            className="phone:min-h-11"
            onClick={go}
          >
            {note.action}
          </Button>
        )
      ) : null}
    </section>
  );
}

/**
 * The summary, read and refreshed exactly as the classic BillingView does:
 * GET /api/billing/summary, and back from Cashfree (?payment=) our server
 * confirms the payment with the gateway (never the redirect alone).
 */
function useBillingSummary(organizationId: string) {
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await callApi<BillingSummary>(
      `/api/billing/summary?organization_id=${organizationId}`,
      { method: "GET" },
    );
    setLoading(false);
    if (error || !data) {
      setFailed(error ?? C.loadFailed.body);
      return;
    }
    setFailed(null);
    setSummary(data);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get("payment");
    if (!paymentId) return;
    let tries = 0;
    let done = false;
    const timer = window.setInterval(() => {
      tries += 1;
      void (async () => {
        if (!done) {
          const status = await confirmCashfreeReturn(paymentId);
          if (status === "paid" || status === "failed") done = true;
          if (status === "failed" && tries === 1) toast.error(C.paymentFailed);
        }
        await load();
      })();
      if (tries >= 8) window.clearInterval(timer);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  return { summary, loading, failed, retry: () => (setLoading(true), void load()) };
}

function BillingBody({
  organizationId,
  planActive = true,
  onTrial = false,
}: {
  organizationId: string;
  planActive?: boolean;
  onTrial?: boolean;
}) {
  const { can } = usePermissions();
  const { summary, loading, failed, retry } = useBillingSummary(organizationId);
  const [buyOpen, setBuyOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);

  if (loading) {
    // The page's own shape: the wallet card, then this month's lines.
    return (
      <div
        className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:gap-10"
        aria-busy="true"
        aria-label={C.loadingLabel}
      >
        <div className="flex flex-col gap-4 rounded-[20px] border border-border bg-card p-6 sm:p-8">
          <Skeleton className="h-5 w-36 rounded-lg" />
          <Skeleton className="h-14 w-56 rounded-xl" />
          <Skeleton className="h-4 w-32 rounded-lg" />
          <Skeleton className="mt-2 h-11 w-32 rounded-xl" />
        </div>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-6 w-32 rounded-lg" />
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (failed || !summary) {
    return (
      <EmptyState
        icon={Wallet}
        title={C.loadFailed.title}
        description={failed ?? C.loadFailed.body}
        action={
          <Button onClick={retry} className="phone:min-h-11">
            {C.loadFailed.retry}
          </Button>
        }
      />
    );
  }

  const wallet = summary.wallet;
  const low = wallet.available <= summary.settings.low_credit_threshold;
  const aiUsed = summary.ai_answers.used;
  const aiIncluded = summary.ai_answers.included;
  const since = new Date(summary.period.start).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
  });
  const payButton = can("billing.pay");
  const askButton = can("billing.request") && !can("billing.pay");

  return (
    <div className="flex flex-col gap-10">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:gap-10">
        <section
          aria-labelledby="wallet-title"
          {...rise(0)}
          className="nd-rise flex flex-col gap-5 rounded-[20px] border border-border bg-card p-6 shadow-md sm:p-8"
        >
          <div className="flex flex-col gap-1">
            <h2 id="wallet-title" className="text-body font-semibold text-muted-foreground">
              {C.walletTitle}
            </h2>
            <p className="font-display text-[clamp(2.5rem,6vw,3.75rem)] font-extrabold leading-none tracking-[-0.03em] text-foreground">
              <Amount value={wallet.available} currency={wallet.currency} />
            </p>
            <p className="text-body text-muted-foreground">
              {wallet.held > 0 ? C.held(money(wallet.held, wallet.currency)) : C.ready}
            </p>
          </div>
          {low ? (
            <p className="rounded-xl bg-gold-bg px-4 py-3 text-body text-gold-ink">
              <span className="font-semibold">{C.lowTitle}</span> {C.lowBody}
            </p>
          ) : null}
          {payButton || askButton ? (
            // The page's main action sits in the first screen on a phone too (390px).
            <div className="flex flex-wrap items-center gap-3">
              {payButton ? (
                <Button
                  size="lg"
                  className="phone:min-h-11"
                  onClick={() => setBuyOpen(true)}
                  disabled={!planActive}
                >
                  {C.topUp}
                </Button>
              ) : null}
              {askButton ? (
                <Button
                  size="lg"
                  variant="outline"
                  className="phone:min-h-11"
                  disabled={!planActive}
                  onClick={() => setAskOpen(true)}
                >
                  {C.requestTopUp}
                </Button>
              ) : null}
            </div>
          ) : null}
          {!planActive ? <p className="text-sm text-muted-foreground">{C.planFirst}</p> : null}
        </section>

        <section aria-labelledby="month-title" {...rise(1)} className="nd-rise flex flex-col gap-1">
          <h2 id="month-title" className="font-display text-lg font-semibold text-foreground">
            {C.monthTitle}
          </h2>
          <dl className="flex flex-col">
            <Stat label={C.spentSince(since)}>
              <Amount value={summary.usage_total} currency={wallet.currency} />
            </Stat>
            <Stat
              label={C.aiAnswers}
              note={aiIncluded > 0 ? C.aiIncluded : C.aiPayAsYouGo}
              bar={
                aiIncluded > 0 ? (
                  <div
                    className="h-2 overflow-hidden rounded-full bg-line"
                    role="img"
                    aria-label={C.aiBar(aiUsed, aiIncluded)}
                  >
                    <i
                      className="nd-bar-grow block h-full rounded-full bg-aiden"
                      style={{
                        width: `${Math.min(100, (aiUsed / Math.max(aiIncluded, 1)) * 100)}%`,
                      }}
                    />
                  </div>
                ) : null
              }
            >
              {aiIncluded > 0 ? (
                <>
                  <Count n={aiUsed} /> of {aiIncluded}
                </>
              ) : (
                <Count n={aiUsed} />
              )}
            </Stat>
            <Stat
              label={C.yourPlan}
              note={
                onTrial
                  ? C.planPickAbove
                  : summary.plan.price_monthly
                    ? C.planPerMonth(money(summary.plan.price_monthly, wallet.currency))
                    : C.planTalk
              }
            >
              {onTrial ? C.planTrial : (summary.plan.name ?? C.planNone)}
            </Stat>
          </dl>
        </section>
      </div>

      <div {...rise(2)} className="nd-rise grid gap-6 lg:grid-cols-2 lg:gap-10">
        <UsageChart summary={summary} />
        <section aria-labelledby="rates-title" className="flex flex-col gap-3">
          <h2 id="rates-title" className="font-display text-lg font-semibold text-foreground">
            {C.ratesTitle}
          </h2>
          <table className="w-full text-body">
            <tbody>
              {summary.rates.map((rate) => (
                <tr key={rate.category} className="border-b border-border last:border-0">
                  <td className="py-2.5 text-muted-foreground">
                    {CATEGORY_COPY[rate.category] ?? rate.category}
                  </td>
                  <td className="py-2.5 text-right font-semibold tabular-nums">
                    {rate.rate === null ? "—" : rateMoney(rate.rate, rate.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-sm text-muted-foreground">
            {summary.gst_registered === false ? C.ratesNoGst : C.ratesGst} {C.ratesFree}
          </p>
        </section>
      </div>

      <div id="invoices" {...rise(3)} className="nd-rise scroll-mt-4">
        <InvoicesPanel
          organizationId={organizationId}
          gstRegistered={summary.gst_registered !== false}
        />
      </div>

      <div {...rise(4)} className="nd-rise">
        <HistoryTabs organizationId={organizationId} currency={wallet.currency} />
      </div>

      <BuyCreditsDialog
        open={buyOpen}
        onOpenChange={setBuyOpen}
        organizationId={organizationId}
        packs={summary.packs}
      />
      <RequestTopupDialog
        open={askOpen}
        onOpenChange={setAskOpen}
        organizationId={organizationId}
      />
    </div>
  );
}

function Stat({
  label,
  note,
  bar,
  children,
}: {
  label: string;
  note?: string;
  bar?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1.5 border-b border-border py-3 last:border-0">
      <dt className="text-body text-muted-foreground">{label}</dt>
      <dd className="text-right font-display text-xl font-semibold tabular-nums text-foreground">
        {children}
      </dd>
      {bar || note ? (
        <dd className="col-span-2 flex flex-col gap-1.5">
          {bar}
          {note ? <span className="text-sm text-muted-foreground">{note}</span> : null}
        </dd>
      ) : null}
    </div>
  );
}

/** Where the month's credits went, one bar per kind, largest first (summary.usage). */
function UsageChart({ summary }: { summary: BillingSummary }) {
  const bars = usageBars(summary.usage);
  const currency = summary.wallet.currency;
  return (
    <section aria-labelledby="usage-title" className="flex flex-col gap-3">
      <h2 id="usage-title" className="font-display text-lg font-semibold text-foreground">
        {C.usageTitle}
      </h2>
      {bars.length === 0 ? (
        <p className="text-body text-muted-foreground">{C.usageEmpty}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {bars.map((b) => (
            <li key={b.category} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-body">
                <span className="text-foreground">{b.label}</span>
                <span className="font-semibold tabular-nums text-foreground">
                  {money(b.amount, currency)}
                </span>
              </div>
              <div className="h-3 overflow-hidden rounded-full bg-line" aria-hidden="true">
                <i
                  className="nd-bar-grow block h-full rounded-full bg-aiden"
                  style={{ width: `${b.share}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The plans, read from GET /api/billing/plan, with the workspace's own plan
 * highlighted. Read only: an active workspace changes plan by talking to us,
 * as before (the classic page has no plan switch for it).
 */
function PlanCards({ organizationId }: { organizationId: string }) {
  const [state, setState] = useState<PlanState | null>(null);
  useEffect(() => {
    let live = true;
    void callApi<PlanState>(`/api/billing/plan?organization_id=${organizationId}`, {
      method: "GET",
    }).then(({ data }) => {
      if (live && data) setState(data);
    });
    return () => {
      live = false;
    };
  }, [organizationId]);

  if (!state || state.plans.length === 0) return null;
  const currentKey = state.current_plan?.key ?? null;

  return (
    <section aria-labelledby="plans-title" {...rise(5)} className="nd-rise flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="plans-title" className="font-display text-[1.375rem] font-semibold text-foreground">
          {C.plansTitle}
        </h2>
        <p className="text-body text-muted-foreground">
          {C.plansChange}{" "}
          <a
            className="font-semibold text-aiden-deep underline-offset-4 hover:underline"
            href="mailto:hello@aidwar.in?subject=Change%20plan"
          >
            hello@aidwar.in
          </a>
          .
        </p>
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {state.plans.map((plan) => {
          const current = plan.key === currentKey;
          const custom = plan.price_monthly === null || plan.price_monthly <= 0;
          return (
            <li
              key={plan.key}
              aria-current={current ? "true" : undefined}
              className={cn(
                "flex flex-col gap-4 rounded-[20px] border bg-card p-6",
                current ? "border-ink shadow-lg ring-1 ring-ink" : "border-border shadow-md",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-lg font-semibold text-foreground">{plan.name}</h3>
                {current ? (
                  <span className="rounded-full bg-ink px-2.5 py-0.5 text-xs font-bold text-ink-foreground">
                    {C.currentPlan}
                  </span>
                ) : null}
              </div>
              {plan.tagline ? (
                <p className="-mt-2 text-sm text-muted-foreground">{plan.tagline}</p>
              ) : null}
              <div>
                {custom ? (
                  <p className="font-display text-[1.75rem] font-semibold">{C.custom}</p>
                ) : (
                  <>
                    <p className="font-display text-[1.75rem] font-semibold tabular-nums">
                      {money(plan.price_monthly, plan.currency)}
                      <span className="font-sans text-sm font-normal text-muted-foreground">
                        {" "}
                        {C.perMonth}
                      </span>
                    </p>
                    {state.gst_registered === true ? (
                      <p className="text-xs text-muted-foreground">{C.plusGst}</p>
                    ) : null}
                  </>
                )}
              </div>
              <ul className="flex flex-col gap-1.5 text-sm">
                {[...limitLines(plan.limits), ...plan.highlights.slice(0, 4)].map((line) => (
                  <li key={line} className="flex items-start gap-2">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-aiden-deep" aria-hidden="true" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
