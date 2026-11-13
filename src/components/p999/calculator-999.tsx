import { useId, useState } from "react";
import { CALC, calc, calcRate, ratePaise, rupees, type CalcKind } from "@/lib/page-999";
import { useCountUp } from "@/components/p999/p999-motion";
import { cn } from "@/lib/utils";

/**
 * Batch 80: the zero-markup calculator. Meta's own base rates for India
 * (message_rates — never our rate card) × the visitor's messages; "typical
 * tools add 20–40%"; we promise only the low end ("You save at least"). No
 * competitor is named. Figures ease to their new value as the slider moves.
 */

function Amount({ value, className }: { value: number; className?: string }) {
  const v = useCountUp(value);
  return <span className={cn("tabular-nums", className)}>{rupees(v)}</span>;
}

export function Calculator999({
  rates,
}: {
  rates: { marketing: number; utility: number; effective_from: string | null };
}) {
  const [messages, setMessages] = useState<number>(CALC.start);
  const [kind, setKind] = useState<CalcKind>("offers");
  const sliderId = useId();
  const r = calc(messages, kind, rates);
  const maxBar = Math.max(1, r.meta + r.markupHigh);
  const pct = ((messages - CALC.min) / (CALC.max - CALC.min)) * 100;
  const shownMessages = useCountUp(messages, 300);
  const asOf = rates.effective_from
    ? new Date(`${rates.effective_from}T00:00:00Z`).toLocaleDateString("en-IN", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : null;

  return (
    <div className="rounded-[1.75rem] border border-[var(--line)] bg-white p-5 shadow-[0_30px_80px_-40px_rgba(4,16,11,0.35)] sm:p-8">
      <div
        role="radiogroup"
        aria-label="Kind of message"
        className="grid grid-cols-2 gap-1 rounded-full bg-[var(--paper)] p-1"
      >
        {(
          [
            ["offers", "Offers"],
            ["updates", "Updates"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={kind === value}
            onClick={() => setKind(value)}
            className="p9-seg min-h-11 rounded-full text-[15px] font-bold text-[var(--ink)] transition-all"
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-6 flex items-baseline justify-between gap-3">
        <label htmlFor={sliderId} className="text-[15px] font-semibold text-[var(--ink)]/70">
          Messages per month
        </label>
        <p className="text-[1.65rem] font-extrabold tracking-tight text-[var(--ink)] tabular-nums">
          {Math.round(shownMessages).toLocaleString("en-IN")}
        </p>
      </div>
      <input
        id={sliderId}
        type="range"
        className="p9-range mt-1"
        min={CALC.min}
        max={CALC.max}
        step={CALC.step}
        value={messages}
        onChange={(e) => setMessages(Number(e.target.value))}
        aria-valuetext={`${messages.toLocaleString("en-IN")} messages a month`}
        style={{ ["--p" as string]: `${pct}%` }}
      />
      <div className="flex justify-between text-xs font-medium text-[var(--ink)]/45">
        <span>500</span>
        <span>20,000</span>
      </div>

      <div className="mt-6 space-y-4">
        <div>
          <div className="flex items-baseline justify-between gap-3 text-[14px]">
            <span className="font-semibold text-[var(--ink)]">
              With AiDwar{" "}
              <span className="font-normal text-[var(--ink)]/60">— Meta's own rate</span>
            </span>
            <Amount value={r.meta} className="font-extrabold text-[var(--ink)]" />
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-[var(--paper)]">
            <div
              className="p9-bar h-3 bg-[var(--mint-2)]"
              style={{ transform: `scaleX(${r.meta / maxBar})` }}
            />
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between gap-3 text-[14px]">
            <span className="font-semibold text-[var(--ink)]">
              Typical tools <span className="font-normal text-[var(--ink)]/60">— add 20–40%</span>
            </span>
            <span className="font-extrabold text-[var(--ink)]/70 tabular-nums">
              <Amount value={r.meta + r.markupLow} />–<Amount value={r.meta + r.markupHigh} />
            </span>
          </div>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-[var(--paper)]">
            <div
              className="p9-bar h-3 bg-[repeating-linear-gradient(135deg,#f59e0b_0_6px,#fbbf24_6px_12px)]"
              style={{ transform: `scaleX(${(r.meta + r.markupHigh) / maxBar})` }}
            />
          </div>
        </div>
      </div>

      <div className="relative mt-6 overflow-hidden rounded-2xl bg-[var(--ink)] p-5 text-white">
        <div
          aria-hidden="true"
          className="absolute -right-10 -top-12 h-40 w-40 rounded-full bg-[radial-gradient(closest-side,rgba(62,230,160,0.45),transparent)]"
        />
        <p className="relative text-[14px] font-semibold text-white/70">You save at least</p>
        <p
          className="relative mt-1 text-[2.6rem] font-extrabold leading-none tracking-[-0.04em] text-[var(--mint)]"
          aria-live="polite"
        >
          <Amount value={r.saveAtLeast} />
          <span className="text-[1rem] font-bold tracking-normal text-white/70"> /month</span>
        </p>
        <p className="relative mt-2 text-[13.5px] text-white/65">
          That's {rupees(r.saveAtLeast * 12)} or more a year — straight back in your pocket.
        </p>
      </div>

      <p className="mt-4 text-[12.5px] leading-relaxed text-[var(--ink)]/55">
        Approximate. Meta's rate in India
        {asOf ? ` (${asOf})` : ""}: {ratePaise(calcRate(kind, rates))} per{" "}
        {kind === "offers" ? "offer (marketing)" : "update (utility)"} message. Replies inside 24
        hours are free.{" "}
        <a
          href={CALC.metaPricingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-semibold text-[var(--mint-2)] underline underline-offset-2"
        >
          Meta's official pricing
        </a>
      </p>
    </div>
  );
}

export default Calculator999;
