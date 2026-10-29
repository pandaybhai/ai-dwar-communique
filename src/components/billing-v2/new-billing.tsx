import { useCallback, useEffect, useState } from "react";
import { Check, Lock, Wallet } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, PageSkeleton } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { NumberTicker } from "@/components/magicui/number-ticker";
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
import { billingStateNote, usageBars, type BillingStateNote } from "./billing-v2";

const DESCRIPTION =
  "Your credits, what each message costs, payments and invoices — all in one place.";

const CATEGORY_COPY: Record<string, string> = {
  marketing: "Promotions and offers",
  utility: "Order and account updates",
  authentication: "One-time passcodes",
  service: "Replies inside the 24-hour window",
};

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
      <header className="mb-7 flex flex-col gap-2">
        <h1 className="min-w-0 font-display text-[clamp(1.75rem,3.4vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-foreground">
          Billing and wallet
        </h1>
        <p className="max-w-2xl text-body text-muted-foreground">{DESCRIPTION}</p>
      </header>

      {loading || permsLoading || flagLoading ? (
        <PageSkeleton />
      ) : !active || !org ? (
        <EmptyState
          icon={Wallet}
          title="No workspace selected"
          description="Pick a workspace from the switcher to see its billing."
        />
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
          title="Billing isn't switched on"
          description="This workspace doesn't manage credits here yet. Talk to us if you'd like it turned on."
        />
      ) : !can("billing.view") ? (
        <EmptyState
          icon={Lock}
          title="Billing is restricted"
          description='You need the "View billing" permission for this workspace. Ask an owner or admin to grant it.'
        />
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
      aria-label="Plan status"
      className={cn(
        "flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[18px] border px-5 py-4",
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
          <Button asChild variant={note.tone === "gold" ? "gold" : "default"}>
            <a href={note.href}>{note.action}</a>
          </Button>
        ) : (
          <Button variant={note.tone === "gold" ? "gold" : "default"} onClick={go}>
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
      setFailed(error ?? "We couldn't load your billing just now.");
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
          if (status === "failed" && tries === 1)
            toast.error("That payment didn't go through. You can try again.");
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
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
        <Skeleton className="h-56 rounded-[20px]" />
        <Skeleton className="h-56 rounded-[20px]" />
      </div>
    );
  }

  if (failed || !summary) {
    return (
      <EmptyState
        icon={Wallet}
        title="We couldn't load your billing"
        description={failed ?? "Please try again in a moment."}
        action={<Button onClick={retry}>Try again</Button>}
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
  const decimals = (n: number) => (Number.isInteger(n) ? 0 : 2);

  return (
    <div className="flex flex-col gap-10">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)] lg:gap-10">
        <section
          aria-labelledby="wallet-title"
          className="flex flex-col gap-5 rounded-[20px] border border-border bg-card p-6 shadow-md sm:p-8"
        >
          <div className="flex flex-col gap-1">
            <h2 id="wallet-title" className="text-body font-semibold text-muted-foreground">
              Credits available
            </h2>
            <p className="font-display text-[clamp(2.5rem,6vw,3.75rem)] font-extrabold leading-none tracking-[-0.03em] text-foreground">
              <span className="sr-only">{money(wallet.available, wallet.currency)}</span>
              <NumberTicker
                aria-hidden="true"
                value={wallet.available}
                decimalPlaces={decimals(wallet.available)}
                prefix={wallet.currency === "INR" ? "₹" : ""}
              />
            </p>
            <p className="text-body text-muted-foreground">
              {wallet.held > 0
                ? `${money(wallet.held, wallet.currency)} held for campaigns`
                : "Ready to spend"}
            </p>
          </div>
          {low ? (
            <p className="rounded-xl bg-gold-bg px-4 py-3 text-body text-gold-ink">
              <span className="font-semibold">Credits are running low.</span> Top up so your
              campaigns and replies keep going out.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {can("billing.pay") ? (
              <Button size="lg" onClick={() => setBuyOpen(true)} disabled={!planActive}>
                Top up
              </Button>
            ) : null}
            {can("billing.request") && !can("billing.pay") ? (
              <Button
                size="lg"
                variant="outline"
                disabled={!planActive}
                onClick={() => setAskOpen(true)}
              >
                Request a top-up
              </Button>
            ) : null}
          </div>
          {!planActive ? (
            <p className="text-sm text-muted-foreground">
              Pick a plan first — a locked or cancelled workspace can't buy credits.
            </p>
          ) : null}
        </section>

        <section aria-labelledby="month-title" className="flex flex-col gap-1">
          <h2 id="month-title" className="font-display text-lg font-semibold text-foreground">
            This month
          </h2>
          <dl className="flex flex-col">
            <Stat label={`Spent since ${since}`}>
              {money(summary.usage_total, wallet.currency)}
            </Stat>
            <Stat
              label="AI answers"
              note={aiIncluded > 0 ? "Included in your plan this month" : "Charged as you go"}
              bar={
                aiIncluded > 0 ? (
                  <div
                    className="h-2 overflow-hidden rounded-full bg-line"
                    role="img"
                    aria-label={`${aiUsed} of ${aiIncluded} included AI answers used`}
                  >
                    <i
                      className="nd-bar-grow block h-full rounded-full bg-aiden"
                      style={{ width: `${Math.min(100, (aiUsed / Math.max(aiIncluded, 1)) * 100)}%` }}
                    />
                  </div>
                ) : null
              }
            >
              {aiIncluded > 0 ? `${aiUsed} of ${aiIncluded}` : String(aiUsed)}
            </Stat>
            <Stat
              label="Your plan"
              note={
                onTrial
                  ? "Pick a plan above to start"
                  : summary.plan.price_monthly
                    ? `${money(summary.plan.price_monthly, wallet.currency)} a month`
                    : "Talk to us about a plan"
              }
            >
              {onTrial ? "Trial — no plan yet" : (summary.plan.name ?? "No plan yet")}
            </Stat>
          </dl>
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:gap-10">
        <UsageChart summary={summary} />
        <section aria-labelledby="rates-title" className="flex flex-col gap-3">
          <h2 id="rates-title" className="font-display text-lg font-semibold text-foreground">
            What a message costs you
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
            Prices are per message, before 18% GST. Replies inside the 24-hour window are free.
          </p>
        </section>
      </div>

      <div id="invoices" className="scroll-mt-4">
        <InvoicesPanel organizationId={organizationId} />
      </div>

      <HistoryTabs organizationId={organizationId} currency={wallet.currency} />

      <BuyCreditsDialog
        open={buyOpen}
        onOpenChange={setBuyOpen}
        organizationId={organizationId}
        packs={summary.packs}
      />
      <RequestTopupDialog open={askOpen} onOpenChange={setAskOpen} organizationId={organizationId} />
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
        Where your credits went
      </h2>
      {bars.length === 0 ? (
        <p className="text-body text-muted-foreground">
          Nothing spent yet this month — your first campaign will show up here.
        </p>
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
    <section aria-labelledby="plans-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="plans-title" className="font-display text-[1.375rem] font-semibold text-foreground">
          Plans
        </h2>
        <p className="text-body text-muted-foreground">
          To change your plan, write to{" "}
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
                current
                  ? "border-ink shadow-lg ring-1 ring-ink"
                  : "border-border shadow-md",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-display text-lg font-semibold text-foreground">{plan.name}</h3>
                {current ? (
                  <span className="rounded-full bg-ink px-2.5 py-0.5 text-xs font-bold text-ink-foreground">
                    Current plan
                  </span>
                ) : null}
              </div>
              {plan.tagline ? (
                <p className="-mt-2 text-sm text-muted-foreground">{plan.tagline}</p>
              ) : null}
              <div>
                {custom ? (
                  <p className="font-display text-[1.75rem] font-semibold">Custom</p>
                ) : (
                  <>
                    <p className="font-display text-[1.75rem] font-semibold tabular-nums">
                      {money(plan.price_monthly, plan.currency)}
                      <span className="font-sans text-sm font-normal text-muted-foreground">
                        {" "}
                        / month
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">+ 18% GST</p>
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
