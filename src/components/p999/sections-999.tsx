import { forwardRef } from "react";
import { Link } from "@tanstack/react-router";
import {
  BadgeIndianRupee,
  Inbox,
  Megaphone,
  ShieldCheck,
  Smartphone,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import { GET_TILES, HERO, PER_MONTH, STEPS, STICKY } from "@/lib/page-999";
import { MagneticCta, Reveal, useInView, usePlaying } from "@/components/p999/p999-motion";
import { cn } from "@/lib/utils";

/**
 * Batch 80: /999's sections after the hero and the calculator. Every number
 * on them is the plan's own (₹999, 300 answers, 1 number, 2 people) or a
 * real one already public (ZOORI's Diwali campaign, /start); the screen in
 * Proof is the real AiDwar inbox with the customer's name and number cut out.
 */

const TILE_ICON: Record<(typeof GET_TILES)[number]["key"], LucideIcon> = {
  number: Smartphone,
  aiden: Sparkles,
  inbox: Inbox,
  campaigns: Megaphone,
  meta: BadgeIndianRupee,
};

export function SectionHead({
  kicker,
  title,
  sub,
  dark = false,
  id,
}: {
  kicker: string;
  title: string;
  sub?: string;
  dark?: boolean;
  id: string;
}) {
  return (
    <Reveal className="mx-auto max-w-2xl text-center">
      <p
        className={cn(
          "text-[12px] font-bold uppercase tracking-[0.18em]",
          dark ? "text-[var(--mint)]" : "text-[var(--mint-2)]",
        )}
      >
        {kicker}
      </p>
      <h2
        id={id}
        className={cn(
          "mt-3 text-[2.1rem] font-extrabold leading-[1.04] tracking-[-0.04em] sm:text-[3rem]",
          dark ? "text-white" : "text-[var(--ink)]",
        )}
      >
        {title}
      </h2>
      {sub ? (
        <p
          className={cn(
            "mx-auto mt-3 max-w-xl text-[16px] leading-relaxed sm:text-[18px]",
            dark ? "text-white/70" : "text-[var(--ink)]/65",
          )}
        >
          {sub}
        </p>
      ) : null}
    </Reveal>
  );
}

/* ------------------------------------------------------- what you get --- */

export function WhatYouGet() {
  return (
    <section className="p9-paper px-4 pb-20 pt-4 sm:px-6 sm:pb-28" aria-labelledby="p9-get">
      <SectionHead
        id="p9-get"
        kicker={`What you get for ${PER_MONTH.replace("/month", "")}`}
        title="Everything to sell on WhatsApp."
        sub="One plan. No setup fee. No per-message markup."
      />
      <ul className="mx-auto mt-10 grid max-w-5xl gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {GET_TILES.map((t, i) => {
          const Icon = TILE_ICON[t.key];
          const featured = t.key === "aiden";
          return (
            <Reveal
              as="li"
              key={t.key}
              delay={i * 70}
              className={cn(
                "group relative overflow-hidden rounded-[1.5rem] p-6 transition-transform duration-300 hover:-translate-y-1",
                featured
                  ? "bg-[var(--ink)] text-white sm:row-span-2 lg:row-span-1 lg:col-span-2"
                  : "border border-[var(--line)] bg-white text-[var(--ink)]",
              )}
            >
              {featured ? (
                <div
                  aria-hidden="true"
                  className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-[radial-gradient(closest-side,rgba(62,230,160,0.4),transparent)]"
                />
              ) : null}
              <span
                className={cn(
                  "relative grid h-12 w-12 place-items-center rounded-2xl transition-transform duration-500 group-hover:rotate-[-8deg] group-hover:scale-110",
                  featured
                    ? "bg-[var(--mint)] text-[#022c1b]"
                    : "bg-[var(--mint-soft)] text-[var(--mint-2)]",
                )}
              >
                <Icon className="h-6 w-6" strokeWidth={2.2} aria-hidden="true" />
              </span>
              <h3 className="relative mt-5 text-[1.25rem] font-extrabold tracking-tight">
                {t.title}
              </h3>
              <p
                className={cn(
                  "relative mt-1.5 text-[15px] leading-relaxed",
                  featured ? "text-white/70" : "text-[var(--ink)]/65",
                )}
              >
                {t.body}
              </p>
            </Reveal>
          );
        })}
      </ul>
    </section>
  );
}

/* ---------------------------------------------------------- 3 steps --- */

function StepIcon({ kind }: { kind: (typeof STEPS)[number]["key"] }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    pathLength: 1,
    className: "p9-draw",
  };
  return (
    <svg viewBox="0 0 48 48" className="h-12 w-12" aria-hidden="true">
      {kind === "connect" ? (
        <>
          <rect x="12" y="5" width="20" height="38" rx="4.5" {...common} />
          <path d="M19 37h6" {...common} style={{ ["--d" as string]: "250ms" }} />
          <path
            d="M30 18c4 0 7 3 7 7s-3 7-7 7"
            {...common}
            style={{ ["--d" as string]: "450ms" }}
          />
          <path
            d="M33 13c7 0 12 5 12 12s-5 12-12 12"
            {...common}
            style={{ ["--d" as string]: "650ms" }}
          />
        </>
      ) : kind === "learn" ? (
        <>
          <path d="M10 6h20l8 8v28H10z" {...common} />
          <path d="M30 6v8h8" {...common} style={{ ["--d" as string]: "250ms" }} />
          <path
            d="M16 22h16M16 29h16M16 36h10"
            {...common}
            style={{ ["--d" as string]: "450ms" }}
          />
        </>
      ) : (
        <>
          <circle cx="24" cy="24" r="18" {...common} />
          <path d="m16 24.5 5.5 5.5L33 18.5" {...common} style={{ ["--d" as string]: "350ms" }} />
        </>
      )}
    </svg>
  );
}

export function LiveIn10() {
  const { ref, inView } = useInView<HTMLOListElement>();
  return (
    <section className="p9-paper px-4 pb-20 sm:px-6 sm:pb-28" aria-labelledby="p9-steps">
      <SectionHead
        id="p9-steps"
        kicker="Live in 10 minutes"
        title="Three steps. No developer."
        sub="Most businesses are answering customers with Aiden the same evening."
      />
      <ol
        ref={ref}
        data-in={inView === null ? undefined : inView ? "true" : "false"}
        className="relative mx-auto mt-10 grid max-w-5xl gap-4 lg:grid-cols-3"
      >
        <span
          aria-hidden="true"
          className="p9-line absolute bottom-10 left-[2.85rem] top-10 w-[2px] origin-top bg-gradient-to-b from-[var(--mint-2)] to-transparent lg:hidden"
        />
        {STEPS.map((s, i) => (
          <li
            key={s.key}
            className="relative flex gap-4 rounded-[1.5rem] border border-[var(--line)] bg-white p-5 lg:flex-col lg:p-7"
          >
            <span className="relative z-[1] grid h-[4.25rem] w-[4.25rem] flex-none place-items-center rounded-2xl bg-[var(--ink)] text-[var(--mint)]">
              <StepIcon kind={s.key} />
            </span>
            <div>
              <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-[var(--mint-2)]">
                Step {i + 1}
              </p>
              <h3 className="mt-1 text-[1.15rem] font-extrabold leading-snug tracking-tight text-[var(--ink)]">
                {s.title}
              </h3>
              <p className="mt-1 text-[15px] leading-relaxed text-[var(--ink)]/65">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------- proof --- */

export function Proof() {
  return (
    <section
      className="p9-dark relative overflow-hidden px-4 py-20 sm:px-6 sm:py-28"
      aria-labelledby="p9-proof"
    >
      <div aria-hidden="true" className="p9-grid" />
      <SectionHead
        dark
        id="p9-proof"
        kicker="The real thing"
        title="This is AiDwar, not a mock-up."
        sub="A customer asks for a Meenakari set under ₹40,000. Aiden answers with the right product from the shop's own catalogue."
      />
      <div className="relative mx-auto mt-10 grid max-w-5xl items-center gap-8 lg:grid-cols-[1fr_0.9fr]">
        <Reveal className="mx-auto w-full max-w-[420px]">
          <figure className="overflow-hidden rounded-[1.75rem] border border-white/10 bg-[#f3f6f4] shadow-[0_40px_100px_-40px_rgba(62,230,160,0.5)]">
            <div className="flex items-center gap-2 border-b border-black/5 bg-white px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-[#10b981]" aria-hidden="true" />
              <span className="text-[13px] font-bold text-[#04100b]">AiDwar · Inbox</span>
              <span className="ml-auto rounded-full bg-[#e7f8f0] px-2 py-0.5 text-[11px] font-semibold text-[#047857]">
                Aiden replying
              </span>
            </div>
            <img
              src="/999-inbox-aiden.webp"
              width={780}
              height={688}
              loading="lazy"
              decoding="async"
              alt="The AiDwar inbox: a customer asks for a Meenakari set under ₹40,000 and Aiden replies with the Meenakari Kundan set at ₹36,500, noting it used something the shop taught it."
              className="block h-auto w-full"
            />
            <figcaption className="bg-white px-4 py-3 text-[12px] text-[#04100b]/60">
              A screen from the AiDwar inbox (example shop; the customer's name and number are
              hidden).
            </figcaption>
          </figure>
        </Reveal>
        <Reveal delay={120} className="text-center lg:text-left">
          <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-[var(--mint)]">
            Live on AiDwar · Hyderabad
          </p>
          <p className="mt-3 text-[4.25rem] font-extrabold leading-none tracking-[-0.05em] text-white sm:text-[5.5rem]">
            1,900+
          </p>
          <p className="mt-2 text-[18px] font-semibold text-white/85">
            customers reached in one Diwali campaign
          </p>
          <p className="mt-1 text-[15px] text-white/55">ZOORI Jewels</p>
          <p className="mx-auto mt-6 max-w-sm border-l-2 border-[var(--mint)] pl-4 text-left text-[15px] leading-relaxed text-white/75 lg:mx-0">
            Same inbox, same Aiden, same campaigns — on ₹999 you get them for one number.
          </p>
        </Reveal>
      </div>
    </section>
  );
}

/* --------------------------------------------------------- Meta note --- */

export function MetaNote() {
  return (
    <section className="p9-paper px-4 py-20 sm:px-6 sm:py-24" aria-labelledby="p9-meta">
      <Reveal className="mx-auto grid max-w-4xl items-center gap-8 rounded-[1.75rem] border border-[var(--line)] bg-white p-6 sm:p-10 lg:grid-cols-[1fr_auto]">
        <div>
          <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-[var(--mint-2)]">
            The honest bit
          </p>
          <h2
            id="p9-meta"
            className="mt-3 text-[1.75rem] font-extrabold leading-tight tracking-[-0.035em] text-[var(--ink)] sm:text-[2.25rem]"
          >
            You add your card in Meta once (2 minutes).
          </h2>
          <p className="mt-3 text-[16px] leading-relaxed text-[var(--ink)]/70">
            Meta bills you directly for messages — we never touch it. No wallet to top up, no
            credits, no surprises from us.
          </p>
        </div>
        <div aria-hidden="true" className="mx-auto flex items-center gap-3">
          <div className="relative h-[72px] w-[112px] rounded-xl bg-gradient-to-br from-[#0f2a20] to-[#04100b] p-3 text-white shadow-lg">
            <span className="block h-3 w-5 rounded-sm bg-[#e8c27a]" />
            <span className="mt-4 block text-[10px] tracking-[0.2em] text-white/70">•••• 4021</span>
          </div>
          <svg viewBox="0 0 60 20" className="h-5 w-14 text-[var(--mint-2)]">
            <path
              d="M2 10h50m-8-7 8 7-8 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <span className="rounded-full bg-[var(--ink)] px-4 py-2 text-[14px] font-extrabold text-white">
            Meta
          </span>
        </div>
      </Reveal>
    </section>
  );
}

/* --------------------------------------------------------- guarantee --- */

export function Guarantee() {
  const { ref, play } = usePlaying<HTMLDivElement>();
  return (
    <section className="p9-paper px-4 pb-20 sm:px-6 sm:pb-28" aria-labelledby="p9-guarantee">
      <Reveal className="mx-auto max-w-4xl">
        <div
          ref={ref}
          data-play={play}
          className="relative overflow-hidden rounded-[1.75rem] bg-gradient-to-br from-[#0b2a1e] via-[#04100b] to-[#04100b] p-7 text-white sm:p-10"
        >
          <div className="grid items-center gap-6 sm:grid-cols-[auto_1fr]">
            <div className="relative mx-auto h-36 w-36" aria-hidden="true">
              <svg viewBox="0 0 160 160" className="p9-stamp-ring absolute inset-0 h-full w-full">
                <defs>
                  <path id="p9-ring" d="M80 80m-62 0a62 62 0 1 1 124 0a62 62 0 1 1-124 0" />
                </defs>
                <text className="fill-[var(--mint)] text-[12px] font-bold">
                  <textPath href="#p9-ring" textLength="388" lengthAdjust="spacing">
                    7-DAY MONEY-BACK • NO QUESTIONS ASKED •
                  </textPath>
                </text>
              </svg>
              <span className="absolute inset-[30px] grid place-items-center rounded-full bg-[var(--mint)] text-[#022c1b]">
                <ShieldCheck className="h-11 w-11" strokeWidth={2.2} />
              </span>
            </div>
            <div className="text-center sm:text-left">
              <h2
                id="p9-guarantee"
                className="text-[1.9rem] font-extrabold leading-tight tracking-[-0.035em] sm:text-[2.4rem]"
              >
                7-day money-back guarantee.
              </h2>
              <p className="mt-3 text-[16px] leading-relaxed text-white/75">
                Try AiDwar Basic for a week. If it isn't for you, tell us within 7 days of paying
                and we refund your ₹999 in full. No forms, no questions.
              </p>
            </div>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* --------------------------------------------------------------- FAQ --- */

export function Faq({ items }: { items: ReadonlyArray<{ q: string; a: string }> }) {
  return (
    <section className="p9-paper px-4 pb-20 sm:px-6 sm:pb-28" aria-labelledby="p9-faq">
      <SectionHead id="p9-faq" kicker="Questions" title="Straight answers." />
      <div className="mx-auto mt-8 max-w-3xl divide-y divide-[var(--line)] rounded-[1.5rem] border border-[var(--line)] bg-white">
        {items.map((f) => (
          <details key={f.q} className="p9-faq group px-5 sm:px-7">
            <summary className="flex min-h-[3.75rem] items-center justify-between gap-4 py-4 text-left text-[16.5px] font-bold text-[var(--ink)]">
              {f.q}
              <span
                aria-hidden="true"
                className="p9-plus grid h-8 w-8 flex-none place-items-center rounded-full bg-[var(--paper)] text-[18px] font-bold text-[var(--ink)]"
              >
                +
              </span>
            </summary>
            <p className="pb-5 text-[15.5px] leading-relaxed text-[var(--ink)]/70">{f.a}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- final CTA --- */

export const FinalCta = forwardRef<HTMLDivElement, { onStart: () => void; onWarm: () => void }>(
  function FinalCta({ onStart, onWarm }, ref) {
    return (
      <section
        className="p9-dark relative overflow-hidden px-4 py-24 text-center sm:px-6 sm:py-32"
        aria-labelledby="p9-final"
      >
        <div aria-hidden="true" className="p9-aurora">
          <i />
          <i />
          <i />
        </div>
        <div aria-hidden="true" className="p9-grain" />
        <div className="relative mx-auto max-w-2xl">
          <h2
            id="p9-final"
            className="p9-h1 text-[2.6rem] font-extrabold text-white sm:text-[4rem]"
          >
            Start selling on WhatsApp <span className="p9-shine">tonight.</span>
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-[17px] leading-relaxed text-white/70">
            {HERO.sub}
          </p>
          <div ref={ref} className="mt-8 flex flex-col items-center gap-3">
            <MagneticCta
              onClick={onStart}
              onPointerEnter={onWarm}
              onTouchStart={onWarm}
              className="w-full max-w-sm"
            >
              Start for ₹999{" "}
              <span className="p9-arrow" aria-hidden="true">
                →
              </span>
            </MagneticCta>
            <p className="text-[13.5px] text-white/60">{HERO.small}</p>
          </div>
        </div>
      </section>
    );
  },
);

/* ------------------------------------------------------------ footer --- */

export function Footer() {
  return (
    <footer className="bg-[var(--ink)] px-4 pb-28 pt-4 text-center text-[13px] text-white/55 md:pb-10">
      <Link to="/privacy" className="underline-offset-2 hover:underline">
        Privacy
      </Link>
      {" · "}
      <Link to="/terms" className="underline-offset-2 hover:underline">
        Terms
      </Link>
      {" · "}
      <Link to="/refunds" className="underline-offset-2 hover:underline">
        Refunds
      </Link>
      {" · "}© Meezoy Ventures Pvt Ltd
    </footer>
  );
}

/* -------------------------------------------------------- sticky bar --- */

export function StickyBar({
  on,
  onStart,
  onWarm,
}: {
  on: boolean;
  onStart: () => void;
  onWarm: () => void;
}) {
  return (
    <div
      className="p9-sticky fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 sm:px-6"
      data-on={on ? "true" : "false"}
      data-testid="sticky-bar"
      aria-hidden={on ? undefined : true}
    >
      <div className="mx-auto flex max-w-xl items-center justify-between gap-3 rounded-full border border-white/10 bg-[#04100b]/90 py-2 pl-5 pr-2 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)] backdrop-blur-xl">
        <p className="text-[15px] font-extrabold text-white">
          {STICKY.price}
          <span className="hidden font-medium text-white/55 sm:inline"> · zero markup</span>
        </p>
        <button
          type="button"
          tabIndex={on ? 0 : -1}
          onClick={onStart}
          onPointerEnter={onWarm}
          onTouchStart={onWarm}
          className="p9-cta min-h-11 px-5 text-[15px]"
        >
          {STICKY.cta}
        </button>
      </div>
    </div>
  );
}
