import { forwardRef, useEffect, useRef, useState } from "react";
import { PhoneChat, useChatStep } from "@/components/start/phone-chat";
import { StartLeadForm } from "@/components/start/start-lead-form";
import { usePlay, useReducedMotion } from "@/components/start/start-motion";
import { BUILT_FOR, HERO_CHIPS, ROTATE_MS, heroChipsShown } from "@/lib/start-story";
import { cn } from "@/lib/utils";

/**
 * Batch 73: the /start hero. The H1 and the form are plain server-rendered
 * content — nothing animates them; the motion is around them: a drifting
 * aurora, the rotating "Built for" word, the chat playing in a tilted phone
 * and four glass chips popping in as the chat reaches them. Loops stop when
 * the hero is off screen; reduced motion shows the finished chat, still.
 */

const CHIP_PLACE: Record<(typeof HERO_CHIPS)[number]["key"], { className: string; depth: number }> =
  {
    reach: {
      className:
        "left-0 top-[30%] sm:left-auto sm:right-[calc(100%-44px)] lg:top-[80%] lg:right-[calc(100%+12px)]",
      depth: 1.4,
    },
    read: {
      className: "hidden sm:block top-[13%] sm:left-[calc(100%-52px)]",
      depth: 0.8,
    },
    replied: {
      className: "hidden sm:block top-[56%] sm:right-[calc(100%-36px)]",
      depth: 1.1,
    },
    late: { className: "right-0 bottom-[9%] sm:right-auto sm:left-[calc(100%-60px)]", depth: 1.6 },
  };

function BuiltFor({ play }: { play: boolean }) {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!play || reduce) return;
    const t = setInterval(() => setI((n) => (n + 1) % BUILT_FOR.length), ROTATE_MS);
    return () => clearInterval(t);
  }, [play, reduce]);
  return (
    <p className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3.5 py-1.5 text-xs font-semibold text-white/85 sm:text-[13px]">
      <span className="h-1.5 w-1.5 rounded-full bg-[var(--mint)]" aria-hidden="true" />
      <span className="sr-only">
        Built for jewellers, boutiques, cafés, D2C brands, clinics and coaching institutes
      </span>
      <span aria-hidden="true">
        Built for{" "}
        <span className="s73-words text-[var(--mint)]">
          {BUILT_FOR.map((w, n) => (
            <span key={w} data-on={n === i ? "true" : "false"}>
              {w}
            </span>
          ))}
        </span>
      </span>
    </p>
  );
}

function HeroPhone({ play }: { play: boolean }) {
  const step = useChatStep(play);
  const chips = heroChipsShown(step.show);
  return (
    <div className="s73-stage relative mx-auto w-full max-w-[300px] lg:max-w-[340px]">
      <div className="s73-tilt" data-tilt>
        <PhoneChat step={step} />
      </div>
      {HERO_CHIPS.map((c) => (
        <div
          key={c.key}
          aria-hidden="true"
          className={cn("s73-par absolute z-10", CHIP_PLACE[c.key].className)}
          style={{ ["--d" as string]: CHIP_PLACE[c.key].depth }}
        >
          <div className="s73-float" style={{ animationDelay: `${CHIP_PLACE[c.key].depth}s` }}>
            <span className="s73-chip" data-on={chips[c.key] ? "true" : "false"}>
              {c.key === "reach" ? (
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--mint)]" />
              ) : null}
              {c.text}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Desktop pointer only: the phone leans up to 6° toward the pointer and the chips drift with it. */
function usePointerTilt(root: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    if (!window.matchMedia?.("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const tilt = el.querySelector<HTMLElement>("[data-tilt]");
    let raf = 0;
    let x = 0;
    let y = 0;
    const apply = () => {
      raf = 0;
      tilt?.style.setProperty("--ry", `${(x * 6).toFixed(2)}deg`);
      tilt?.style.setProperty("--rx", `${(-y * 6).toFixed(2)}deg`);
      el.style.setProperty("--px", (x * 10).toFixed(1));
      el.style.setProperty("--py", (y * 10).toFixed(1));
    };
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const onLeave = () => {
      x = 0;
      y = 0;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerleave", onLeave);
    return () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [root]);
}

export const StartHero = forwardRef<HTMLFormElement>(function StartHero(_props, formRef) {
  const { ref, play } = usePlay<HTMLElement>();
  usePointerTilt(ref);
  const on = play === "on";
  return (
    <header ref={ref} data-play={play} className="s73-dark relative overflow-hidden">
      <div aria-hidden="true" className="s73-aurora">
        <i />
        <i />
        <i />
      </div>
      <div aria-hidden="true" className="s73-grid" />
      <div className="relative mx-auto max-w-6xl px-4 pb-14 pt-4 sm:px-6 sm:pt-5 lg:pb-28">
        <span className="text-xl font-extrabold tracking-tight text-white" aria-label="AiDwar">
          Ai<span className="text-[var(--mint)]">Dwar</span>
        </span>

        <div className="mt-5 grid items-center gap-6 sm:mt-7 lg:mt-14 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14">
          <div>
            <BuiltFor play={on} />
            <h1 className="mt-4 text-[2.45rem] font-extrabold leading-[1.02] tracking-[-0.04em] text-white sm:text-[3.5rem] lg:text-[4.25rem]">
              Your next 100 sales are{" "}
              <span className="text-[var(--mint)]">already in WhatsApp.</span>
            </h1>
            <p className="mt-3 max-w-xl text-base leading-relaxed text-white/75 sm:mt-5 sm:text-lg">
              AiDwar sends your offers, replies to every customer in seconds, and brings buyers back
              — automatically, from your own WhatsApp number.
            </p>
            <div className="mt-5 max-w-md rounded-2xl bg-background p-4 text-foreground shadow-[0_30px_80px_-30px_rgba(16,185,129,0.45)] ring-1 ring-white/10 sm:p-5">
              <StartLeadForm ref={formRef} variant="hero" />
            </div>
          </div>
          <div className="pt-1 lg:pl-6 lg:pt-0">
            <HeroPhone play={on} />
          </div>
        </div>
      </div>
    </header>
  );
});
