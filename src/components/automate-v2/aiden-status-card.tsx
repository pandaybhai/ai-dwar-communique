import { AidenOrb, NumberTicker } from "@/components/design-v2";
import { Button } from "@/components/ui/button";
import { moneyText } from "@/lib/employee-client";
import { cn } from "@/lib/utils";
import { AIDEN_MODES, aidenStatus, type AidenMode } from "./aiden-v2";

/**
 * Batch 49: the top of Automate > Aiden. The orb and a sentence say what
 * Aiden is doing now; the switch is the Employee page's own mode control
 * (same three modes, same rule: switched off for the workspace, Drafts and
 * Replying wait until AI is turned on; only ai.configure may change it).
 */
export function AidenStatusCard({
  name,
  mode,
  aiEnabled,
  canConfigure,
  busy,
  onSetMode,
  onTurnOn,
  turningOn,
  week,
  spend,
  currency,
  testedRecently,
}: {
  name: string;
  mode: string | null | undefined;
  aiEnabled: boolean;
  canConfigure: boolean;
  busy: AidenMode | null;
  onSetMode: (mode: AidenMode) => void;
  onTurnOn: () => void;
  turningOn: boolean;
  week: { answered: number; passed: number };
  spend: number;
  currency: string;
  testedRecently: boolean;
}) {
  const status = aidenStatus(mode, aiEnabled, name);
  return (
    <section
      aria-labelledby="aiden-status-heading"
      className="flex flex-col gap-6 rounded-[20px] border border-line bg-surface p-6 shadow-md phone:p-5"
    >
      <div className="flex items-center gap-5 phone:gap-4">
        <AidenOrb state={status.orb} size={72} />
        <div className="min-w-0">
          <h2
            id="aiden-status-heading"
            className="font-display text-[clamp(1.6rem,2.8vw,2.25rem)] font-extrabold leading-[1.05] tracking-[-0.03em] text-foreground [overflow-wrap:break-word] [text-wrap:balance]"
          >
            {status.title}
          </h2>
          <p className="mt-1.5 max-w-[46ch] text-body text-muted-foreground">{status.meaning}</p>
        </div>
      </div>

      {!aiEnabled ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[18px] border border-gold-line bg-gold-bg p-4">
          <p className="m-0 min-w-0 text-sm text-gold-ink">
            <b className="block text-body">AI is switched off for this workspace</b>
            Turn it on to choose Drafts or Replying.
          </p>
          <Button variant="gold" disabled={!canConfigure || turningOn} onClick={onTurnOn}>
            {turningOn ? "Turning on…" : `Turn ${name} on`}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-2.5">
        <div
          role="group"
          aria-label={`What ${name} does`}
          className="inline-flex self-start rounded-[14px] border border-line bg-surface p-1 phone:grid phone:grid-cols-3 phone:self-stretch"
        >
          {AIDEN_MODES.map((o) => {
            const pressed = o.key === status.mode;
            // Batch 28's rule, as on the Employee page: switched off, only Off can be picked.
            const locked = !aiEnabled && o.key !== "off";
            return (
              <button
                key={o.key}
                type="button"
                aria-pressed={pressed}
                aria-busy={busy === o.key || undefined}
                disabled={!canConfigure || locked || busy !== null}
                title={locked ? "Turn AI on for this workspace first." : undefined}
                onClick={() => {
                  if (!pressed) onSetMode(o.key);
                }}
                className={cn(
                  "rounded-[10px] px-4 py-2 text-sm font-semibold transition-[background-color,color] duration-[250ms] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden active:scale-[0.98] disabled:cursor-not-allowed phone:px-1",
                  pressed
                    ? "bg-ink text-ink-foreground"
                    : "text-muted-foreground hover:text-foreground disabled:hover:text-muted-foreground",
                  !pressed && (locked || !canConfigure) && "opacity-60",
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <ul className="m-0 grid list-none gap-1 p-0 text-sm text-muted-foreground">
          {AIDEN_MODES.map((o) => (
            <li key={o.key}>
              <b className="font-semibold text-foreground">{o.label}:</b> {o.meaning}
            </li>
          ))}
        </ul>
      </div>

      <dl className="m-0 grid grid-cols-3 gap-4 border-t border-line pt-5 phone:grid-cols-1 phone:gap-0 phone:pt-2">
        <Stat label="Answered this week">
          <NumberTicker value={week.answered} />
        </Stat>
        <Stat label="Passed to you">
          <NumberTicker value={week.passed} />
        </Stat>
        <Stat label="Cost this month">{moneyText(spend, currency)}</Stat>
      </dl>

      {!testedRecently && canConfigure ? (
        <p className="m-0 rounded-[14px] bg-bubble-in px-4 py-3 text-sm text-foreground">
          You haven&rsquo;t tried {name} yet. Ask your last 20 real customer questions before
          letting {name} reply alone: Test {name} below, or Compare two setups under Try.
        </p>
      ) : null}
      {!canConfigure ? (
        <p className="m-0 text-sm text-muted-foreground">
          You can see everything {name} does. Changing how {name} works needs the &ldquo;Configure
          AI&rdquo; permission.
        </p>
      ) : null}
    </section>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 phone:flex-row phone:items-baseline phone:justify-between phone:border-b phone:border-line phone:py-2.5 phone:last:border-b-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="m-0 font-display text-[1.6rem] font-semibold tabular-nums text-foreground">
        {children}
      </dd>
    </div>
  );
}
