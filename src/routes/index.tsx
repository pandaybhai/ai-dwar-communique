import { createFileRoute } from "@tanstack/react-router";
import {
  Sparkles,
  Send,
  Inbox,
  Bot,
  Users,
  BarChart3,
  ShieldCheck,
  Lock,
  MapPin,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { WaitlistDialog } from "@/components/waitlist-dialog";

const TITLE = "AiDwar — AI-Powered WhatsApp Marketing Platform";
const DESCRIPTION =
  "AiDwar turns WhatsApp into your #1 revenue channel with AI campaigns, broadcasts, a shared team inbox and an AI sales agent. Built on the official WhatsApp Business Platform.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
    ],
  }),
  component: Index,
});

const features = [
  {
    icon: Sparkles,
    title: "AI Campaign Creator",
    body: "Describe your offer in a line and get ready-to-send campaign copy, variants and message templates. No copywriter, no blank page.",
  },
  {
    icon: Send,
    title: "Smart Broadcasts & Scheduling",
    body: "Send personalised broadcasts to thousands of contacts and schedule them for the moment your audience actually replies.",
  },
  {
    icon: Inbox,
    title: "Shared Team Inbox",
    body: "Your whole team answers from one number with assignments, notes and labels. Nothing slips through the cracks.",
  },
  {
    icon: Bot,
    title: "AI Sales Agent",
    body: "An AI agent that answers questions, qualifies leads and books orders around the clock — and hands over to a human when it matters.",
  },
  {
    icon: Users,
    title: "Contact Segmentation",
    body: "Group contacts by behaviour, purchase history and custom attributes so every message lands with the right people.",
  },
  {
    icon: BarChart3,
    title: "Campaign Analytics",
    body: "Track delivery, reads, replies and revenue per campaign, then double down on what converts.",
  },
];

const steps = [
  {
    title: "Connect your WhatsApp Business account",
    body: "Onboard in minutes on the official WhatsApp Business Platform — verified number, approved templates, no workarounds.",
  },
  {
    title: "Import contacts & build campaigns with AI",
    body: "Upload your opted-in contact lists, segment them and let AiDwar draft campaigns tuned to each audience.",
  },
  {
    title: "Convert conversations into customers",
    body: "Your team and the AI agent handle replies together, turning every chat into a measurable sale.",
  },
];

const trust = [
  { icon: ShieldCheck, label: "Official WhatsApp Business Platform" },
  { icon: Lock, label: "Your data stays yours" },
  { icon: MapPin, label: "Made in India" },
];

function Index() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-x-0 -top-40 h-[28rem] bg-[radial-gradient(ellipse_at_top,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_65%)]" />
          <div className="relative mx-auto max-w-6xl px-5 pt-20 pb-16 text-center sm:px-8 sm:pt-28 sm:pb-24">
            <span className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-4 py-1.5 text-xs font-medium text-primary">
              Built on the official WhatsApp Business API
            </span>
            <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-bold tracking-tight text-foreground sm:text-6xl sm:leading-[1.05]">
              Turn WhatsApp into your <span className="text-primary">#1 revenue channel</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground sm:text-lg">
              AiDwar is the AI-powered marketing platform for WhatsApp — broadcasts, automations,
              shared team inbox, and an AI agent that sells while you sleep. Built on the official
              WhatsApp Business API.
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <WaitlistDialog
                trigger={
                  <Button size="lg" className="w-full rounded-full px-8 sm:w-auto">
                    Get Early Access
                    <ArrowRight className="size-4" />
                  </Button>
                }
              />
              <a
                href="#features"
                className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                See what's inside
              </a>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="border-t border-border bg-secondary/30">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold text-primary">Platform</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
                Everything you need to sell on WhatsApp
              </h2>
            </div>
            <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {features.map((feature) => (
                <div
                  key={feature.title}
                  className="rounded-2xl border border-border bg-card p-7 transition-shadow hover:shadow-[var(--shadow-card)]"
                >
                  <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <feature.icon className="size-5" />
                  </div>
                  <h3 className="mt-5 text-base font-semibold text-card-foreground">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {feature.body}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold text-primary">How it works</p>
              <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
                Live in three steps
              </h2>
            </div>
            <ol className="mt-12 grid gap-8 md:grid-cols-3">
              {steps.map((step, i) => (
                <li key={step.title} className="relative pl-14 md:pl-0">
                  <div className="absolute left-0 top-0 flex size-10 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground md:static md:mb-5">
                    {i + 1}
                  </div>
                  <h3 className="text-base font-semibold text-foreground">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Trust */}
        <section className="border-t border-border bg-secondary/30">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-5 py-14 sm:flex-row sm:justify-center sm:gap-12 sm:px-8">
            {trust.map((item) => (
              <div key={item.label} className="flex items-center gap-2.5 text-sm font-medium">
                <item.icon className="size-4 text-primary" />
                {item.label}
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-20 text-center sm:px-8 sm:py-24">
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Ready to grow on WhatsApp?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
              Join the early access list and be among the first businesses running AI-powered
              campaigns with AiDwar.
            </p>
            <div className="mt-8 flex justify-center">
              <WaitlistDialog
                trigger={
                  <Button size="lg" className="rounded-full px-8">
                    Get Early Access
                  </Button>
                }
              />
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
