import { useEffect, useRef, useState } from "react";
import { useInView, useReducedMotion } from "motion/react";

import { cn } from "@/lib/utils";

/**
 * Magic UI's typing-animation (magicui.design), cut down and restyled for
 * AiDwar (Batch 44): types one text a couple of characters at a time with the
 * preview's emerald caret, then calls onDone. Reduced motion shows the whole
 * text at once. Screen readers get the full text, never the half-typed one.
 */
interface TypingAnimationProps {
  children: string;
  className?: string;
  /** Milliseconds per step. */
  duration?: number;
  /** Characters per step. */
  step?: number;
  delay?: number;
  startOnView?: boolean;
  onDone?: () => void;
}

export function TypingAnimation({
  children,
  className,
  duration = 35,
  step = 2,
  delay = 0,
  startOnView = true,
  onDone,
}: TypingAnimationProps) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const reduce = useReducedMotion();
  const inView = useInView(ref, { amount: 0.3, once: true });
  const graphemes = Array.from(children);
  const [shown, setShown] = useState(0);
  const done = reduce || shown >= graphemes.length;
  const start = !startOnView || inView;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => setShown(0), [children]);

  useEffect(() => {
    if (reduce || !start) return;
    if (shown >= graphemes.length) {
      doneRef.current?.();
      return;
    }
    const t = setTimeout(
      () => setShown((n) => n + step),
      shown === 0 ? delay + duration : duration,
    );
    return () => clearTimeout(t);
  }, [reduce, start, shown, graphemes.length, step, delay, duration]);

  useEffect(() => {
    if (reduce) doneRef.current?.();
  }, [reduce]);

  return (
    <span ref={ref} className={cn("relative", className)}>
      <span className="sr-only">{children}</span>
      <span aria-hidden="true">
        {done ? children : graphemes.slice(0, shown).join("")}
        {done ? null : <i className="nd-caret" />}
      </span>
    </span>
  );
}
