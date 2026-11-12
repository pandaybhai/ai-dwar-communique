import { useEffect, useRef, useState, type RefObject } from "react";
import { cn } from "@/lib/utils";
import { nextBarState, stickyBarVisible } from "@/lib/start-page";
import { StartLeadForm } from "@/components/start/start-lead-form";

/**
 * Batch 72: the conversion bar. On a phone it sits at the bottom (above the
 * home indicator, and above the keyboard while typing); on a desktop it is a
 * slim bar at the top. It appears once the hero form has scrolled out of
 * view and hides whenever the hero form or the final form is on screen. The
 * cookie banner sits above it (--aidwar-bottom-bar).
 */
export function StartStickyBar({
  heroForm,
  finalForm,
}: {
  heroForm: RefObject<HTMLElement | null>;
  finalForm: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState({
    heroFormVisible: true,
    heroFormAbove: false,
    finalFormVisible: false,
  });
  const barRef = useRef<HTMLDivElement | null>(null);
  const [keyboardLift, setKeyboardLift] = useState(0);
  const visible = stickyBarVisible(state);

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

  // iOS: keep the bar above the on-screen keyboard while its field is in use.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () =>
      setKeyboardLift(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
    };
  }, []);

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
          transform: visible ? `translateY(-${keyboardLift}px)` : "translateY(110%)",
          paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))",
        }}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-3 pt-3 shadow-[0_-12px_30px_-18px_rgba(6,40,28,0.35)] backdrop-blur transition-transform duration-300 ease-out motion-reduce:transition-none md:hidden",
        )}
      >
        <StartLeadForm variant="bar" />
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
          <span className="text-sm font-semibold text-foreground">
            Your customers read WhatsApp. Start free today.
          </span>
          <StartLeadForm variant="bar" className="w-[460px]" />
        </div>
      </div>
    </>
  );
}
