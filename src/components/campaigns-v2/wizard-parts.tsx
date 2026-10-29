import { Check } from "lucide-react";
import { money, type CampaignCostEstimate } from "@/lib/billing";
import { cn } from "@/lib/utils";
import { count } from "./data";

/**
 * Batch 47: the campaign wizard's chrome in the new design. The wizard's
 * steps, checks and requests are Batch 41's own (campaign-wizard.tsx); with
 * new_design on it draws these instead of its step bar and cost card.
 */

/** Audience, message, personalise, test send, review and cost; Launch is the last button. */
export const ND_STEP_LABELS = [
  "Audience",
  "Message",
  "Personalise",
  "Test send",
  "Review and cost",
] as const;

/** A calm numbered stepper: done steps can be revisited, the current one is the soft pill. */
export function NdSteps({ step, onBack }: { step: number; onBack: (to: number) => void }) {
  return (
    <div>
      <ol
        className="m-0 hidden list-none flex-wrap items-center gap-1 p-0 wide:flex"
        aria-label="Steps"
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
                  aria-label={`Back to ${label}`}
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
        Step {step + 1} of {ND_STEP_LABELS.length}:{" "}
        <span className="font-semibold text-foreground">{ND_STEP_LABELS[step]}</span>
      </p>
    </div>
  );
}

type Audience = { eligible: number } | null;

/** The cost beside the phone: the wizard's own estimate (/api/campaigns/estimate), nothing worked out here. */
export function NdCostPanel({
  audience,
  audienceLoading,
  estimate,
}: {
  audience: Audience;
  audienceLoading: boolean;
  estimate: CampaignCostEstimate | null;
}) {
  return (
    <section
      aria-label="Cost"
      aria-live="polite"
      className={cn(
        "w-full rounded-[18px] border bg-surface p-4 shadow-md",
        estimate && !estimate.can_send ? "border-danger-border" : "border-line",
      )}
    >
      <p className="m-0 flex items-baseline justify-between gap-3">
        <span className="text-muted-foreground">This send costs about</span>
        <b className="font-display text-2xl font-semibold tabular-nums text-foreground">
          {estimate ? money(estimate.estimate, estimate.currency) : "–"}
        </b>
      </p>
      <p className="m-0 mt-1 text-sm text-muted-foreground">
        {estimate
          ? `${money(estimate.rate, estimate.currency)} a message, and you have ${money(estimate.available, estimate.currency)} in credits.`
          : audienceLoading
            ? "Counting who gets it."
            : audience
              ? "Pick a template to see the cost."
              : "Pick who gets it to see the cost."}
      </p>
      {audience ? (
        <p className="m-0 mt-3 border-t border-line pt-3 text-sm text-muted-foreground">
          <b className="tabular-nums text-foreground">{count.format(audience.eligible)}</b> will
          receive it
        </p>
      ) : null}
      {estimate && !estimate.can_send ? (
        <p className="m-0 mt-3 text-sm font-semibold text-danger-soft-foreground">
          You’re short {money(estimate.shortfall, estimate.currency)}. Add credits to send this
          campaign.
        </p>
      ) : null}
      {estimate?.can_send && estimate.needs_approval ? (
        <p className="m-0 mt-3 rounded-xl bg-gold-bg px-3 py-2 text-sm font-semibold text-gold-ink">
          Above your approval limit: it waits for an owner to approve it before anything sends.
        </p>
      ) : null}
      {estimate?.over_daily_limit ? (
        <p className="m-0 mt-3 text-sm text-muted-foreground">
          Your number can message {count.format(estimate.daily_limit ?? 0)} people a day right now,
          so this spreads over about {estimate.days_needed} days.
        </p>
      ) : null}
    </section>
  );
}
