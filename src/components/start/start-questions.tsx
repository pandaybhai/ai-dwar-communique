import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { CUSTOMERS, SELLS, type Customers, type Sells } from "@/lib/start-qualify";
import { cn } from "@/lib/utils";

/**
 * Batch 75: the two taps after name + number on /start — what they sell and
 * how many customers they have. One tap each, no typing; "Continue to sign
 * up →" once both are picked, and "Skip" so nobody is ever blocked. The
 * parent saves the answers (bound to its own lead by a signed cookie) and
 * moves on to /signup either way.
 */
export function StartQuestions({
  onDone,
  busy = false,
  autoFocus = true,
  className,
}: {
  onDone: (answers: { sells: Sells; customers: Customers } | null) => void;
  busy?: boolean;
  autoFocus?: boolean;
  className?: string;
}) {
  const id = useId();
  const [sells, setSells] = useState<Sells | null>(null);
  const [customers, setCustomers] = useState<Customers | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (autoFocus) first.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  const ready = Boolean(sells && customers);

  return (
    <div
      data-testid="start-questions"
      className={cn(
        "space-y-5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300",
        className,
      )}
    >
      <p className="text-sm font-semibold text-success" role="status">
        ✓ Got it — two quick taps and you're in.
      </p>
      <Chips
        id={`${id}-sells`}
        label="What do you sell?"
        options={SELLS}
        value={sells}
        onPick={(v) => setSells(v as Sells)}
        firstRef={first}
      />
      <Chips
        id={`${id}-customers`}
        label="How many customers do you have?"
        options={CUSTOMERS}
        value={customers}
        onPick={(v) => setCustomers(v as Customers)}
      />
      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => sells && customers && onDone({ sells, customers })}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-success px-5 text-base font-bold text-success-foreground shadow-[0_10px_28px_-12px_var(--success)] transition hover:bg-success/90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-success/30 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        Continue to sign up
        {!busy ? <ArrowRight className="h-4 w-4" aria-hidden="true" /> : null}
      </button>
      <p className="text-center">
        <button
          type="button"
          disabled={busy}
          onClick={() => onDone(null)}
          className="min-h-11 px-3 text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success"
        >
          Skip
        </button>
      </p>
    </div>
  );
}

function Chips({
  id,
  label,
  options,
  value,
  onPick,
  firstRef,
}: {
  id: string;
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  value: string | null;
  onPick: (value: string) => void;
  firstRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((o) => o.value === value);
  const focusable = selected >= 0 ? selected : 0;
  const move = (from: number, step: number) => {
    const next = (from + step + options.length) % options.length;
    refs.current[next]?.focus();
    onPick(options[next]!.value);
  };
  return (
    <div>
      <p id={id} className="mb-2 text-sm font-semibold text-foreground">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={id} className="flex flex-wrap gap-2">
        {options.map((o, i) => {
          const on = o.value === value;
          return (
            <button
              key={o.value}
              ref={(el) => {
                refs.current[i] = el;
                if (i === 0 && firstRef) firstRef.current = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={i === focusable ? 0 : -1}
              onClick={() => onPick(o.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  move(i, 1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(i, -1);
                }
              }}
              className={cn(
                "min-h-11 rounded-full border px-4 text-sm font-semibold transition focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-success/25",
                on
                  ? "border-success bg-success text-success-foreground"
                  : "border-border-strong bg-background text-foreground hover:border-success/60",
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
