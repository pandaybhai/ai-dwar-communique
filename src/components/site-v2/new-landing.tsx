import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/reveal";
import { ProductProof, type ProofAudience } from "@/components/marketing/product-proof";
import { DemoForm } from "@/components/marketing/demo-form";
import {
  AUDIENCE_BENEFITS,
  CAPABILITIES,
  FAQS,
  STEPS,
} from "@/components/marketing/landing-copy";
import { trackMarketing } from "@/lib/marketing-analytics";
import { useSitePreviewSearch } from "@/lib/new-site";
import type { PublicPlan } from "@/lib/public-plans.functions";
import { cn } from "@/lib/utils";
import { AidenChatDemo, CampaignDemo, CampaignPhone, InboxDemo } from "./demos";
import { NewSiteShell } from "./site-shell";

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

const WRAP = "mx-auto w-full max-w-[1200px] px-[max(16px,env(safe-area-inset-left))]";
const H2 =
  "m-0 max-w-2xl font-display text-[clamp(1.75rem,3.4vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.025em]";

/**
 * Batch 50: the landing page in the new design (switch new_site). Same words
 * as the current landing (landing-copy.ts), same demo form and same plans
 * read; the product is shown with the design's own pieces: Aiden answering a
 * customer, the shared Inbox, a campaign's results.
 */
export function NewLanding({ plans }: { plans: PublicPlan[] }) {
  const [audience, setAudience] = useState<ProofAudience>("retail");
  const [formVisible, setFormVisible] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);
  const preview = useSitePreviewSearch();

  useEffect(() => {
    const node = formRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setFormVisible(!!entry?.isIntersecting), {
      threshold: 0.12,
    });
    io.observe(node);
    return () => io.disconnect();
  }, []);

  return (
    <NewSiteShell>
      {/* Hero: the promise on the left, Aiden at work on the right. */}
      <section className={cn(WRAP, "grid items-center gap-12 pb-16 pt-12 sm:pt-16 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:pb-24")}>
        <div className="flex min-w-0 flex-col gap-6">
          <span className="inline-flex w-fit items-center rounded-full bg-aiden-soft px-3.5 py-1.5 text-sm font-semibold text-aiden-deep">
            Built on the official WhatsApp Business Platform
          </span>
          <h1 className="m-0 font-display text-[clamp(2.25rem,5.2vw,4rem)] font-extrabold leading-[1.02] tracking-[-0.035em] [text-wrap:balance]">
            Your AI employee. <span className="text-aiden-deep">Inside every customer chat.</span>
          </h1>
          <p className="m-0 max-w-[44ch] text-[1.0625rem] text-muted-foreground">
            It reads your website and catalogue, answers customers in their own language within
            seconds, and brings you in the moment it is unsure. Nights, Sundays, festival rush.
          </p>
          <ul className="m-0 grid list-none gap-2.5 p-0 sm:grid-cols-2">
            {[
              "Trained on your own material",
              "Replies in Hindi, Hinglish & more",
              "Hands over to you when unsure",
              "Draft-only mode until you trust it",
            ].map((point) => (
              <li key={point} className="flex items-start gap-2">
                <Check className="mt-1 size-4 shrink-0 text-aiden-deep" aria-hidden="true" />
                <span>{point}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button size="lg" className="h-12 px-6 text-base" onClick={() => scrollToId("demo")}>
              Book a personalised demo
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
            <Button asChild size="lg" variant="outline" className="h-12 px-6 text-base">
              <Link
                to="/signup"
                search={preview as never}
                onClick={() => trackMarketing("signup_link_clicked", { placement: "hero" })}
              >
                Start free
              </Link>
            </Button>
          </div>
          <p className="m-0 text-sm text-muted-foreground">
            <button
              type="button"
              onClick={() => scrollToId("proof")}
              className="font-semibold text-aiden-deep underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
            >
              See it answer a question
            </button>{" "}
            or{" "}
            <Link
              to="/pricing"
              search={preview as never}
              className="font-semibold text-aiden-deep underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
            >
              see pricing
            </Link>
          </p>
        </div>
        <AidenChatDemo />
      </section>

      {/* The product, as you will use it. */}
      <section className="border-t border-border bg-surface">
        <div className={cn(WRAP, "flex flex-col gap-16 py-20 sm:py-24")}>
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)]">
            <Reveal className="flex flex-col gap-4">
              <h2 className={H2}>It asks you. Everything else, it handles.</h2>
              <p className="m-0 max-w-[46ch] text-[1.0625rem] text-muted-foreground">
                {CAPABILITIES[2]!.body} One shared inbox, so your team can see who is handling
                which chat.
              </p>
            </Reveal>
            <Reveal delay={100}>
              <InboxDemo />
            </Reveal>
          </div>
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,4fr)]">
            <Reveal className="order-2 lg:order-1">
              <div className="grid items-center gap-8 md:grid-cols-[minmax(0,1fr)_auto]">
                <CampaignDemo />
                <div className="hidden justify-center md:flex">
                  <CampaignPhone />
                </div>
              </div>
            </Reveal>
            <Reveal delay={100} className="order-1 flex flex-col gap-4 lg:order-2">
              <h2 className={H2}>Campaigns that show what they did.</h2>
              <p className="m-0 max-w-[46ch] text-[1.0625rem] text-muted-foreground">
                Send an approved template to the customers you choose, then see how many got it,
                read it and replied, what it cost, and the sales that came from the replies.
              </p>
            </Reveal>
          </div>
          <p className="m-0 text-center text-sm text-muted-foreground">
            Examples with a sample shop.
          </p>
        </div>
      </section>

      {/* Understands, replies, asks you. */}
      <section className="border-t border-border">
        <div className={cn(WRAP, "grid gap-10 py-20 sm:py-24 lg:grid-cols-3 lg:gap-14")}>
          {CAPABILITIES.map((c, i) => (
            <Reveal key={c.title} delay={i * 80} className="flex flex-col gap-3">
              <span className="grid size-11 place-items-center rounded-[14px] bg-aiden-soft text-aiden-deep">
                <c.icon className="size-5" aria-hidden="true" />
              </span>
              <h2 className="m-0 font-display text-2xl font-semibold">{c.title}</h2>
              <p className="m-0 text-muted-foreground">{c.body}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* The written walkthrough, per kind of business. */}
      <section id="proof" className="scroll-mt-20 border-t border-border bg-surface">
        <div className={cn(WRAP, "py-20 sm:py-24")}>
          <Reveal>
            <ProductProof audience={audience} onAudienceChange={setAudience} />
          </Reveal>
        </div>
      </section>

      <section className="border-t border-border">
        <div className={cn(WRAP, "py-20 sm:py-24")}>
          <Reveal>
            <h2 className={H2}>What it changes, depending on what you run</h2>
          </Reveal>
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            {(Object.keys(AUDIENCE_BENEFITS) as ProofAudience[]).map((key, i) => {
              const b = AUDIENCE_BENEFITS[key];
              const active = key === audience;
              return (
                <Reveal key={key} delay={i * 80} className="h-full">
                  <button
                    type="button"
                    onClick={() => {
                      setAudience(key);
                      scrollToId("proof");
                    }}
                    aria-pressed={active}
                    className={cn(
                      "flex h-full w-full flex-col gap-3 rounded-[20px] border bg-surface p-7 text-left transition-[box-shadow,border-color] duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden",
                      active ? "border-aiden shadow-lg" : "border-border shadow-md hover:shadow-lg",
                    )}
                  >
                    <b.icon className="size-5 text-aiden-deep" aria-hidden="true" />
                    <h3 className="m-0 font-display text-xl font-semibold">{b.title}</h3>
                    <ul className="m-0 flex list-none flex-col gap-2 p-0 text-muted-foreground">
                      {b.points.map((p) => (
                        <li key={p} className="flex gap-2">
                          <Check className="mt-1 size-4 shrink-0 text-aiden-deep" aria-hidden="true" />
                          {p}
                        </li>
                      ))}
                    </ul>
                    <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm font-semibold text-aiden-deep">
                      See an example <ArrowRight className="size-3.5" aria-hidden="true" />
                    </span>
                  </button>
                </Reveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* Setup */}
      <section className="border-t border-border bg-surface">
        <div className={cn(WRAP, "py-20 sm:py-24")}>
          <Reveal>
            <h2 className={H2}>Getting it working</h2>
          </Reveal>
          <ol className="m-0 mt-10 grid list-none gap-x-10 gap-y-8 p-0 sm:grid-cols-2">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <Reveal delay={i * 70} className="flex gap-4">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full bg-ink font-display font-semibold text-ink-foreground">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="m-0 text-lg font-semibold">{s.title}</h3>
                    <p className="m-0 mt-1.5 text-muted-foreground">{s.body}</p>
                  </div>
                </Reveal>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <PlansStrip plans={plans} preview={preview} />

      {/* FAQs */}
      <section className="border-t border-border bg-surface">
        <div className="mx-auto w-full max-w-3xl px-[max(16px,env(safe-area-inset-left))] py-20 sm:py-24">
          <Reveal>
            <h2 className={H2}>Straight answers</h2>
          </Reveal>
          <dl className="m-0 mt-10 divide-y divide-border border-y border-border">
            {FAQS.map((f, i) => (
              <Reveal key={f.q} delay={i * 50} className="py-6">
                <dt className="text-lg font-semibold">{f.q}</dt>
                <dd className="m-0 mt-2 text-muted-foreground">{f.a}</dd>
              </Reveal>
            ))}
          </dl>
        </div>
      </section>

      {/* Demo form */}
      <section id="demo" className="scroll-mt-20 border-t border-border">
        <div
          ref={formRef}
          className={cn(WRAP, "grid gap-10 py-20 sm:py-24 lg:grid-cols-[1fr_1.1fr] lg:gap-16")}
        >
          <Reveal className="flex flex-col gap-5">
            <h2 className={H2}>See how AiDwar would handle your customer questions.</h2>
            <p className="m-0 max-w-md text-muted-foreground">
              A short, personalised walkthrough with someone from our team — built around your own
              business, not a generic deck.
            </p>
            <ul className="m-0 flex list-none flex-col gap-3 p-0 text-muted-foreground">
              {[
                "We show it answering questions built around your own catalogue or website",
                "We show what happens when it doesn't know — how it hands over to you",
                "We talk honestly about whether AiDwar fits how you work",
              ].map((p) => (
                <li key={p} className="flex gap-3">
                  <Check className="mt-1 size-4 shrink-0 text-aiden-deep" aria-hidden="true" />
                  {p}
                </li>
              ))}
            </ul>
            <p className="m-0 text-sm text-muted-foreground">
              We&apos;ll message you on WhatsApp to agree a time that suits you.
            </p>
          </Reveal>
          <Reveal delay={100}>
            <DemoForm />
          </Reveal>
        </div>
      </section>

      {/* Sticky phone action, gone once the form is on screen. */}
      <div
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur transition-transform duration-300 motion-reduce:transition-none sm:hidden",
          formVisible ? "translate-y-full" : "translate-y-0",
        )}
      >
        <Button size="lg" className="h-12 w-full text-base" onClick={() => scrollToId("demo")}>
          Book a personalised demo
        </Button>
      </div>
      <div className={formVisible ? "" : "h-20 sm:hidden"} aria-hidden="true" />
    </NewSiteShell>
  );
}

function PlansStrip({ plans, preview }: { plans: PublicPlan[]; preview: Record<string, string> }) {
  if (!plans.length) return null;
  const inr = (v: number) =>
    new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(v);
  return (
    <section className="border-t border-border">
      <div className={cn(WRAP, "py-20 sm:py-24")}>
        <h2 className={H2}>Plans</h2>
        <p className="m-0 mt-3 text-muted-foreground">
          One monthly plan for the platform, plus 18% GST. Message credits are topped up separately.
        </p>
        <ul className="m-0 mt-10 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-4">
          {plans.map((plan) => (
            <li
              key={plan.key}
              className={cn(
                "flex flex-col gap-2 rounded-[20px] border bg-surface p-6",
                plan.key === "growth" ? "border-aiden shadow-lg ring-2 ring-aiden/20" : "border-border shadow-md",
              )}
            >
              <h3 className="m-0 font-display text-lg font-semibold">{plan.name}</h3>
              <p className="m-0 font-display text-[1.75rem] font-semibold tabular-nums">
                {plan.price_monthly ? (
                  <>
                    {inr(plan.price_monthly)}
                    <span className="font-sans text-sm font-normal text-muted-foreground"> / month</span>
                  </>
                ) : (
                  "Let's talk"
                )}
              </p>
              {plan.tagline ? <p className="m-0 text-sm text-muted-foreground">{plan.tagline}</p> : null}
            </li>
          ))}
        </ul>
        <Link
          to="/pricing"
          search={preview as never}
          className="mt-8 inline-flex items-center gap-1 font-semibold text-aiden-deep underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
        >
          Compare every plan <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
