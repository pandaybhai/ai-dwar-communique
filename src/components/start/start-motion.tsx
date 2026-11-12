import { useEffect, useState, type ReactNode } from "react";
import { useReveal } from "@/hooks/use-reveal";
import { cn } from "@/lib/utils";

/** Batch 72: fades in and rises 12px, once, when scrolled into view (opacity/transform only). */
export function Rise({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <div
      ref={ref}
      style={{ transitionDelay: `${delay}ms` }}
      className={cn(
        "transition-[opacity,transform] duration-700 ease-out motion-reduce:transition-none",
        shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Counts up to `to` once visible (about a second). Reduced motion, or before
 * it is seen, shows the real number — the width is reserved with tabular
 * figures so nothing moves.
 */
export function CountUp({ to, suffix = "" }: { to: number; suffix?: string }) {
  const { ref, shown } = useReveal<HTMLSpanElement>(0.4);
  const [value, setValue] = useState(to);
  useEffect(() => {
    if (!shown) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / 1100);
      setValue(Math.round(to * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    setValue(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [shown, to]);
  const text = value.toLocaleString("en-IN");
  const final = to.toLocaleString("en-IN");
  return (
    <span ref={ref} className="relative inline-block tabular-nums">
      <span className="sr-only">
        {final}
        {suffix}
      </span>
      <span className="invisible" aria-hidden="true">
        {final}
        {suffix}
      </span>
      <span className="absolute inset-0" aria-hidden="true">
        {text}
        {suffix}
      </span>
    </span>
  );
}
