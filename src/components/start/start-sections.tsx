import { forwardRef, useId, useState } from "react";
import { BellOff, Check, FileText, MoonStar, Smartphone, Upload, UserX, Send } from "lucide-react";
import { useReveal } from "@/hooks/use-reveal";
import { StartLeadForm } from "@/components/start/start-lead-form";
import { CountUp, Rise, usePlay, useScrollProgress } from "@/components/start/start-motion";
import { PRICING_SUB } from "@/lib/start-story";
import { cn } from "@/lib/utils";

/** Batch 73: the /start sections below the hero (copy as briefed, verified claims only). */

const LOGOS: { name: string; className: string }[] = [
  {
    name: "ZOORI Jewels",
    className: "font-serif text-lg font-semibold tracking-[0.18em] uppercase",
  },
  { name: "TalentDwar", className: "text-lg font-extrabold tracking-tight" },
  { name: "Meezoy", className: "text-lg font-bold italic tracking-wide" },
  { name: "Fanzart", className: "font-mono text-base font-semibold tracking-[0.12em] lowercase" },
];

/* ------------------------------------------------------------ logos --- */

export function LogoMarquee() {
  const { ref, play } = usePlay<HTMLDivElement>();
  const list = (hidden: boolean) => (
    <ul
      aria-hidden={hidden || undefined}
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-16 gap-y-4 px-8 text-foreground/70 grayscale"
    >
      {LOGOS.map((l) => (
        <li key={l.name} className={cn("whitespace-nowrap", l.className)}>
          {l.name}
        </li>
      ))}
    </ul>
  );
  return (
    <section className="border-b border-border bg-background py-10" aria-labelledby="logos">
      <h2
        id="logos"
        className="text-center text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground"
      >
        Trusted by growing businesses
      </h2>
      <div ref={ref} data-play={play} className="s73-marquee mx-auto mt-6 max-w-5xl">
        <div className="s73-track">
          {list(false)}
          {list(true)}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ leaks --- */

const LEAKS = [
  {
    icon: BellOff,
    leak: "Broadcasts nobody reads.",
    fix: "Approved WhatsApp templates with images, buttons and offers — they land in the chat your customers already check all day.",
  },
  {
    icon: MoonStar,
    leak: "Messages at 11pm. Nobody replies.",
    fix: "Aiden replies from your own products and prices, in Hindi, Hinglish or English — and hands over when it should.",
  },
  {
    icon: UserX,
    leak: "Customers buy once and vanish.",
    fix: "Welcome flows, offer cards and follow-ups bring them back without you lifting a finger.",
  },
];

function LeakCard({ leak, i }: { leak: (typeof LEAKS)[number]; i: number }) {
  const { ref, shown } = useReveal<HTMLElement>(0.35);
  return (
    <li>
      <article
        ref={ref}
        data-shown={shown ? "true" : "false"}
        className="s73-leak h-full rounded-3xl border border-border bg-background p-6 shadow-[0_24px_50px_-40px_rgba(6,40,28,0.35)] sm:p-7"
        style={{ transitionDelay: `${i * 90}ms` }}
      >
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-red-50 text-red-700">
          <leak.icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <h3 className="mt-5 text-xl font-bold leading-snug text-foreground/80">
          <span className="sr-only">Problem: </span>
          <span className="s73-strike">{leak.leak}</span>
        </h3>
        <div className="s73-fix mt-4">
          <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-success">
            <Check className="h-4 w-4" aria-hidden="true" /> Fixed
          </p>
          <p className="mt-2 text-[15px] leading-relaxed text-foreground">
            <span className="sr-only">Fix: </span>
            {leak.fix}
          </p>
        </div>
      </article>
    </li>
  );
}

export function Leaks() {
  return (
    <section className="bg-background py-20 sm:py-28" aria-labelledby="leaks">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Rise>
          <h2
            id="leaks"
            className="max-w-2xl text-[2rem] font-extrabold leading-[1.08] tracking-[-0.03em] text-foreground sm:text-[2.9rem]"
          >
            Three leaks quietly costing you sales.
          </h2>
        </Rise>
        <ul className="mt-10 grid gap-4 md:grid-cols-3">
          {LEAKS.map((l, i) => (
            <LeakCard key={l.leak} leak={l} i={i} />
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ proof --- */

export function Proof() {
  const { ref, play } = usePlay<HTMLDivElement>();
  return (
    <section className="bg-background pb-20 sm:pb-28" aria-labelledby="case">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Rise
          as="article"
          className="grid overflow-hidden rounded-[2rem] border border-success-border bg-success-soft lg:grid-cols-[1.1fr_0.9fr]"
        >
          <div className="p-7 sm:p-10 lg:p-12">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-success-soft-foreground">
              Live on AiDwar Growth · Hyderabad
            </p>
            <h2
              id="case"
              className="mt-3 text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl"
            >
              ZOORI Jewels
            </h2>
            <p className="mt-8 text-[4.5rem] font-extrabold leading-none tracking-[-0.05em] text-foreground sm:text-[6.5rem]">
              <CountUp to={1900} suffix="+" />
            </p>
            <p className="mt-3 text-lg font-medium text-foreground/80">
              customers reached in one Diwali campaign
            </p>
            <p className="mt-8 max-w-lg border-l-2 border-success pl-4 text-[17px] leading-relaxed text-foreground">
              Every invoice from their billing software now reaches the customer on WhatsApp —
              automatically.
            </p>
          </div>
          <div
            ref={ref}
            data-play={play}
            aria-hidden="true"
            className="relative grid min-h-[300px] place-items-center bg-[#06120e] p-8"
          >
            <div className="w-full max-w-[280px]">
              <div className="rounded-2xl rounded-tl-md bg-white p-3 text-[13px] text-[#111b21] shadow-xl">
                <p className="font-semibold">Your invoice is here 🧾</p>
                <span className="s73-anim s73-slide-in mt-2 flex items-center gap-2 rounded-xl border border-[#e5e7eb] bg-[#f8fafc] px-3 py-2 text-xs font-semibold">
                  <FileText className="h-4 w-4 text-red-600" />
                  Invoice-2291.pdf
                </span>
              </div>
              <p className="mt-6 text-center text-xs font-semibold text-white/80">
                + a copy to 7 staff numbers
              </p>
              <div className="mt-3 flex justify-center gap-1.5">
                {Array.from({ length: 7 }, (_, i) => (
                  <span
                    key={i}
                    className="s73-anim s73-staff grid h-8 w-8 place-items-center rounded-full bg-[var(--mint)] text-[10px] font-bold text-[#06120e]"
                    style={{ animationDelay: `${i * 0.22}s` }}
                  >
                    <Smartphone className="h-3.5 w-3.5" />
                  </span>
                ))}
              </div>
            </div>
          </div>
        </Rise>
      </div>
    </section>
  );
}

/* --------------------------------------------------------- timeline --- */

const HOW = [
  { icon: Smartphone, title: "Connect your number", note: "10 minutes, we guide you." },
  {
    icon: Upload,
    title: "Import customers",
    note: "A CSV from Excel or Google Sheets, +91 added for you.",
  },
  { icon: Send, title: "Send your first offer", note: "Or let Aiden start replying." },
];

export function HowItWorks() {
  const ref = useScrollProgress<HTMLOListElement>();
  return (
    <section className="bg-background pb-20 sm:pb-28" aria-labelledby="how">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <Rise>
          <h2
            id="how"
            className="text-[2rem] font-extrabold tracking-[-0.03em] text-foreground sm:text-[2.9rem]"
          >
            How it works
          </h2>
        </Rise>
        <ol ref={ref} className="relative mt-10 grid gap-10 md:grid-cols-3 md:gap-6">
          <span
            aria-hidden="true"
            className="absolute left-[23px] top-6 h-[calc(100%-3rem)] w-0.5 bg-border md:left-6 md:right-[calc(33.333%-2.5rem)] md:top-[23px] md:h-0.5 md:w-auto"
          />
          <span
            aria-hidden="true"
            className="s73-progress absolute left-[23px] top-6 h-[calc(100%-3rem)] w-0.5 bg-success md:left-6 md:right-[calc(33.333%-2.5rem)] md:top-[23px] md:h-0.5 md:w-auto"
          />
          {HOW.map((s, i) => (
            <Rise as="li" key={s.title} delay={i * 120} className="relative flex gap-4 md:block">
              <span className="relative grid h-12 w-12 shrink-0 place-items-center rounded-full border-2 border-success bg-background text-success">
                <s.icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="md:mt-5 md:block">
                <span className="block text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Step {i + 1}
                </span>
                <span className="mt-1 block text-lg font-bold text-foreground">{s.title}</span>
                <span className="mt-1 block text-[15px] text-muted-foreground">{s.note}</span>
              </span>
            </Rise>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- pricing --- */

export function PricingCard({ headline, onStart }: { headline: string; onStart: () => void }) {
  const { ref, play } = usePlay<HTMLDivElement>();
  return (
    <section className="bg-background px-4 pb-20 sm:px-6 sm:pb-28" aria-labelledby="price">
      <div ref={ref} data-play={play} className="s73-ring mx-auto max-w-3xl">
        <div className="s73-dark relative overflow-hidden rounded-[1.7rem] px-6 py-12 text-center sm:px-12 sm:py-16">
          <div aria-hidden="true" className="s73-aurora opacity-60">
            <i />
            <i />
            <i />
          </div>
          <div className="relative">
            <h2
              id="price"
              data-testid="start-pricing"
              className="text-[1.9rem] font-extrabold leading-tight tracking-[-0.03em] sm:text-[2.6rem]"
            >
              {headline}
            </h2>
            <p className="mx-auto mt-4 max-w-lg text-[17px] leading-relaxed text-white/75">
              {PRICING_SUB}
            </p>
            <button
              type="button"
              onClick={onStart}
              className="mt-8 inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[var(--mint)] px-7 text-base font-bold text-[#06120e] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-[var(--mint)]/40"
            >
              Start free trial →
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- FAQ --- */

function startFaq(pricing: string): { q: string; a: string }[] {
  return [
    {
      q: "Is this the official WhatsApp API?",
      a: "Yes. AiDwar uses Meta's official WhatsApp Business Platform, so your number stays safe and verified.",
    },
    {
      q: "Will my number get banned?",
      a: "Not when you message people who opted in, using approved templates — AiDwar guides you through both.",
    },
    {
      q: "Do I need a developer?",
      a: "No. You can be live in about 10 minutes. Developers get a full API if they want it.",
    },
    { q: "What does it cost?", a: pricing },
    {
      q: "Can Aiden reply in Hindi or Telugu?",
      a: "Yes. Aiden replies in the language the customer writes in — English, Hindi, Hinglish, Telugu and more.",
    },
  ];
}

export function Faq({ pricing }: { pricing: string }) {
  const id = useId();
  const [open, setOpen] = useState<number | null>(null);
  const items = startFaq(pricing);
  return (
    <section className="mx-auto max-w-3xl px-4 pb-20 sm:px-6 sm:pb-28" aria-labelledby="faq">
      <h2
        id="faq"
        className="text-[2rem] font-extrabold tracking-[-0.03em] text-foreground sm:text-[2.6rem]"
      >
        Questions
      </h2>
      <div className="mt-8 divide-y divide-border rounded-3xl border border-border bg-background">
        {items.map((item, i) => {
          const isOpen = open === i;
          return (
            <div key={item.q} className="px-5 sm:px-6">
              <h3>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-controls={`${id}-${i}`}
                  onClick={() => setOpen(isOpen ? null : i)}
                  className="flex min-h-14 w-full items-center justify-between gap-4 py-4 text-left text-base font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2"
                >
                  {item.q}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "s73-faq-icon grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-lg leading-none",
                      isOpen && "rotate-45",
                    )}
                  >
                    +
                  </span>
                </button>
              </h3>
              <div
                id={`${id}-${i}`}
                role="region"
                data-open={isOpen ? "true" : "false"}
                className="s73-faq-a"
              >
                <div inert={!isOpen}>
                  <p className="pb-5 text-[15px] leading-relaxed text-muted-foreground">{item.a}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------- final CTA --- */

export const FinalCta = forwardRef<HTMLFormElement>(function FinalCta(_props, formRef) {
  const { ref, play } = usePlay<HTMLElement>();
  return (
    <section
      ref={ref}
      data-play={play}
      className="s73-dark relative overflow-hidden px-4 py-20 sm:px-6 sm:py-28"
      aria-labelledby="final"
    >
      <div aria-hidden="true" className="s73-aurora">
        <i />
        <i />
        <i />
      </div>
      <div aria-hidden="true" className="s73-grid" />
      <div className="relative mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
        <h2
          id="final"
          className="text-[2.3rem] font-extrabold leading-[1.04] tracking-[-0.035em] sm:text-[3.4rem]"
        >
          Your customers are already on WhatsApp.{" "}
          <span className="text-[var(--mint)]">Be there when they message.</span>
        </h2>
        <div className="rounded-2xl bg-background p-5 text-foreground shadow-[0_30px_80px_-30px_rgba(16,185,129,0.45)] ring-1 ring-white/10 sm:p-6">
          <StartLeadForm ref={formRef} variant="final" />
        </div>
      </div>
    </section>
  );
});
