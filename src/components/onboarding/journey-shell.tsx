import type { CSSProperties, ReactNode } from "react";
import { Check } from "lucide-react";
import { JOURNEY_STEPS, STEP_LABELS, stepIndex, type JourneyPosition, type JourneyStep } from "@/lib/onboarding-journey";
import { cn } from "@/lib/utils";

/**
 * Batch 40: the full-screen frame every first-run step sits in — the
 * wordmark, a slim four-step rail and one calm column. The business's own
 * colour (from its website) tints the light behind it via --brand.
 */
export function JourneyShell({
  step,
  reached,
  brandColor,
  onStep,
  exit,
  children,
}: {
  step: JourneyStep;
  /** The furthest step that's open (done steps can be revisited). */
  reached: JourneyPosition;
  brandColor?: string | null;
  onStep?: (step: JourneyStep) => void;
  exit?: ReactNode;
  children: ReactNode;
}) {
  const style = brandColor ? ({ "--brand": brandColor } as CSSProperties) : undefined;
  return (
    <div className="ob-stage min-h-[100dvh] text-foreground" style={style}>
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-4 pt-5 sm:px-8 sm:pt-7">
        <span className="text-lg font-bold tracking-tight">
          Ai<span className="text-primary-strong">Dwar</span>
        </span>
        {exit}
      </header>
      <ProgressRail step={step} reached={reached} {...(onStep ? { onStep } : {})} />
      <main id="journey-main" className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 sm:px-8 sm:pt-10">
        {children}
      </main>
    </div>
  );
}

export function ProgressRail({
  step,
  reached,
  onStep,
}: {
  step: JourneyStep;
  reached: JourneyPosition;
  onStep?: (step: JourneyStep) => void;
}) {
  const current = stepIndex(step);
  const open = stepIndex(reached);
  return (
    <nav aria-label="Setup progress" className="mx-auto mt-5 w-full max-w-6xl px-4 sm:px-8">
      <p className="mb-2 text-xs font-medium text-muted-foreground sm:hidden">
        Step {current + 1} of {JOURNEY_STEPS.length} · {STEP_LABELS[step]}
      </p>
      <ol className="grid grid-cols-4 gap-2">
        {JOURNEY_STEPS.map((key, i) => {
          const done = i < open && i !== current;
          const isCurrent = i === current;
          const canVisit = Boolean(onStep) && i <= open && !isCurrent;
          const label = (
            <>
              <span className="relative block h-1 overflow-hidden rounded-full bg-border">
                <span
                  className="ob-rail-fill absolute inset-0 rounded-full bg-primary-strong"
                  style={{ transform: `scaleX(${i < current || done ? 1 : isCurrent ? 0.5 : 0})` }}
                />
              </span>
              <span
                className={cn(
                  "mt-2 hidden items-center gap-1.5 text-xs font-medium sm:flex",
                  isCurrent ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {done ? <Check className="h-3.5 w-3.5 text-primary-strong" aria-hidden="true" /> : null}
                {STEP_LABELS[key]}
                {done ? <span className="sr-only"> (done)</span> : null}
              </span>
            </>
          );
          return (
            <li key={key} aria-current={isCurrent ? "step" : undefined}>
              {canVisit ? (
                <button
                  type="button"
                  onClick={() => onStep?.(key)}
                  className="block w-full rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Back to ${STEP_LABELS[key]}`}
                >
                  {label}
                </button>
              ) : (
                <div aria-label={isCurrent ? undefined : STEP_LABELS[key]}>{label}</div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** The step's big headline and its one line of context. */
export function StepHeading({
  eyebrow,
  title,
  lead,
  className,
}: {
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ob-rise max-w-2xl", className)}>
      {eyebrow ? <p className="text-sm font-semibold text-primary-strong">{eyebrow}</p> : null}
      <h1 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-5xl sm:leading-[1.08]">{title}</h1>
      {lead ? <p className="mt-4 text-pretty text-base text-muted-foreground sm:text-lg">{lead}</p> : null}
    </div>
  );
}

/** The one primary action of a step: big, round, full-width on a phone. */
export function PrimaryAction({
  children,
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex h-14 w-full items-center justify-center gap-2 rounded-full bg-primary-strong px-8 text-base font-semibold text-primary-strong-foreground shadow-lg shadow-primary/20 transition-[transform,box-shadow,opacity] duration-200 hover:shadow-xl hover:shadow-primary/25 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto [&_svg]:size-5",
        className,
      )}
    />
  );
}
