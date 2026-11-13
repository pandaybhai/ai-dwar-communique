import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { useReducedMotion } from "@/components/start/start-motion";
import { cn } from "@/lib/utils";

export { useReducedMotion };

/**
 * Batch 80: /999's motion helpers. No animation library on the page itself:
 * IntersectionObserver, requestAnimationFrame and p999-css.ts. The server's
 * HTML (and a browser without the script) always shows the finished state —
 * only the script hides something before it plays.
 */

/**
 * null on the server and before the first effect (nothing hidden); then
 * false until the element is near the screen, true after (once by default).
 */
export function useInView<T extends HTMLElement>(
  opts: { once?: boolean; margin?: string } = {},
): { ref: RefObject<T | null>; inView: boolean | null } {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState<boolean | null>(null);
  const once = opts.once !== false;
  const margin = opts.margin ?? "0px 0px -12% 0px";
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setInView(true);
            if (once) io.disconnect();
          } else if (!once) setInView(false);
        }
      },
      { rootMargin: margin },
    );
    // Already on screen at mount: shown as is (no flash).
    const r = el.getBoundingClientRect();
    setInView(r.top < window.innerHeight && r.bottom > 0 ? true : false);
    io.observe(el);
    return () => io.disconnect();
  }, [once, margin]);
  return { ref, inView };
}

/** "on" while near the screen: loops pause off-screen. */
export function usePlaying<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  play: "on" | "off";
} {
  const { ref, inView } = useInView<T>({ once: false, margin: "120px 0px" });
  return { ref, play: inView === false ? "off" : "on" };
}

/** Rises in when scrolled to (opacity + transform only). */
export function Reveal({
  children,
  delay = 0,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: "div" | "section" | "article" | "li";
}) {
  const { ref, inView } = useInView<HTMLDivElement>();
  return (
    <Tag
      ref={ref as never}
      className={cn("p9-rise", className)}
      data-in={inView === null ? undefined : inView ? "true" : "false"}
      style={{ ["--d" as string]: `${delay}ms` }}
    >
      {children}
    </Tag>
  );
}

/** A number that eases to its new value (reduced motion: jumps). */
export function useCountUp(target: number, ms = 650): number {
  const reduce = useReducedMotion();
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (reduce || typeof requestAnimationFrame === "undefined") {
      from.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = a + (target - a) * eased;
      from.current = v;
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, reduce]);
  return value;
}

/**
 * The main button: a glow follows the pointer and the button leans up to
 * 6px toward it (desktop pointer only; never with reduced motion).
 */
export const MagneticCta = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }
>(function MagneticCta({ children, className, ...rest }, outer) {
  const inner = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = inner.current;
    if (!el) return;
    if (!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty("--mx", `${x}px`);
        el.style.setProperty("--my", `${y}px`);
        const dx = ((x / r.width) * 2 - 1) * 6;
        const dy = ((y / r.height) * 2 - 1) * 4;
        el.style.transform = `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0)`;
      });
    };
    const onLeave = () => {
      if (raf) cancelAnimationFrame(raf);
      el.style.transform = "";
    };
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
    };
  }, []);
  return (
    <button
      type="button"
      {...rest}
      ref={(node) => {
        inner.current = node;
        if (typeof outer === "function") outer(node);
        else if (outer) outer.current = node;
      }}
      className={cn("p9-cta", className)}
    >
      <span aria-hidden="true" className="p9-cta-glow" />
      {children}
    </button>
  );
});

/**
 * Light scroll parallax: sets --sy (px) on the element from its distance to
 * the middle of the screen × factor. rAF-throttled; off for reduced motion.
 */
export function useParallax<T extends HTMLElement>(factor = 0.08): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const r = el.getBoundingClientRect();
      const mid = r.top + r.height / 2 - window.innerHeight / 2;
      el.style.setProperty("--sy", (-mid * factor).toFixed(1));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [factor]);
  return ref;
}
