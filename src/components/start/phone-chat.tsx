import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Batch 72: the /start hero's phone — an example WhatsApp chat that plays
 * itself. The store and the chat are illustrative, so the header is a generic
 * "Your Jewellery Store", never a real customer's name (ZOORI appears only in
 * the logo strip and the case study, which are true).
 * HTML/CSS only. Every bubble has its space from the start (it only fades and
 * rises 12px in), so nothing below it ever moves: no layout shift. Reduced
 * motion shows the finished chat, still.
 */

export type ChatStep = { at: number; show: number; typing: "customer" | "business" | null };

/** step index → bubbles shown (0..5: broadcast, q, answer, yes, toast) and who is typing. */
const SCRIPT: ChatStep[] = [
  { at: 0, show: 1, typing: null },
  { at: 900, show: 1, typing: "customer" },
  { at: 2300, show: 2, typing: null },
  { at: 2900, show: 2, typing: "business" },
  { at: 4500, show: 3, typing: null },
  { at: 5300, show: 3, typing: "customer" },
  { at: 6400, show: 4, typing: null },
  { at: 7000, show: 5, typing: null },
];
const LOOP_MS = 11_500;
export const FINAL_CHAT_STEP: ChatStep = SCRIPT[SCRIPT.length - 1]!;

/**
 * The chat's position in its loop. It plays only while `active` (on screen)
 * and never under reduced motion; the server and reduced motion show the
 * finished chat.
 */
export function useChatStep(active = true): ChatStep {
  const [step, setStep] = useState<ChatStep>(FINAL_CHAT_STEP);
  useEffect(() => {
    if (!active || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      timers = SCRIPT.map((s) => setTimeout(() => setStep(s), s.at));
      timers.push(setTimeout(run, LOOP_MS));
    };
    setStep(SCRIPT[0]!);
    run();
    return () => timers.forEach(clearTimeout);
  }, [active]);
  return step;
}

function Bubble({
  shown,
  side,
  children,
  time,
}: {
  shown: boolean;
  side: "in" | "out";
  children: React.ReactNode;
  time: string;
}) {
  return (
    <div
      className={cn(
        "max-w-[86%] rounded-2xl px-3 py-2 text-[13px] leading-snug shadow-sm transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none",
        side === "out"
          ? "ml-auto rounded-tr-md bg-[#d9fdd3] text-[#111b21]"
          : "mr-auto rounded-tl-md bg-white text-[#111b21]",
        shown ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
      )}
      aria-hidden={!shown}
    >
      {children}
      <span className="mt-0.5 block text-right text-[10px] text-[#3b4a54]">{time}</span>
    </div>
  );
}

function Typing({ side, on }: { side: "in" | "out"; on: boolean }) {
  return (
    <div
      className={cn(
        "absolute bottom-3 flex gap-1 rounded-2xl bg-white px-3 py-2.5 shadow-sm transition-opacity duration-300",
        side === "out" ? "right-3 bg-[#d9fdd3]" : "left-3",
        on ? "opacity-100" : "opacity-0",
      )}
      aria-hidden="true"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-[#667781] motion-safe:animate-bounce"
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </div>
  );
}

export function PhoneChat({
  step: given,
  className,
}: {
  /** The hero drives the chat (and its chips) from outside; alone it plays itself. */
  step?: ChatStep;
  className?: string;
} = {}) {
  const own = useChatStep(given === undefined);
  const step = given ?? own;
  return (
    <div
      className={cn("relative mx-auto w-full max-w-[300px] lg:max-w-[340px]", className)}
      role="img"
      aria-label="An example WhatsApp chat: a jewellery store sends a Diwali offer, a customer asks for a 22k gold chain, Aiden replies with the price and offers to hold it, the customer says yes, and the order is held."
    >
      <span
        aria-hidden="true"
        className="absolute -top-3 right-6 z-10 rounded-full border border-white/20 bg-[#0b1f17] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-white/85"
      >
        Example
      </span>
      <div className="rounded-[2.4rem] bg-[#0b1f17] p-2.5 shadow-[0_40px_80px_-30px_rgba(6,40,28,0.55)] ring-1 ring-black/5">
        <div className="overflow-hidden rounded-[1.9rem] bg-[#efeae2]">
          <div className="flex items-center gap-2.5 bg-[#075e54] px-4 pb-3 pt-4 text-white">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-white/15 text-xs font-bold">
              YS
            </span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold">Your Jewellery Store</span>
              <span className="block text-[11px] text-white/80">
                {step.typing === "business" ? "Aiden is typing…" : "Business account"}
              </span>
            </span>
          </div>
          <div className="relative flex h-[360px] flex-col gap-2 px-3 pb-14 pt-3">
            <Bubble shown={step.show >= 1} side="out" time="10:02">
              <span className="font-semibold">Diwali offer:</span> making charges waived till Sunday
              🪔
            </Bubble>
            <Bubble shown={step.show >= 2} side="in" time="10:05">
              Is the gold chain available in 22k?
            </Bubble>
            <Bubble shown={step.show >= 3} side="out" time="10:05">
              Yes! 22k, 18g, ₹1,34,500. Want me to hold it for you till 7pm?
            </Bubble>
            <Bubble shown={step.show >= 4} side="in" time="10:06">
              Yes please
            </Bubble>
            <Typing side="in" on={step.typing === "customer"} />
            <Typing side="out" on={step.typing === "business"} />
            <div
              className={cn(
                "absolute inset-x-3 bottom-3 flex items-center justify-center gap-2 rounded-xl bg-[#0b1f17] px-3 py-2 text-xs font-semibold text-white shadow-lg transition-[opacity,transform] duration-500",
                step.show >= 5 ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
              )}
              aria-hidden={step.show < 5}
            >
              <span className="h-2 w-2 rounded-full bg-[#25d366]" />
              Order held · ₹1,34,500
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
