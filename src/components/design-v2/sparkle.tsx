import { useEffect, useRef, useState, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

const SPARKS = Array.from({ length: 10 }, (_, i) => {
  const a = (Math.PI * 2 * i) / 10;
  return { dx: `${Math.round(Math.cos(a) * 44)}px`, dy: `${Math.round(Math.sin(a) * 24)}px` };
});

/**
 * Batch 57 (approved preview): a chip that pops in with a gold sparkle, once,
 * when it first appears (a sale from a chat). It never loops; reduced motion
 * shows the chip still.
 */
export function SparkleChip({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useReducedMotion();
  const [burst, setBurst] = useState(!reduce);
  const fired = useRef(false);
  useEffect(() => {
    if (reduce || fired.current) return;
    fired.current = true;
    const t = setTimeout(() => setBurst(false), 800);
    return () => clearTimeout(t);
  }, [reduce]);
  return (
    <span
      className={cn(
        "relative inline-flex items-center gap-2 rounded-full bg-aiden-soft px-3.5 py-1.5 text-sm font-bold text-aiden-deep",
        !reduce && "nd-pop",
        className,
      )}
    >
      {children}
      {burst
        ? SPARKS.map((s, i) => (
            <i
              key={i}
              aria-hidden="true"
              className="nd-spark"
              style={{ "--dx": s.dx, "--dy": s.dy } as React.CSSProperties}
            />
          ))
        : null}
    </span>
  );
}
