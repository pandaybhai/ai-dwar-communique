import { useEffect, useRef, useState } from "react";
import { BellRing, UserRound } from "lucide-react";
import { useReducedMotion } from "@/components/start/start-motion";
import { STORY_STEPS, activeStoryStep, storyPhone, type StoryPhone } from "@/lib/start-story";
import { cn } from "@/lib/utils";

/**
 * Batch 73: "While you sleep" — the signature scroll story. The phone stays
 * pinned (left on desktop, top half on a phone) while four steps scroll past;
 * the step crossing the middle of the screen drives the phone (storyPhone)
 * and its clock, and the last one sweeps the night into dawn. Illustrative,
 * and captioned so. Reduced motion: same states, no transitions.
 */

const CLOCKS = Array.from(new Set(STORY_STEPS.map((s) => s.clock)));

function Bubble({
  on,
  side,
  children,
}: {
  on: boolean;
  side: "in" | "out";
  children: React.ReactNode;
}) {
  return (
    <div
      data-on={on ? "true" : "false"}
      aria-hidden={!on}
      className={cn(
        "s73-pop max-w-[88%] rounded-2xl px-3 py-2 text-[12.5px] leading-snug shadow-sm sm:text-[13px]",
        side === "out"
          ? "ml-auto rounded-tr-md bg-[#d9fdd3] text-[#111b21]"
          : "mr-auto rounded-tl-md bg-white text-[#111b21]",
      )}
    >
      {children}
    </div>
  );
}

export function StoryPhoneView({ state }: { state: StoryPhone }) {
  return (
    <div
      className="relative mx-auto w-full max-w-[230px] sm:max-w-[290px]"
      role="img"
      aria-label={`Example phone at ${state.clock}: ${
        state.morning
          ? "three sales waiting from last night"
          : state.yes
            ? "the customer said yes and the chat is assigned to you"
            : state.answer
              ? "Aiden has answered with the price and stock"
              : "a customer asks about a 22k gold chain"
      }.`}
    >
      <div className="rounded-[2.2rem] bg-[#0b1f17] p-2 shadow-[0_40px_90px_-30px_rgba(0,0,0,0.8)] ring-1 ring-white/10">
        <div className="relative overflow-hidden rounded-[1.8rem] bg-[#efeae2]">
          {/* Status bar with the clock */}
          <div className="flex items-center justify-between bg-[#075e54] px-4 pt-2 text-[11px] font-semibold text-white">
            <span className="s73-clock inline-grid tabular-nums" aria-hidden="true">
              {CLOCKS.map((c) => (
                <span
                  key={c}
                  className="[grid-area:1/1]"
                  data-on={c === state.clock ? "true" : "false"}
                >
                  {c}
                </span>
              ))}
            </span>
            <span aria-hidden="true">● ● ●</span>
          </div>
          <div className="flex items-center gap-2 bg-[#075e54] px-4 pb-2.5 pt-1.5 text-white">
            <span className="grid h-7 w-7 place-items-center rounded-full bg-white/15 text-[10px] font-bold">
              YS
            </span>
            <span className="text-[13px] font-semibold">Your Jewellery Store</span>
          </div>
          <div className="relative flex h-[290px] flex-col gap-2 px-2.5 pb-3 pt-3 sm:h-[340px] sm:px-3">
            <Bubble on={state.question} side="in">
              Is the 22k chain from your Instagram post available?
            </Bubble>
            <div className="relative">
              <div
                aria-hidden="true"
                data-on={state.typing ? "true" : "false"}
                className="s73-pop absolute right-0 top-0 flex gap-1 rounded-2xl bg-[#d9fdd3] px-3 py-2.5"
              >
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full bg-[#667781] motion-safe:animate-bounce"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))}
              </div>
              <Bubble on={state.answer} side="out">
                Yes! 22k, 18g — ₹1,34,500, and it&apos;s in stock. Shall I keep it for you?
              </Bubble>
            </div>
            <Bubble on={state.yes} side="in">
              Yes please 🙏
            </Bubble>
            <div
              data-on={state.toast ? "true" : "false"}
              aria-hidden={!state.toast}
              className="s73-pop mt-auto flex flex-col gap-1.5"
            >
              <span className="inline-flex items-center gap-1.5 self-center rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-[#075e54] shadow-sm">
                <UserRound className="h-3 w-3" aria-hidden="true" /> Assigned to you
              </span>
              <span className="flex items-center justify-center gap-2 rounded-xl bg-[#0b1f17] px-3 py-2 text-xs font-semibold text-white">
                <span className="h-2 w-2 rounded-full bg-[#25d366]" />
                Order held · ₹1,34,500
              </span>
            </div>

            {/* Morning: a lock-screen of notifications over the dimmed chat */}
            <div
              data-on={state.morning ? "true" : "false"}
              aria-hidden={!state.morning}
              className="s73-pop absolute inset-0 flex flex-col gap-1.5 bg-[#0b1f17] px-2.5 pt-4"
            >
              {["Order held · ₹1,34,500", "New customer · Bridal set", "Order held · ₹48,200"].map(
                (t, i) => (
                  <span
                    key={t}
                    className="flex items-center gap-2 rounded-2xl bg-white/95 px-3 py-2 text-[11.5px] font-medium text-[#111b21] shadow-lg"
                    style={{ transform: `scale(${1 - i * 0.03})` }}
                  >
                    <BellRing className="h-3.5 w-3.5 shrink-0 text-[#075e54]" aria-hidden="true" />
                    {t}
                  </span>
                ),
              )}
              <span className="mt-1 self-center rounded-full bg-[var(--mint)] px-3 py-1 text-[11px] font-bold text-[#06120e]">
                {state.notifications} orders held overnight
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function NightStory() {
  const reduce = useReducedMotion();
  const stepRefs = useRef<(HTMLLIElement | null)[]>([]);
  const [step, setStep] = useState(0);
  const [settled, setSettled] = useState(true);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const phone = window.matchMedia?.("(max-width: 1023px)").matches ?? false;
    // A thin band across the screen: in the middle on desktop, lower down on a
    // phone (the pinned phone covers the top half there).
    const io = new IntersectionObserver(
      (entries) => setStep((prev) => activeStoryStep(prev, entries, stepRefs.current)),
      { rootMargin: phone ? "-68% 0px -28% 0px" : "-48% 0px -48% 0px" },
    );
    for (const el of stepRefs.current) if (el) io.observe(el);
    return () => io.disconnect();
  }, []);

  // Step 2: Aiden types for a moment, then the reply lands.
  useEffect(() => {
    if (reduce) {
      setSettled(true);
      return;
    }
    setSettled(false);
    const t = setTimeout(() => setSettled(true), 900);
    return () => clearTimeout(t);
  }, [step, reduce]);

  const state = storyPhone(step, settled);

  return (
    <section
      className="s73-night relative text-white"
      aria-labelledby="night"
      data-testid="night-story"
      data-step={step}
    >
      <div aria-hidden="true" className="s73-dawn" data-on={state.morning ? "true" : "false"} />
      <div className="relative mx-auto max-w-6xl px-4 pt-20 sm:px-6 sm:pt-28">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--mint)]">
          While you sleep
        </p>
        <h2
          id="night"
          className="mt-3 max-w-3xl text-[2.2rem] font-extrabold leading-[1.05] tracking-[-0.035em] sm:text-[3.4rem]"
        >
          Your shop closes at 9. Your WhatsApp doesn&apos;t.
        </h2>

        <div className="mt-10 grid gap-x-16 lg:mt-16 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="sticky top-3 z-10 self-start pb-4 lg:top-[12vh] lg:pb-0">
            <StoryPhoneView state={state} />
          </div>
          <ol className="relative">
            {STORY_STEPS.map((s, i) => (
              <li
                key={s.text}
                ref={(el) => {
                  stepRefs.current[i] = el;
                }}
                data-on={i === step ? "true" : "false"}
                className="s73-step flex min-h-[62vh] items-end pb-[18vh] lg:min-h-[78vh] lg:items-center lg:pb-0"
              >
                <div className="max-w-md rounded-2xl border border-white/10 bg-[#06120e]/70 p-5 lg:border-0 lg:bg-transparent lg:p-0">
                  <p className="font-mono text-sm font-semibold tracking-wide text-[var(--mint)]">
                    {s.clock}
                  </p>
                  <p className="mt-2 text-xl font-bold leading-snug sm:text-[1.7rem] sm:leading-tight">
                    {s.text}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <p className="pb-10 text-xs text-white/60">Illustrative example.</p>
      </div>
    </section>
  );
}
