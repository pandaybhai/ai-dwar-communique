import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { nextBarState, stickyBarVisible } from "@/lib/start-page";

/**
 * Batch 72: the conversion bar. On a phone it sits at the bottom (above the
 * home indicator); on a desktop it is a
 * slim bar at the top. It appears once the hero form has scrolled out of
 * view and hides whenever the hero form or the final form is on screen. The
 * cookie banner sits above it (--aidwar-bottom-bar). Batch 73: the button
 * shimmers every few seconds until the first interaction, and the desktop bar
 * says who already uses AiDwar. Batch 78: no field any more — one
 * "Start free trial →" button that scrolls to the hero card and puts the
 * visitor where they left off (step 1, or wherever they were). Nothing is
 * saved from the bar, so it can't make a number-only lead.
 */
export function StartStickyBar({
  heroForm,
  finalForm,
  onStart,
}: {
  heroForm: RefObject<HTMLElement | null>;
  finalForm: RefObject<HTMLElement | null>;
  /** Scrolls to the hero card and focuses it. */
  onStart: () => void;
}) {
  const [state, setState] = useState({
    heroFormVisible: true,
    heroFormAbove: false,
    finalFormVisible: false,
  });
  const barRef = useRef<HTMLDivElement | null>(null);
  // Batch 73: the button's shimmer runs until the visitor first interacts with the page.
  const [shimmer, setShimmer] = useState(true);
  const visible = stickyBarVisible(state);

  useEffect(() => {
    const stop = () => setShimmer(false);
    const opts = { once: true, passive: true } as const;
    window.addEventListener("pointerdown", stop, opts);
    window.addEventListener("keydown", stop, opts);
    return () => {
      window.removeEventListener("pointerdown", stop);
      window.removeEventListener("keydown", stop);
    };
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) =>
      setState((prev) => nextBarState(prev, entries, heroForm.current, finalForm.current)),
    );
    if (heroForm.current) io.observe(heroForm.current);
    if (finalForm.current) io.observe(finalForm.current);
    return () => io.disconnect();
  }, [heroForm, finalForm]);

  // The cookie banner sits above the bar while the bar is on a phone screen.
  useEffect(() => {
    const root = document.documentElement;
    const phone = window.matchMedia?.("(max-width: 767px)").matches ?? false;
    const h = visible && phone ? (barRef.current?.offsetHeight ?? 0) : 0;
    root.style.setProperty("--aidwar-bottom-bar", `${h}px`);
    return () => {
      root.style.removeProperty("--aidwar-bottom-bar");
    };
  }, [visible]);

  return (
    <>
      {/* Phone: the bottom bar. */}
      <div
        ref={barRef}
        data-testid="start-sticky-bar"
        data-visible={visible ? "true" : "false"}
        aria-hidden={!visible}
        inert={!visible}
        style={{
          transform: visible ? "translateY(0)" : "translateY(110%)",
          paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
        }}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-3 pt-3 shadow-[0_-12px_30px_-18px_rgba(6,40,28,0.35)] backdrop-blur transition-transform duration-300 ease-out motion-reduce:transition-none md:hidden",
        )}
      >
        <StartButton shimmer={shimmer} onStart={onStart} className="w-full" />
      </div>
      {/* Desktop: a slim bar at the top. */}
      <div
        data-testid="start-top-bar"
        aria-hidden={!visible}
        inert={!visible}
        style={{ transform: visible ? "translateY(0)" : "translateY(-110%)" }}
        className="fixed inset-x-0 top-0 z-40 hidden border-b border-border bg-background/90 backdrop-blur transition-transform duration-300 ease-out motion-reduce:transition-none md:block"
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-2.5">
          <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="relative flex h-2 w-2" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 motion-safe:animate-ping" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
            </span>
            Join ZOORI Jewels, Meezoy and more
          </span>
          <StartButton shimmer={shimmer} onStart={onStart} />
        </div>
      </div>
    </>
  );
}

function StartButton({
  shimmer,
  onStart,
  className,
}: {
  shimmer: boolean;
  onStart: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onStart}
      data-testid="start-bar-button"
      data-shimmer={shimmer ? "on" : "off"}
      className={cn(
        "s73-shimmer inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-success px-6 text-base font-bold text-success-foreground shadow-[0_10px_28px_-12px_var(--success)] transition hover:bg-success/90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-success/30",
        className,
      )}
    >
      Start free trial
      <ArrowRight className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
