import { useRef } from "react";
import { Link } from "@tanstack/react-router";
import {
  Bot,
  Code2,
  Inbox,
  Megaphone,
  Sparkles,
  Workflow,
  BellOff,
  MoonStar,
  UserX,
} from "lucide-react";
import { PhoneChat } from "@/components/start/phone-chat";
import { StartLeadForm } from "@/components/start/start-lead-form";
import { StartStickyBar } from "@/components/start/start-sticky-bar";
import { CountUp, Rise } from "@/components/start/start-motion";
import { pricingTeaser, type StartPlan } from "@/lib/start-page";

/**
 * Batch 72: /start — the Meta-ads landing page. One job: a WhatsApp number in
 * the form. No site navigation and no link farm: the logo is not a link, the
 * footer is Privacy · Terms · ©. Brand tokens and the site's own font.
 */

const LOGOS: { name: string; className: string }[] = [
  {
    name: "ZOORI Jewels",
    className: "font-serif text-lg font-semibold tracking-[0.18em] uppercase",
  },
  { name: "TalentDwar", className: "text-lg font-extrabold tracking-tight" },
  { name: "Meezoy", className: "text-lg font-bold italic tracking-wide" },
  { name: "Fanzart", className: "font-mono text-base font-semibold tracking-[0.12em] lowercase" },
];

const LEAKS = [
  {
    icon: BellOff,
    leak: "Your broadcasts get ignored or blocked.",
    fix: "Send approved template messages with images, buttons and offers — straight to their chat, not their spam folder.",
  },
  {
    icon: MoonStar,
    leak: "Customers message at 11pm. Nobody replies.",
    fix: "Aiden, your AI assistant, answers from your own products and prices in seconds — and hands over to you when it should.",
  },
  {
    icon: UserX,
    leak: "Buyers come once and never return.",
    fix: "Automatic welcome flows, loyalty cards and follow-ups bring them back without you lifting a finger.",
  },
];

const STEPS = [
  { title: "Connect your WhatsApp number", note: "10 min, guided" },
  { title: "Import your customers", note: "Excel/CSV, we add +91 for you" },
  { title: "Send your first campaign", note: "or let Aiden reply for you" },
];

const FEATURES = [
  { icon: Megaphone, title: "Campaigns" },
  { icon: Bot, title: "AI replies (Aiden)" },
  { icon: Workflow, title: "Flows & automations" },
  { icon: Inbox, title: "Shared team inbox" },
  { icon: Code2, title: "Shopify & API" },
  { icon: Sparkles, title: "Works with Claude/ChatGPT via MCP" },
];

function Faq({ pricing }: { pricing: string }) {
  const items = [
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
  ];
  return (
    <div className="divide-y divide-border rounded-2xl border border-border bg-background">
      {items.map((item) => (
        <details key={item.q} className="group px-5 [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 py-4 text-base font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success focus-visible:ring-offset-2">
            {item.q}
            <span
              aria-hidden="true"
              className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-muted text-lg leading-none transition-transform group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <p className="pb-5 text-[15px] leading-relaxed text-muted-foreground">{item.a}</p>
        </details>
      ))}
    </div>
  );
}

export function StartPage({
  plans,
  gstRegistered,
}: {
  plans: StartPlan[];
  gstRegistered: boolean;
}) {
  const heroForm = useRef<HTMLFormElement | null>(null);
  const finalForm = useRef<HTMLFormElement | null>(null);
  const pricing = pricingTeaser(plans, gstRegistered);
  const toForm = () => {
    heroForm.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    heroForm.current
      ?.querySelector<HTMLInputElement>("input[name=name]")
      ?.focus({ preventScroll: true });
  };

  return (
    <div className="min-h-screen overflow-x-clip bg-background text-foreground antialiased">
      {/* Hero */}
      <header className="relative overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(60% 45% at 85% 10%, color-mix(in oklab, var(--success) 22%, transparent), transparent 70%), radial-gradient(50% 40% at 0% 35%, color-mix(in oklab, var(--primary) 16%, transparent), transparent 70%)",
          }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-[0.05] mix-blend-multiply"
          style={{
            backgroundImage:
              "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
          }}
        />
        <div className="relative mx-auto max-w-6xl px-4 pb-14 pt-5 sm:px-6 lg:pb-24">
          <div className="flex items-center justify-between">
            <span
              className="text-xl font-extrabold tracking-tight text-foreground"
              aria-label="AiDwar"
            >
              Ai<span className="text-success">Dwar</span>
            </span>
          </div>

          <div className="mt-8 grid items-center gap-12 lg:mt-14 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-success-border bg-success-soft px-3 py-1.5 text-xs font-semibold text-success-soft-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                Official WhatsApp Business API · Made in Hyderabad
              </p>
              <h1 className="mt-5 text-[2.5rem] font-extrabold leading-[1.04] tracking-[-0.035em] text-foreground sm:text-[3.25rem] lg:text-[4rem]">
                Your customers read WhatsApp. <span className="text-success">Not your emails.</span>
              </h1>
              <p className="mt-5 max-w-xl text-[17px] leading-relaxed text-muted-foreground sm:text-lg">
                Send offers that get opened, let AI reply to every customer 24×7, and win back
                buyers who went quiet — all from your own WhatsApp number.
              </p>
              <div className="mt-7 max-w-md rounded-2xl border border-border bg-background/80 p-4 shadow-[0_24px_60px_-34px_rgba(6,40,28,0.45)] backdrop-blur sm:p-5">
                <StartLeadForm ref={heroForm} variant="hero" />
              </div>
            </div>
            <div className="lg:pl-6">
              <PhoneChat />
            </div>
          </div>
        </div>
      </header>

      <main>
        {/* Logo strip */}
        <section className="border-y border-border bg-muted/40 py-8" aria-labelledby="logos">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2
              id="logos"
              className="text-center text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground"
            >
              Businesses already growing on AiDwar
            </h2>
            <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-foreground/75">
              {LOGOS.map((l) => (
                <li key={l.name} className={l.className}>
                  {l.name}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Numbers */}
        <section className="mx-auto max-w-6xl px-4 py-14 sm:px-6" aria-label="AiDwar in numbers">
          <dl className="grid gap-8 text-center sm:grid-cols-3">
            <Rise>
              <dt className="sr-only">Time to go live</dt>
              <dd>
                <span className="block text-5xl font-extrabold tracking-tight text-foreground">
                  <CountUp to={10} /> min
                </span>
                <span className="mt-2 block text-base text-muted-foreground">to go live</span>
              </dd>
            </Rise>
            <Rise delay={80}>
              <dt className="sr-only">AI replies</dt>
              <dd>
                <span className="block text-5xl font-extrabold tracking-tight text-foreground">
                  24×7
                </span>
                <span className="mt-2 block text-base text-muted-foreground">AI replies</span>
              </dd>
            </Rise>
            <Rise delay={160}>
              <dt className="sr-only">Reach of one campaign</dt>
              <dd>
                <span className="block text-5xl font-extrabold tracking-tight text-foreground">
                  <CountUp to={1900} suffix="+" />
                </span>
                <span className="mt-2 block text-base text-muted-foreground">
                  customers reached in one Diwali campaign
                </span>
              </dd>
            </Rise>
          </dl>
        </section>

        {/* Three leaks */}
        <section className="bg-[#07130e] py-16 text-white sm:py-24" aria-labelledby="leaks">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <Rise>
              <h2
                id="leaks"
                className="max-w-2xl text-3xl font-extrabold leading-tight tracking-[-0.02em] sm:text-[2.6rem]"
              >
                Three leaks costing you sales — fixed
              </h2>
            </Rise>
            <div className="mt-10 grid gap-4 md:grid-cols-3">
              {LEAKS.map((l, i) => (
                <Rise key={l.leak} delay={i * 80}>
                  <article className="h-full rounded-2xl border border-white/10 bg-white/[0.04] p-6">
                    <l.icon className="h-6 w-6 text-[#4ade80]" aria-hidden="true" />
                    <h3 className="mt-4 text-lg font-bold leading-snug">{l.leak}</h3>
                    <p className="mt-3 text-[15px] leading-relaxed text-white/75">{l.fix}</p>
                  </article>
                </Rise>
              ))}
            </div>
          </div>
        </section>

        {/* Case study */}
        <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24" aria-labelledby="case">
          <Rise>
            <article className="relative overflow-hidden rounded-3xl border border-success-border bg-success-soft p-7 sm:p-10">
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-success-soft-foreground">
                Live on AiDwar Growth
              </p>
              <h2
                id="case"
                className="mt-3 text-2xl font-extrabold tracking-tight text-foreground sm:text-3xl"
              >
                ZOORI Jewels, Hyderabad
              </h2>
              <p className="mt-4 max-w-3xl text-[17px] leading-relaxed text-foreground/85">
                Sent their Diwali offer to 1,900+ customers from one dashboard. Every invoice from
                their billing software now reaches the customer on WhatsApp as a PDF — with a copy
                to 7 staff numbers — automatically.
              </p>
            </article>
          </Rise>
        </section>

        {/* How it works */}
        <section className="mx-auto max-w-6xl px-4 pb-16 sm:px-6 sm:pb-24" aria-labelledby="how">
          <Rise>
            <h2
              id="how"
              className="text-3xl font-extrabold tracking-[-0.02em] text-foreground sm:text-[2.6rem]"
            >
              How it works
            </h2>
          </Rise>
          <ol className="mt-8 grid gap-4 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <Rise delay={i * 80} className="h-full rounded-2xl border border-border p-6">
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-success text-sm font-bold text-success-foreground">
                    {i + 1}
                  </span>
                  <h3 className="mt-4 text-lg font-bold text-foreground">{s.title}</h3>
                  <p className="mt-1 text-[15px] text-muted-foreground">{s.note}</p>
                </Rise>
              </li>
            ))}
          </ol>
        </section>

        {/* Features */}
        <section className="bg-muted/40 py-16 sm:py-24" aria-labelledby="features">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <Rise>
              <h2
                id="features"
                className="text-3xl font-extrabold tracking-[-0.02em] text-foreground sm:text-[2.6rem]"
              >
                Everything on one WhatsApp number
              </h2>
            </Rise>
            <ul className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3">
              {FEATURES.map((f, i) => (
                <li key={f.title}>
                  <Rise
                    delay={(i % 3) * 60}
                    className="flex h-full items-center gap-3 rounded-2xl border border-border bg-background p-4 sm:p-5"
                  >
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-success-soft text-success-soft-foreground">
                      <f.icon className="h-5 w-5" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 text-[15px] font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
                      {f.title}
                    </span>
                  </Rise>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* Pricing teaser */}
        <section
          className="mx-auto max-w-6xl px-4 py-16 text-center sm:px-6 sm:py-24"
          aria-labelledby="price"
        >
          <Rise>
            <h2
              id="price"
              className="mx-auto max-w-3xl text-2xl font-extrabold leading-snug tracking-tight text-foreground sm:text-3xl"
              data-testid="start-pricing"
            >
              {pricing}
            </h2>
            <button
              type="button"
              onClick={toForm}
              className="mt-7 inline-flex min-h-12 items-center justify-center rounded-xl bg-success px-6 text-base font-bold text-success-foreground transition hover:bg-success/90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-success/30"
            >
              Start free trial
            </button>
          </Rise>
        </section>

        {/* FAQ */}
        <section className="mx-auto max-w-3xl px-4 pb-16 sm:px-6 sm:pb-24" aria-labelledby="faq">
          <h2 id="faq" className="text-3xl font-extrabold tracking-[-0.02em] text-foreground">
            Questions
          </h2>
          <div className="mt-6">
            <Faq pricing={pricing} />
          </div>
        </section>

        {/* Final CTA */}
        <section
          className="bg-[#07130e] px-4 py-16 text-white sm:px-6 sm:py-24"
          aria-labelledby="final"
        >
          <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-2">
            <h2
              id="final"
              className="text-3xl font-extrabold leading-tight tracking-[-0.02em] sm:text-[2.75rem]"
            >
              Your next sale is already in your customers&apos; WhatsApp.
            </h2>
            <div className="rounded-2xl bg-background p-5 text-foreground sm:p-6">
              <StartLeadForm ref={finalForm} variant="final" />
            </div>
          </div>
        </section>
      </main>

      <footer className="px-4 pb-28 pt-8 text-center text-sm text-muted-foreground md:pb-8">
        <Link to="/privacy" className="underline-offset-2 hover:underline">
          Privacy
        </Link>
        {" · "}
        <Link to="/terms" className="underline-offset-2 hover:underline">
          Terms
        </Link>
        {" · "}© Meezoy Ventures Pvt Ltd
      </footer>

      <StartStickyBar heroForm={heroForm} finalForm={finalForm} />
    </div>
  );
}
