import { useEffect, useRef, useState } from "react";
import { Bot, CheckCheck, Check, IndianRupee, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";

type Turn = {
  from: "customer" | "agent";
  text: string;
  /** how long the typing indicator shows before the bubble lands */
  typing: number;
  /** pause after the bubble lands */
  pause: number;
  time: string;
};

const SCRIPT: Turn[] = [
  {
    from: "customer",
    text: "Do you have this saree in red?",
    typing: 900,
    pause: 700,
    time: "10:41",
  },
  {
    from: "agent",
    text: "Yes! The Banarasi silk in ruby red is in stock — ₹4,299 with free delivery. Want me to hold one?",
    typing: 1200,
    pause: 900,
    time: "10:41",
  },
  { from: "customer", text: "book it", typing: 700, pause: 600, time: "10:42" },
  {
    from: "agent",
    text: "Booked ✅ Order #AD-2481 confirmed. Delivery by Friday — I'll share tracking here.",
    typing: 1100,
    pause: 2600,
    time: "10:42",
  },
];

const FLOATS = [
  { icon: Sparkles, label: "Campaign drafted", value: "Diwali · 3 variants", at: 700 },
  { icon: Bot, label: "Replies handled today", value: "47 conversations", at: 1900 },
  { icon: IndianRupee, label: "Revenue attributed", value: "₹52,000 this week", at: 3100 },
];

export function PhoneDemo() {
  const [visible, setVisible] = useState(0);
  const [typing, setTyping] = useState<"customer" | "agent" | null>(null);
  const [readCount, setReadCount] = useState(0);
  const [floats, setFloats] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    if (reduce) {
      setVisible(SCRIPT.length);
      setReadCount(SCRIPT.length);
      setFloats(FLOATS.length);
      return;
    }

    const push = (fn: () => void, at: number) => {
      timers.current.push(setTimeout(fn, at));
    };

    FLOATS.forEach((f, i) => push(() => setFloats(i + 1), f.at));

    const run = () => {
      let t = 400;
      SCRIPT.forEach((turn, i) => {
        push(() => setTyping(turn.from), t);
        t += turn.typing;
        push(() => {
          setTyping(null);
          setVisible(i + 1);
        }, t);
        t += 450;
        push(() => setReadCount(i + 1), t);
        t += turn.pause;
      });
      push(() => {
        setVisible(0);
        setReadCount(0);
      }, t + 900);
      push(run, t + 1400);
    };

    run();
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, []);

  return (
    <div className="relative mx-auto w-full max-w-[22rem] sm:max-w-sm">
      {/* glow */}
      <div className="pointer-events-none absolute -inset-10 -z-10 rounded-full bg-[radial-gradient(circle_at_center,color-mix(in_oklab,var(--primary)_28%,transparent),transparent_70%)] blur-2xl" />

      {/* phone */}
      <div className="relative rounded-[2.25rem] border border-border bg-foreground/90 p-2 shadow-[0_40px_80px_-32px_color-mix(in_oklab,var(--foreground)_45%,transparent)]">
        <div className="overflow-hidden rounded-[1.85rem] bg-secondary">
          {/* chat header */}
          <div className="flex items-center gap-3 bg-gradient-to-r from-primary to-teal-500 px-4 py-3 text-primary-foreground">
            <div className="flex size-9 items-center justify-center rounded-full bg-primary-foreground/20 text-sm font-bold">
              AD
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Meera Silks</p>
              <p className="flex items-center gap-1 text-[11px] opacity-90">
                <span className="inline-block size-1.5 rounded-full bg-primary-foreground/90" />
                AiDwar agent · online
              </p>
            </div>
          </div>

          {/* messages */}
          <div className="relative flex h-[24rem] flex-col justify-end gap-2 overflow-hidden bg-[color-mix(in_oklab,var(--secondary)_70%,white)] px-3 py-4">
            <div className="pointer-events-none absolute inset-0 opacity-[0.35] [background-image:radial-gradient(color-mix(in_oklab,var(--foreground)_14%,transparent)_1px,transparent_1px)] [background-size:16px_16px]" />
            <div className="relative flex flex-col gap-2">
              {SCRIPT.slice(0, visible).map((turn, i) => (
                <Bubble
                  key={`${turn.text}-${i}`}
                  turn={turn}
                  read={readCount > i && turn.from === "agent"}
                />
              ))}
              {typing ? <TypingBubble side={typing} /> : null}
            </div>
          </div>

          {/* composer */}
          <div className="flex items-center gap-2 bg-card px-3 py-3">
            <div className="h-9 flex-1 rounded-full bg-muted px-4 text-xs leading-9 text-muted-foreground">
              Handled automatically by AiDwar
            </div>
            <div className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Bot className="size-4" />
            </div>
          </div>
        </div>
      </div>

      {/* floating cards */}
      <div className="pointer-events-none absolute inset-0 hidden lg:block">
        {FLOATS.map((f, i) => (
          <div
            key={f.label}
            className={cn(
              "absolute flex items-center gap-3 rounded-2xl border border-border bg-card/95 px-4 py-3 shadow-[var(--shadow-card)] backdrop-blur transition-all duration-700 ease-out motion-reduce:transition-none",
              floats > i ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
              i === 0 && "-left-32 top-24 animate-[float_6s_ease-in-out_infinite]",
              i === 1 && "-right-24 top-40 animate-[float_7s_ease-in-out_infinite_0.6s]",
              i === 2 && "-left-24 bottom-12 animate-[float_6.5s_ease-in-out_infinite_1.2s]",
            )}
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <f.icon className="size-4" />
            </div>
            <div className="whitespace-nowrap">
              <p className="text-[11px] font-medium text-muted-foreground">{f.label}</p>
              <p className="text-sm font-semibold text-card-foreground">{f.value}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Bubble({ turn, read }: { turn: Turn; read: boolean }) {
  const agent = turn.from === "agent";
  return (
    <div className={cn("flex", agent ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[82%] animate-[bubble-in_260ms_ease-out] rounded-2xl px-3 py-2 text-[13px] leading-relaxed shadow-sm",
          agent
            ? "rounded-br-md bg-primary/15 text-foreground"
            : "rounded-bl-md bg-card text-card-foreground",
        )}
      >
        <p>{turn.text}</p>
        <div className="mt-1 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
          <span>{turn.time}</span>
          {agent ? (
            read ? (
              <CheckCheck className="size-3 text-primary" />
            ) : (
              <Check className="size-3" />
            )
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TypingBubble({ side }: { side: "customer" | "agent" }) {
  const agent = side === "agent";
  return (
    <div className={cn("flex", agent ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "flex animate-[bubble-in_200ms_ease-out] items-center gap-1 rounded-2xl px-3 py-2.5 shadow-sm",
          agent ? "rounded-br-md bg-primary/15" : "rounded-bl-md bg-card",
        )}
      >
        {[0, 1, 2].map((d) => (
          <span
            key={d}
            style={{ animationDelay: `${d * 160}ms` }}
            className="inline-block size-1.5 animate-[typing-dot_1.1s_ease-in-out_infinite] rounded-full bg-muted-foreground/70"
          />
        ))}
      </div>
    </div>
  );
}
