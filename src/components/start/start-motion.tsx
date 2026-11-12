import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useReveal } from "@/hooks/use-reveal";
import { cn } from "@/lib/utils";

/**
 * Batch 72/73: the /start page's small motion helpers. No animation library:
 * IntersectionObserver, requestAnimationFrame and the page's own stylesheet
 * (start.css), where every hidden-before-it-plays state sits inside
 * prefers-reduced-motion: no-preference — reduced motion sees final states.
 */

/** True when the visitor asked for less motion (false on the server). */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!mq) return;
    setReduce(mq.matches);
    const on = () => setReduce(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return reduce;
}

/**
 * "on" while the element is on (or near) the screen, else "off": loops pause
 * off-screen. Starts "off" until the browser says otherwise.
 */
export function usePlay<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  play: "on" | "off";
} {
  const ref = useRef<T | null>(null);
  const [play, setPlay] = useState<"on" | "off">("off");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setPlay("on");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setPlay(e.isIntersecting ? "on" : "off");
      },
      { rootMargin: "80px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, play };
}

/** Fades in and rises 12px, once, when scrolled into view (opacity/transform only). */
export function Rise({
  children,
  delay = 0,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: "div" | "article" | "li";
}) {
  const { ref, shown } = useReveal<HTMLDivElement>();
  return (
    <Tag
      ref={ref as never}
      data-shown={shown ? "true" : "false"}
      style={delay ? { transitionDelay: `${delay}ms` } : undefined}
      className={cn("s73-reveal", className)}
    >
      {children}
    </Tag>
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

/**
 * Writes how far the element has scrolled through the middle of the screen
 * (0–1) into its --p custom property, once per frame at most. Reduced motion
 * (and the server) leave --p unset, which the stylesheet reads as 1 (full).
 */
export function useScrollProgress<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || 1;
      const p = Math.min(1, Math.max(0, (vh * 0.75 - r.top) / (r.height || 1)));
      el.style.setProperty("--p", p.toFixed(3));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  return ref;
}
