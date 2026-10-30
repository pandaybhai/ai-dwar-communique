import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { money, type CampaignCostEstimate } from "@/lib/billing";
import { cn } from "@/lib/utils";
import { costCopy, customers, stepsCopy } from "./copy";
import { count } from "./data";

/**
 * Batch 47: the campaign wizard's chrome in the new design. The wizard's
 * steps, checks and requests are Batch 41's own (campaign-wizard.tsx); with
 * new_design on it draws these instead of its step bar and cost card.
 */

/** Audience, message, personalise, test send, review and cost; Launch is the last button. */
export const ND_STEP_LABELS = stepsCopy.labels;

/** A calm numbered stepper: done steps can be revisited, the current one is the soft pill. */
export function NdSteps({ step, onBack }: { step: number; onBack: (to: number) => void }) {
  return (
    <div>
      <ol
        className="m-0 hidden list-none flex-wrap items-center gap-1 p-0 wide:flex"
        aria-label={stepsCopy.listLabel}
      >
        {ND_STEP_LABELS.map((label, i) => {
          const done = i < step;
          const current = i === step;
          const inner = (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  "grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold tabular-nums",
                  current
                    ? "bg-aiden-deep text-ink-foreground"
                    : done
                      ? "bg-aiden-soft text-aiden-deep"
                      : "border border-line bg-surface text-muted-foreground",
                )}
              >
                {done ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              {label}
            </>
          );
          return (
            <li key={label} aria-current={current ? "step" : undefined}>
              {done ? (
                <button
                  type="button"
                  onClick={() => onBack(i)}
                  className="inline-flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3 text-sm font-semibold text-aiden-deep transition-colors duration-200 hover:bg-aiden-soft"
                  aria-label={stepsCopy.backTo(label)}
                >
                  {inner}
                </button>
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full py-1.5 pl-1.5 pr-3 text-sm font-semibold",
                    current ? "bg-aiden-soft text-aiden-deep" : "text-muted-foreground",
                  )}
                >
                  {inner}
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p className="m-0 text-sm text-muted-foreground wide:hidden">
        {stepsCopy.stepOf(step + 1, ND_STEP_LABELS.length)}
        <span className="font-semibold text-foreground">{ND_STEP_LABELS[step]}</span>
      </p>
    </div>
  );
}

/** The wizard passes its whole audience summary; only these two counts are shown. */
type Audience = { eligible: number; excluded?: number } | null;

/** One line of the summary: the preview's "Who gets it", "Skipped", "Cost", "Your wallet after this". */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-t border-line py-2.5 first:border-t-0 first:pt-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="m-0 text-right font-semibold tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

/**
 * The cost beside the phone: the wizard's own estimate (/api/campaigns/estimate),
 * nothing priced here. Batch 57: the approved summary words. "Your wallet
 * after this" is the estimate's own spendable credits less its own cost, shown
 * only while billing is on and the wallet covers it.
 */
export function NdCostPanel({
  audience,
  audienceLoading,
  estimate,
}: {
  audience: Audience;
  audienceLoading: boolean;
  estimate: CampaignCostEstimate | null;
}) {
  const walletAfter =
    estimate && estimate.enabled && estimate.can_send
      ? Math.round((estimate.available - estimate.estimate) * 100) / 100
      : null;
  const skipped = audience?.excluded ?? 0;
  return (
    <section
      aria-label={costCopy.label}
      aria-live="polite"
      className={cn(
        "w-full rounded-[18px] border bg-surface p-4 shadow-md",
        estimate && !estimate.can_send ? "border-danger-border" : "border-line",
      )}
    >
      <dl className="m-0 flex flex-col">
        {audience ? <Row label={costCopy.whoGetsIt}>{customers(audience.eligible)}</Row> : null}
        {audience && skipped > 0 ? (
          <Row label={costCopy.skipped}>{count.format(skipped)}</Row>
        ) : null}
        <Row label={costCopy.cost}>
          <span className="font-display text-2xl font-semibold">
            {estimate ? money(estimate.estimate, estimate.currency) : "–"}
          </span>
        </Row>
        {walletAfter !== null && walletAfter >= 0 && estimate ? (
          <Row label={costCopy.walletAfter}>{money(walletAfter, estimate.currency)}</Row>
        ) : null}
      </dl>
      <p className="m-0 mt-1 text-sm text-muted-foreground">
        {estimate
          ? costCopy.perMessage(money(estimate.rate, estimate.currency))
          : audienceLoading
            ? costCopy.counting
            : audience
              ? costCopy.pickTemplate
              : costCopy.pickAudience}
      </p>
      {estimate && !estimate.can_send ? (
        <p className="m-0 mt-3 text-sm font-semibold text-danger-soft-foreground">
          {costCopy.short(money(estimate.shortfall, estimate.currency))}
        </p>
      ) : null}
      {estimate?.can_send && estimate.needs_approval ? (
        <p className="m-0 mt-3 rounded-xl bg-gold-bg px-3 py-2 text-sm font-semibold text-gold-ink">
          {costCopy.needsApproval}
        </p>
      ) : null}
      {estimate?.over_daily_limit ? (
        <p className="m-0 mt-3 text-sm text-muted-foreground">
          {costCopy.dailyLimit(count.format(estimate.daily_limit ?? 0), estimate.days_needed)}
        </p>
      ) : null}
    </section>
  );
}
