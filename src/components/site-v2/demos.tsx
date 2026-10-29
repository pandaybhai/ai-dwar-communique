import { useEffect, useRef, useState, type ReactNode } from "react";
import { CheckCheck } from "lucide-react";
import { AidenOrb } from "@/components/design-v2/aiden-orb";
import { ProductBubble, WhatsAppBubble } from "@/components/design-v2/whatsapp-bubble";
import { afterLoadIdle } from "@/lib/new-site";
import { cn } from "@/lib/utils";

/**
 * Batch 50: the new landing's product demos (docs/design/preview.html, Home,
 * Inbox and Campaigns), drawn with the design-v2 pieces. Written examples
 * with a sample shop, labelled as such on the page; nothing here reads data.
 * Motion is CSS (transform / opacity) plus small timers, no motion library,
 * so the landing stays light; with reduced motion everything shows at once.
 */

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** True once the element has been on screen (and at once when it can't be watched). */
function useSeen<T extends HTMLElement>(threshold = 0.3) {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  // Nothing moves until the page has loaded and gone idle (the first paint comes first).
  const [ready, setReady] = useState(false);
  useEffect(() => afterLoadIdle(() => setReady(true)), []);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen || !ready) return;
    if (typeof IntersectionObserver === "undefined" || prefersReducedMotion()) {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { threshold },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, threshold, ready]);
  return { ref, seen };
}

/** Counts up to `value` over 1.2 s (ease-out cubic) once `run` is true. */
function Ticker({ value, run, prefix = "" }: { value: number; run: boolean; prefix?: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!run) return;
    if (prefersReducedMotion()) {
      setShown(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / 1200);
      setShown(Math.round(value * (1 - Math.pow(1 - t, 3))));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [run, value]);
  const text = `${prefix}${shown.toLocaleString("en-IN")}`;
  return (
    <>
      <span aria-hidden="true">{text}</span>
      <span className="sr-only">{`${prefix}${value.toLocaleString("en-IN")}`}</span>
    </>
  );
}

/* ------------------------------------------------------------ hero chat */

const REPLY = "Yes Priya, 2 left in medium. Here it is:";

/**
 * Aiden answering a customer, step by step: the question, Aiden typing, the
 * product, the follow-up, and Aiden pausing for the owner on a discount.
 */
export function AidenChatDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>(0.2);
  const [step, setStep] = useState(1);
  const [typed, setTyped] = useState(0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (!seen) return;
    if (prefersReducedMotion()) {
      setStep(5);
      setTyped(REPLY.length);
      return;
    }
    setStep(1);
    setTyped(0);
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
    at(700, () => setStep(2));
    let i = 0;
    at(900, () => {
      const id = window.setInterval(() => {
        i += 1;
        setTyped(i);
        if (i >= REPLY.length) window.clearInterval(id);
      }, 32);
      timers.push(id);
    });
    at(900 + REPLY.length * 32 + 400, () => setStep(3));
    at(900 + REPLY.length * 32 + 1700, () => setStep(4));
    at(900 + REPLY.length * 32 + 3000, () => setStep(5));
    return () => timers.forEach((t) => (window.clearTimeout(t), window.clearInterval(t)));
  }, [seen, run]);

  const typing = step === 2 && typed < REPLY.length;
  return (
    <div ref={ref} className="flex flex-col items-center gap-3">
      <figure
        aria-label="Example: Aiden answering a customer on WhatsApp for a sample clothing shop"
        className="m-0 w-full max-w-[340px] rounded-[36px] bg-ink p-2.5 shadow-2xl"
      >
        <div className="flex items-center gap-3 rounded-t-[28px] bg-surface px-4 pb-3 pt-4">
          <AidenOrb state={step < 5 ? "replying" : "draft"} size={40} />
          <div className="min-w-0">
            <p className="m-0 font-semibold leading-tight text-foreground">Kesar &amp; Co.</p>
            <p className="m-0 text-sm text-aiden-deep">
              {step < 5 ? "Aiden is replying" : "Aiden is checking with the owner"}
            </p>
          </div>
        </div>
        <div className="nd-wall flex h-[440px] flex-col justify-end gap-2 overflow-hidden rounded-b-[28px] px-3 pb-4 pt-3 [mask-image:linear-gradient(to_bottom,transparent,black_40px)]">
          <WhatsAppBubble from="in" time="8:44" className="nd-slide-in">
            Hi, do you have the block-print kurta from your Diwali post?
          </WhatsAppBubble>
          {step >= 2 ? (
            <WhatsAppBubble
              from="out"
              sender="Aiden"
              className="nd-slide-in"
              {...(typing ? {} : { time: "8:44", ticks: "read" as const })}
            >
              {REPLY.slice(0, typed)}
              {typing ? <span className="nd-caret" aria-hidden="true" /> : null}
            </WhatsAppBubble>
          ) : null}
          {step >= 3 ? (
            <ProductBubble
              title="Block-print kurta, cotton"
              detail="₹2,450, 2 in stock"
              className="nd-slide-in"
            />
          ) : null}
          {step >= 4 ? (
            <WhatsAppBubble from="in" time="8:51" className="nd-slide-in">
              Can you do ₹200 less? I&apos;ll take both today.
            </WhatsAppBubble>
          ) : null}
          {step >= 5 ? (
            <WhatsAppBubble from="system" className="nd-slide-in">
              Aiden paused: discounts need you. He told Priya he&apos;s checking with the owner.
            </WhatsAppBubble>
          ) : null}
        </div>
      </figure>
      <button
        type="button"
        onClick={() => setRun((r) => r + 1)}
        className={cn(
          "rounded-full px-3 py-1.5 text-sm font-semibold text-aiden-deep transition-opacity duration-200 hover:bg-aiden-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden",
          step >= 5 ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        tabIndex={step >= 5 ? 0 : -1}
        aria-hidden={step >= 5 ? undefined : true}
      >
        Play it again
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- inbox */

const CHATS: Array<{
  i: string;
  name: string;
  last: string;
  when: string;
  tone: string;
  gold?: boolean;
  aiden?: boolean;
}> = [
  {
    i: "PR",
    name: "Priya Reddy",
    last: "Can you do ₹200 less?",
    when: "26m",
    tone: "bg-av1 text-av1-ink",
    gold: true,
  },
  {
    i: "RK",
    name: "Rahul Kapoor",
    last: "Aiden replied with sizes",
    when: "now",
    tone: "bg-av2 text-av2-ink",
    aiden: true,
  },
  {
    i: "AV",
    name: "Ananya Verma",
    last: "Open on Sunday?",
    when: "9m",
    tone: "bg-av5 text-av5-ink",
    aiden: true,
  },
  {
    i: "NM",
    name: "Neha Menon",
    last: "Thank you so much!",
    when: "1h",
    tone: "bg-av4 text-av4-ink",
  },
];

/** The shared Inbox: who is waiting for you, what Aiden is handling, and his suggested reply. */
export function InboxDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  return (
    <div
      ref={ref}
      role="img"
      aria-label="Example: the shared Inbox with one customer waiting for you and Aiden's suggested reply"
      className="grid overflow-hidden rounded-[22px] border border-border bg-surface shadow-xl sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
    >
      <div className="flex flex-col gap-1 border-b border-border p-3 sm:border-b-0 sm:border-r">
        <div className="mb-2 flex flex-wrap gap-1 text-sm font-semibold">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-aiden-soft px-3 py-1.5 text-aiden-deep">
            Waiting for you
            <span className="inline-grid h-5 min-w-5 place-items-center rounded-full bg-gold px-1.5 text-xs font-bold text-gold-ink">
              1
            </span>
          </span>
          <span className="rounded-full px-3 py-1.5 text-muted-foreground">Aiden on it</span>
        </div>
        {CHATS.map((c, k) => (
          <div
            key={c.name}
            className={cn(
              "flex items-center gap-3 rounded-[14px] p-2.5",
              k === 0 && "bg-ground",
              seen ? "nd-slide-in" : "opacity-0",
            )}
            style={{ ["--i" as string]: k }}
          >
            <span
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-full text-sm font-bold",
                c.tone,
              )}
            >
              {c.i}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <b className="truncate text-sm">{c.name}</b>
              <span
                className={cn(
                  "truncate text-sm",
                  c.aiden ? "text-aiden-deep" : "text-muted-foreground",
                )}
              >
                {c.last}
              </span>
            </span>
            <span
              className={cn(
                "text-xs",
                c.gold ? "font-bold text-gold-ink" : "text-muted-foreground",
              )}
            >
              {c.when}
            </span>
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <span className="grid size-9 place-items-center rounded-full bg-av1 text-sm font-bold text-av1-ink">
            PR
          </span>
          <span className="flex min-w-0 flex-col">
            <b className="text-sm">Priya Reddy</b>
            <span className="text-xs text-muted-foreground">Free replies for 21 more hours</span>
          </span>
        </div>
        <div className="nd-wall flex flex-1 flex-col gap-2 p-4">
          <WhatsAppBubble from="in" time="8:51">
            Can you do ₹200 less? I&apos;ll take both today.
          </WhatsAppBubble>
          <WhatsAppBubble from="system">Aiden paused: discounts need you.</WhatsAppBubble>
        </div>
        <div className="flex flex-col gap-2 border-t border-border p-3">
          <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-gold-line bg-gold-bg px-3 py-2.5 text-sm">
            <span className="min-w-0 flex-1">
              <b>Aiden suggests:</b> &ldquo;We can do ₹2,350 each if you take both today.&rdquo;
            </span>
            <span className="rounded-[11px] bg-gold px-3.5 py-2 text-sm font-bold text-gold-ink">
              Send
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- campaign */

const FUNNEL = [
  { label: "Sent", n: 1240, pct: 100 },
  { label: "Delivered", n: 1198, pct: 96 },
  { label: "Read", n: 731, pct: 59 },
  { label: "Replied", n: 48, pct: 4 },
];

/** A campaign's results: sent, delivered, read, replied; what it cost and the sales from replies. */
export function CampaignDemo() {
  const { ref, seen } = useSeen<HTMLDivElement>();
  return (
    <div
      ref={ref}
      className="flex flex-col gap-5 rounded-[22px] border border-border bg-surface p-6 shadow-xl"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 font-display text-[1.375rem] font-semibold">Diwali drop</h3>
        <span className="rounded-full border border-border px-2.5 py-0.5 text-[0.8rem] font-semibold text-muted-foreground">
          Example campaign
        </span>
      </div>
      <dl className="m-0 flex flex-col gap-4">
        {FUNNEL.map((f, k) => (
          <div
            key={f.label}
            className="grid grid-cols-[6.5rem_auto] items-baseline gap-x-4 gap-y-1"
          >
            <dt className="text-muted-foreground">{f.label}</dt>
            <dd className="m-0 font-display text-[1.75rem] font-semibold tabular-nums">
              <Ticker value={f.n} run={seen} />
            </dd>
            <div className="col-span-2 h-3 overflow-hidden rounded-full bg-line" aria-hidden="true">
              {seen ? (
                <i
                  className={cn(
                    "nd-bar-grow block h-full rounded-full",
                    k === 3 ? "bg-gold" : "bg-gradient-to-r from-aiden to-aiden-deep",
                  )}
                  style={{ width: `${f.pct}%` }}
                />
              ) : null}
            </div>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-x-10 gap-y-3 border-t border-border pt-4">
        <Figure label="Cost">
          <Ticker value={1054} run={seen} prefix="₹" />
        </Figure>
        <Figure label="Sales from replies">
          <Ticker value={261000} run={seen} prefix="₹" />
        </Figure>
      </div>
    </div>
  );
}

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground">{label}</span>
      <b className="font-display text-2xl font-semibold tabular-nums">{children}</b>
    </div>
  );
}

/** The campaign as the customer gets it, in the phone. */
export function CampaignPhone() {
  return (
    <figure
      aria-label="Example: the campaign message as a customer sees it"
      className="m-0 w-full max-w-[260px] rounded-[36px] bg-ink p-2.5 shadow-2xl"
    >
      <div className="nd-wall flex flex-col gap-0.5 rounded-[28px] px-3 pb-5 pt-10">
        <div className="overflow-hidden rounded-[12px] bg-surface shadow-xs">
          <span
            aria-hidden="true"
            className="block h-[130px] bg-gradient-to-br from-av5-ink to-av1-ink"
          />
          <p className="m-0 px-2.5 py-2 text-sm">
            Hi Asha, our Diwali collection is here. Hand block-printed cotton, made in Jaipur.
          </p>
          {["View collection", "Talk to us"].map((b) => (
            <span
              key={b}
              className="block border-t border-line p-[9px] text-center text-sm font-bold text-aiden-deep"
            >
              {b}
            </span>
          ))}
        </div>
        <span className="mt-1 flex items-center justify-end gap-1 text-[0.72rem] text-muted-foreground">
          10:02 <CheckCheck className="h-3.5 w-3.5 text-aiden-deep" aria-hidden="true" />
        </span>
      </div>
    </figure>
  );
}
