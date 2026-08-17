import { createFileRoute } from "@tanstack/react-router";
import {
  PenLine,
  MessagesSquare,
  ShieldCheck,
  Target,
  Inbox,
  LineChart,
  ArrowRight,
  ArrowDown,
  Sunrise,
  Send,
  Languages,
  UserCheck,
  BarChart3,
  Lock,
  MapPin,
  Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { WaitlistDialog } from "@/components/waitlist-dialog";
import { PhoneDemo } from "@/components/marketing/phone-demo";
import { Reveal } from "@/components/marketing/reveal";

const TITLE = "AiDwar — Your AI Marketing Employee for WhatsApp";
const DESCRIPTION =
  "AiDwar plans campaigns, writes messages, replies to customers and reports revenue on the official WhatsApp Business API. You approve, it executes.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://ai-dwar-communique.lovable.app/" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://ai-dwar-communique.lovable.app/" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "AiDwar",
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web",
          url: "https://ai-dwar-communique.lovable.app/",
          description: DESCRIPTION,
          publisher: {
            "@type": "Organization",
            name: "Meezoy Ventures Private Limited",
            url: "https://ai-dwar-communique.lovable.app/",
          },
        }),
      },
    ],
  }),
  component: Index,
});


const day = [
  {
    time: "9:00 AM",
    icon: Sunrise,
    title: "Drafts your Diwali campaign",
    body: "Reads last season's winners and writes three ready-to-approve message variants before your first chai.",
  },
  {
    time: "11:00 AM",
    icon: Send,
    title: "Sends to 2,400 opted-in customers",
    body: "Segments the list, schedules for peak reply hours and pushes approved templates through the official API.",
  },
  {
    time: "All day",
    icon: Languages,
    title: "Answers and qualifies in Hinglish",
    body: "Handles sizes, prices, stock and delivery questions in the language your customers actually type in.",
  },
  {
    time: "6:00 PM",
    icon: UserCheck,
    title: "Hands hot leads to your team",
    body: "Buying-intent chats land in the shared inbox with full context, so a human closes at the right moment.",
  },
  {
    time: "9:00 PM",
    icon: BarChart3,
    title: "Reports what sold",
    body: "A clean end-of-day summary: messages delivered, replies handled and revenue attributed per campaign.",
  },
];

const capabilities = [
  {
    icon: PenLine,
    title: "Writes your campaigns",
    body: "An AI copywriter that drafts offers, follow-ups and reminders in Hinglish and 10+ Indian languages.",
  },
  {
    icon: MessagesSquare,
    title: "Talks to every customer",
    body: "An AI agent trained on your catalogue, pricing and policies — replying in seconds, day or night.",
  },
  {
    icon: ShieldCheck,
    title: "Never sends spam",
    body: "A compliance predictor flags risky copy and unconsented audiences before they can hurt your number.",
  },
  {
    icon: Target,
    title: "Knows who to message",
    body: "Smart segments built from behaviour, purchase history and attributes — no spreadsheet gymnastics.",
  },
  {
    icon: Inbox,
    title: "Closes the loop",
    body: "A shared team inbox where humans take over with assignments, notes and full conversation history.",
  },
  {
    icon: LineChart,
    title: "Shows you the money",
    body: "Revenue analytics per campaign, segment and conversation — so you double down on what converts.",
  },
];

const trust = [
  { icon: ShieldCheck, label: "Official WhatsApp Business Platform" },
  { icon: Lock, label: "Your data stays yours, hosted in India" },
  { icon: Building2, label: "Built by Meezoy Ventures" },
];

const soon = ["AI voice calls", "In-chat payments", "WhatsApp Flows"];

function Index() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-x-0 -top-48 h-[34rem] bg-[radial-gradient(ellipse_at_top,color-mix(in_oklab,var(--primary)_20%,transparent),transparent_65%)]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-14 px-5 pt-16 pb-20 sm:px-8 sm:pt-24 lg:grid-cols-[1.05fr_1fr] lg:gap-8 lg:pb-28">
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-4 py-1.5 text-xs font-medium text-primary">
                Not a tool — an AI employee
              </span>
              <h1 className="mt-6 max-w-xl text-4xl font-extrabold leading-[1.08] tracking-tight text-foreground sm:text-5xl lg:text-[3.4rem]">
                Meet your new marketing employee.{" "}
                <span className="bg-gradient-to-r from-primary to-teal-500 bg-clip-text text-transparent">
                  It works on WhatsApp.
                </span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                AiDwar plans campaigns, writes messages, replies to customers and reports revenue —
                on the official WhatsApp Business API. You approve, it executes.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
                <WaitlistDialog
                  trigger={
                    <Button
                      size="lg"
                      className="w-full rounded-full bg-gradient-to-r from-primary to-teal-500 px-8 transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99] sm:w-auto"
                    >
                      Get Early Access
                      <ArrowRight className="size-4" />
                    </Button>
                  }
                />
                <a
                  href="#a-days-work"
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border px-6 text-sm font-medium text-foreground transition-colors duration-200 hover:bg-secondary"
                >
                  See it work
                  <ArrowDown className="size-4 animate-bounce" />
                </a>
              </div>
            </Reveal>

            <Reveal delay={120} className="lg:pl-6">
              <PhoneDemo />
            </Reveal>
          </div>
        </section>

        {/* A day's work */}
        <section id="a-days-work" className="border-t border-border bg-secondary/30">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
            <Reveal>
              <p className="text-sm font-semibold text-primary">A day&apos;s work</p>
              <h2 className="mt-2 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
                What your AI employee gets done between chai and dinner
              </h2>
            </Reveal>

            <div className="relative mt-14">
              <div className="pointer-events-none absolute left-6 top-0 hidden h-px w-full bg-gradient-to-r from-primary via-teal-500/60 to-transparent lg:block lg:top-6" />
              <ol className="grid gap-8 sm:grid-cols-2 lg:grid-cols-5 lg:gap-5">
                {day.map((step, i) => (
                  <Reveal key={step.title} delay={i * 90}>
                    <li className="group relative h-full rounded-2xl border border-border bg-card p-6 transition-all duration-200 hover:-translate-y-1 hover:shadow-[var(--shadow-card)]">
                      <div className="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-teal-500 text-primary-foreground transition-transform duration-200 group-hover:scale-105">
                        <step.icon className="size-5" />
                      </div>
                      <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-primary">
                        {step.time}
                      </p>
                      <h3 className="mt-1.5 text-base font-semibold text-card-foreground">
                        {step.title}
                      </h3>
                      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                        {step.body}
                      </p>
                    </li>
                  </Reveal>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
            <Reveal>
              <p className="text-sm font-semibold text-primary">The job description</p>
              <h2 className="mt-2 max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
                Everything it does, so your team doesn&apos;t have to
              </h2>
            </Reveal>
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {capabilities.map((c, i) => (
                <Reveal key={c.title} delay={i * 70}>
                  <div className="group h-full rounded-2xl border border-border bg-card p-7 transition-all duration-200 hover:-translate-y-1 hover:border-primary/30 hover:shadow-[var(--shadow-card)]">
                    <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary transition-all duration-200 group-hover:bg-gradient-to-br group-hover:from-primary group-hover:to-teal-500 group-hover:text-primary-foreground">
                      <c.icon className="size-5" />
                    </div>
                    <h3 className="mt-5 text-base font-semibold text-card-foreground">{c.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Trust */}
        <section className="border-t border-border bg-secondary/30">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-5 py-14 sm:flex-row sm:justify-center sm:gap-12 sm:px-8">
            {trust.map((item, i) => (
              <Reveal key={item.label} delay={i * 90}>
                <div className="flex items-center gap-2.5 text-sm font-medium">
                  <item.icon className="size-4 text-primary" />
                  {item.label}
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <Reveal>
              <div className="relative overflow-hidden rounded-3xl bg-gradient-to-br from-primary via-emerald-500 to-teal-600 px-6 py-16 text-center sm:px-12">
                <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:radial-gradient(color-mix(in_oklab,white_60%,transparent)_1px,transparent_1px)] [background-size:22px_22px]" />
                <div className="relative">
                  <h2 className="mx-auto max-w-2xl text-3xl font-extrabold tracking-tight text-primary-foreground sm:text-4xl">
                    Hire your AI employee before your competitor does.
                  </h2>
                  <p className="mx-auto mt-4 max-w-xl text-primary-foreground/90">
                    Early access is limited. Join the list and we&apos;ll onboard you personally.
                  </p>
                  <div className="mt-8 flex justify-center">
                    <WaitlistDialog
                      trigger={
                        <Button
                          size="lg"
                          variant="secondary"
                          className="rounded-full px-8 transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99]"
                        >
                          Get Early Access
                          <ArrowRight className="size-4" />
                        </Button>
                      }
                    />
                  </div>
                  <div className="mt-10 flex flex-wrap items-center justify-center gap-2.5">
                    {soon.map((s) => (
                      <span
                        key={s}
                        className="rounded-full border border-primary-foreground/30 bg-primary-foreground/10 px-4 py-1.5 text-xs font-medium text-primary-foreground backdrop-blur"
                      >
                        Coming soon · {s}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
