import { useEffect, useState, type ReactNode } from "react";
import { Bot, Code2, FileText, Inbox, Megaphone, Sparkles, Workflow } from "lucide-react";
import { Rise, usePlay } from "@/components/start/start-motion";
import { cn } from "@/lib/utils";

/**
 * Batch 73: "Everything WhatsApp can do for your business." Six tiles, each
 * with a small scene that loops only while the tile is on screen. Every scene's
 * resting state (the server's paint, reduced motion) is its finished frame.
 */

function Tile({
  icon: Icon,
  title,
  line,
  className,
  delay,
  children,
}: {
  icon: typeof Bot;
  title: string;
  line: string;
  className?: string;
  delay: number;
  children: (play: "on" | "off") => ReactNode;
}) {
  const { ref, play } = usePlay<HTMLDivElement>();
  return (
    <Rise
      as="li"
      delay={delay}
      className={cn(
        "flex flex-col overflow-hidden rounded-3xl border border-border bg-background shadow-[0_1px_0_rgba(6,40,28,0.04),0_24px_50px_-36px_rgba(6,40,28,0.35)]",
        className,
      )}
    >
      <div
        ref={ref}
        data-play={play}
        aria-hidden="true"
        className="relative h-44 overflow-hidden border-b border-border/70 bg-[radial-gradient(120%_90%_at_50%_0%,color-mix(in_oklab,var(--success)_9%,transparent),transparent_70%)]"
      >
        {children(play)}
      </div>
      <div className="p-5 sm:p-6">
        <h3 className="flex items-center gap-2 text-lg font-bold text-foreground">
          <Icon className="h-5 w-5 text-success" aria-hidden="true" />
          {title}
        </h3>
        <p className="mt-1.5 text-[15px] leading-relaxed text-muted-foreground">{line}</p>
      </div>
    </Rise>
  );
}

/** 0 → 1,900 while playing, then holds; shows 1,900 at rest. */
function useLoopCount(to: number, play: boolean) {
  const [n, setN] = useState(to);
  useEffect(() => {
    if (!play) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let start = performance.now();
    let last = 0;
    const tick = (now: number) => {
      const t = ((now - start) % 5000) / 3500;
      if (now - last > 50) {
        last = now;
        setN(Math.round(to * Math.min(1, 1 - Math.pow(1 - Math.min(1, t), 3))));
      }
      raf = requestAnimationFrame(tick);
    };
    start = performance.now();
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setN(to);
    };
  }, [play, to]);
  return n;
}

function CampaignScene({ play }: { play: boolean }) {
  const n = useLoopCount(1900, play);
  return (
    <div className="absolute inset-0 grid place-items-center px-6">
      <div className="w-full max-w-[300px] rounded-2xl border border-border bg-background p-4 shadow-sm">
        <div className="flex items-center justify-between text-xs font-semibold text-foreground">
          <span>Diwali offer</span>
          <span className="tabular-nums text-success">Sent {n.toLocaleString("en-IN")}</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
          <div className="s73-anim s73-bar-fill h-full rounded-full bg-success" />
        </div>
        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="font-semibold text-[#34b7f1]">✓✓</span> Read receipts as they arrive
        </div>
      </div>
      {[14, 32, 55, 72, 88].map((x) => (
        <span
          key={x}
          className="s73-anim s73-tick absolute top-5 text-sm font-bold text-[#34b7f1]"
          style={{ left: `${x}%` }}
        >
          ✓✓
        </span>
      ))}
    </div>
  );
}

function AidenScene() {
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-2 px-6">
      <span className="max-w-[80%] self-start rounded-2xl rounded-tl-md bg-muted px-3 py-2 text-[13px] text-foreground">
        Do you have this ring in 18k?
      </span>
      <div className="grid self-end">
        <span className="s73-anim s73-dots-cycle flex gap-1 self-end justify-self-end rounded-2xl bg-success-soft px-3 py-2.5 [grid-area:1/1]">
          {[0, 1, 2].map((i) => (
            <span key={i} className="h-1.5 w-1.5 rounded-full bg-success/70" />
          ))}
        </span>
        <span className="s73-anim s73-answer-cycle max-w-[240px] rounded-2xl rounded-tr-md bg-success px-3 py-2 text-[13px] text-success-foreground [grid-area:1/1]">
          Yes — 18k, ₹42,800, ready to ship today. Want the photos?
        </span>
      </div>
    </div>
  );
}

const FLOW_NODES = ["Trigger", "Welcome", "Offer", "Card"];

function FlowScene() {
  return (
    <div className="absolute inset-0 grid place-items-center px-4">
      <div className="relative w-full max-w-[420px]">
        <svg
          className="absolute inset-x-[10%] top-1/2 h-2 w-[80%] -translate-y-1/2 overflow-visible"
          viewBox="0 0 100 2"
          preserveAspectRatio="none"
        >
          <path
            d="M0 1 H100"
            pathLength={1}
            className="s73-anim s73-draw"
            stroke="var(--success)"
            strokeWidth="2"
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="relative flex justify-between">
          {FLOW_NODES.map((label, i) => (
            <span
              key={label}
              className="s73-anim s73-node rounded-xl border border-success-border bg-background px-2.5 py-2 text-xs font-semibold text-foreground shadow-sm sm:px-3"
              style={{ animationDelay: `${i * 0.45}s` }}
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function InboxScene() {
  const people = [
    { i: "AR", c: "bg-amber-100 text-amber-900" },
    { i: "RK", c: "bg-sky-100 text-sky-900" },
    { i: "SM", c: "bg-violet-100 text-violet-900" },
  ];
  return (
    <div className="absolute inset-0 grid place-items-center">
      <div className="relative w-[228px]" style={{ ["--hop" as string]: "84px" }}>
        <div className="s73-anim s73-hop relative mb-3 w-[60px]">
          <span className="block whitespace-nowrap rounded-xl bg-success px-1.5 py-1.5 text-center text-[10.5px] font-semibold text-success-foreground shadow">
            New chat
          </span>
        </div>
        <div className="flex justify-between">
          {people.map((p) => (
            <span
              key={p.i}
              className={cn(
                "grid h-[60px] w-[60px] place-items-center rounded-full text-sm font-bold",
                p.c,
              )}
            >
              {p.i}
            </span>
          ))}
        </div>
        <span className="s73-anim s73-assign absolute -bottom-7 right-0 rounded-full bg-foreground px-2.5 py-1 text-[11px] font-semibold text-background">
          Assigned
        </span>
      </div>
    </div>
  );
}

function OrderScene() {
  return (
    <div className="absolute inset-0 grid place-items-center px-6">
      <div className="relative grid w-full max-w-[260px]">
        <div className="s73-anim s73-order rounded-2xl border border-border bg-background p-3 text-xs shadow-sm [grid-area:1/1]">
          <p className="font-semibold text-foreground">Order #1042</p>
          <p className="mt-1 text-muted-foreground">2 items · ₹4,250 · COD</p>
        </div>
        <div className="s73-anim s73-confirm self-center rounded-2xl rounded-tr-md bg-[#d9fdd3] p-3 text-[12.5px] text-[#111b21] shadow-sm [grid-area:1/1]">
          <p className="font-semibold">Order confirmed ✓</p>
          <p className="mt-0.5">Thanks Priya! Your invoice is attached.</p>
          <span className="s73-anim s73-fly mt-2 inline-flex items-center gap-1.5 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold">
            <FileText className="h-3.5 w-3.5 text-red-600" aria-hidden="true" /> Invoice.pdf
          </span>
        </div>
      </div>
    </div>
  );
}

function AgentScene() {
  return (
    <div className="absolute inset-0 flex flex-col justify-center gap-2.5 px-5">
      <div className="rounded-xl border border-border bg-background px-3 py-2.5 text-[12.5px] text-foreground shadow-sm">
        <span className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Sparkles className="h-3 w-3" aria-hidden="true" /> Your AI assistant
        </span>
        <span className="s73-anim s73-type block whitespace-nowrap">
          Draft a Diwali campaign for my VIP customers
        </span>
      </div>
      <div className="s73-anim s73-draft flex items-center justify-between gap-3 rounded-xl border border-success-border bg-success-soft px-3 py-2.5 text-xs">
        <span>
          <span className="block font-semibold text-foreground">Diwali VIP offer · Draft</span>
          <span className="text-muted-foreground">214 customers</span>
        </span>
        <span className="shrink-0 rounded-full bg-amber-100 px-2 py-1 text-[11px] font-semibold text-amber-900">
          Needs your OK
        </span>
      </div>
    </div>
  );
}

export function StartBento() {
  return (
    <section className="bg-muted/40 py-20 sm:py-28" aria-labelledby="bento">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Rise>
          <h2
            id="bento"
            className="max-w-3xl text-[2rem] font-extrabold leading-[1.08] tracking-[-0.03em] text-foreground sm:text-[2.9rem]"
          >
            Everything WhatsApp can do for your business. In one place.
          </h2>
        </Rise>
        <ul className="mt-10 grid gap-4 md:grid-cols-6">
          <Tile
            icon={Megaphone}
            title="Campaigns"
            line="Send to thousands. Track every read."
            className="md:col-span-4"
            delay={0}
          >
            {(play) => <CampaignScene play={play === "on"} />}
          </Tile>
          <Tile
            icon={Bot}
            title="AI replies (Aiden)"
            line="Answers in seconds. Day and night."
            className="md:col-span-2"
            delay={60}
          >
            {() => <AidenScene />}
          </Tile>
          <Tile
            icon={Workflow}
            title="Flows"
            line="Set it once. It runs forever."
            className="md:col-span-3"
            delay={0}
          >
            {() => <FlowScene />}
          </Tile>
          <Tile
            icon={Inbox}
            title="Team inbox"
            line="One number. Your whole team."
            className="md:col-span-3"
            delay={60}
          >
            {() => <InboxScene />}
          </Tile>
          <Tile
            icon={Code2}
            title="Shopify & API"
            line="Orders, invoices, COD confirmations — sent automatically."
            className="md:col-span-3"
            delay={0}
          >
            {() => <OrderScene />}
          </Tile>
          <Tile
            icon={Sparkles}
            title="AI agents (MCP)"
            line="Works with Claude and ChatGPT. You approve before anything sends."
            className="md:col-span-3"
            delay={60}
          >
            {() => <AgentScene />}
          </Tile>
        </ul>
      </div>
    </section>
  );
}
