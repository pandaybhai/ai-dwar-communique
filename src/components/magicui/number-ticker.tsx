import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";
import { useInView, useMotionValue, useReducedMotion, useSpring } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * Magic UI's number-ticker (magicui.design), copied into the repo and restyled
 * for AiDwar (Batch 44): tokens only, Indian digit grouping by default, an
 * optional prefix (₹), and no animation at all under reduced motion.
 * Batch 57: it counts up once, the first time it is seen; a later change (a
 * live update) shows the new number at once instead of counting again.
 */
interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number;
  startValue?: number;
  direction?: "up" | "down";
  delay?: number;
  decimalPlaces?: number;
  /** Intl locale for grouping (en-IN: 1,84,000). */
  locale?: string;
  prefix?: string;
}

export function NumberTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  locale = "en-IN",
  prefix = "",
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();
  const motionValue = useMotionValue(direction === "down" ? value : startValue);
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 });
  const isInView = useInView(ref, { once: true, margin: "0px" });
  const counted = useRef(false);
  const format = (n: number) =>
    prefix +
    Intl.NumberFormat(locale, {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces,
    }).format(Number(n.toFixed(decimalPlaces)));

  useEffect(() => {
    if (reduce) {
      if (ref.current) ref.current.textContent = format(direction === "down" ? startValue : value);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const target = direction === "down" ? startValue : value;
    if (counted.current) {
      motionValue.jump(target);
      springValue.jump(target);
      return;
    }
    if (isInView) {
      timer = setTimeout(() => {
        counted.current = true;
        motionValue.set(target);
      }, delay * 1000);
    }
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
    // format is derived from the props listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motionValue, springValue, isInView, delay, value, direction, startValue, reduce]);

  useEffect(
    () =>
      springValue.on("change", (latest) => {
        if (ref.current) ref.current.textContent = format(latest);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [springValue, decimalPlaces, locale, prefix],
  );

  return (
    <span ref={ref} className={cn("inline-block tabular-nums", className)} {...props}>
      {format(
        reduce
          ? direction === "down"
            ? startValue
            : value
          : direction === "down"
            ? value
            : startValue,
      )}
    </span>
  );
}
