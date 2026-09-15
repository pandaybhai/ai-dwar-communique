import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BookOpenCheck,
  HandHelping,
  Link2,
  MessageCircleQuestion,
  MessagesSquare,
  SlidersHorizontal,
  Sparkles,
  Store,
  UsersRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { Reveal } from "@/components/marketing/reveal";
import {
  HeroExample,
  ProductProof,
  type ProofAudience,
} from "@/components/marketing/product-proof";
import { DemoForm } from "@/components/marketing/demo-form";
import { trackMarketing } from "@/lib/marketing-analytics";

const TITLE = "AiDwar — Your AI employee inside WhatsApp";
const DESCRIPTION =
  "AiDwar understands your business, replies to customers on WhatsApp, and asks for your approval when needed. Book a personalised demo.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://aidwar.in/" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [{ rel: "canonical", href: "https://aidwar.in/" }],
    scripts: [
      {
        type: "application/ld+json",
        children: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "SoftwareApplication",
          name: "AiDwar",
          applicationCategory: "BusinessApplication",
          operatingSystem: "Web",
          url: "https://aidwar.in/",
          description: DESCRIPTION,
          publisher: {
            "@type": "Organization",
            name: "Meezoy Ventures Private Limited",
            url: "https://aidwar.in/",
          },
        }),
      },
    ],
  }),
  component: Index,
});

const CAPABILITIES = [
  {
    icon: BookOpenCheck,
    title: "Understands",
    body: "It reads your website, catalogue and the answers you teach it, so replies are grounded in your own material.",
  },
  {
    icon: MessagesSquare,
    title: "Replies",
    body: "Customers get an answer in the language they wrote in, at 11 at night or during a festival rush.",
  },
  {
    icon: HandHelping,
    title: "Asks you",
    body: "When it has no answer in what it knows, it is designed to stop, say so plainly and bring you in.",
  },
];

const AUDIENCE_BENEFITS: Record<ProofAudience, { icon: typeof Store; title: string; points: string[] }> = {
  retail: {
    icon: Store,
    title: "Retail & D2C",
    points: [
      "Size, price and stock questions answered from your own product pages",
      "Product links sent in the chat instead of screenshots",
      "Designed to ask you rather than state a price it cannot find in your catalogue",
    ],
  },
  services: {
    icon: MessageCircleQuestion,
    title: "Services & appointments",
    points: [
      "Enquiries qualified before they reach your team",
      "Details collected in one thread, not across five chats",
      "Anyone asking for a person is handed over straight away",
    ],
  },
  growing: {
    icon: UsersRound,
    title: "Growing teams",
    points: [
      "One shared inbox, so your team can see who is handling which chat",
      "Draft only mode while your team builds trust in it",
      "A work history showing what was answered and what was handed over",
    ],
  },
};

const STEPS = [
  {
    icon: Link2,
    title: "Connect your number",
    body: "Connect your business number through the official WhatsApp Business Platform. Your number, your account.",
  },
  {
    icon: BookOpenCheck,
    title: "It reads your business",
    body: "Point it at your website or store and it builds its knowledge from your pages, products and policies.",
  },
  {
    icon: Sparkles,
    title: "You teach the gaps",
    body: "Whenever it doesn't know something, it asks you. Your answer becomes part of what it knows.",
  },
  {
    icon: SlidersHorizontal,
    title: "You choose how far it goes",
    body: "Off, Draft only, or Replying. Change it whenever you like, from your phone.",
  },
];

const FAQS = [
  {
    q: "Will it make things up about my products?",
    a: "It is built to answer from what it has read or been taught. When it has no source for something, it is designed to say so and ask you, rather than state a price or a promise. You can also review its replies before they go out.",
  },
  {
    q: "Do I have to let it reply straight away?",
    a: "No. You can start in Draft only, where it writes the reply and a person presses send. You can switch it off entirely at any time.",
  },
  {
    q: "Is this the official WhatsApp Business Platform?",
    a: "Yes. Your business number is connected through the official platform, and message templates go through the usual approval process.",
  },
  {
    q: "Which languages does it handle?",
    a: "It is built to reply in the language the customer wrote in, including Hinglish and several Indian languages alongside English.",
  },
  {
    q: "What happens to my data?",
    a: "Your catalogue, chats and customer list stay yours, inside your own workspace. Read the privacy policy for the detail.",
  },
];

function scrollToId(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
}

function Index() {
  const [audience, setAudience] = useState<ProofAudience>("retail");
  const [formVisible, setFormVisible] = useState(false);
  const formRef = useRef<HTMLDivElement>(null);

  // The sticky mobile action disappears once the form is on screen, so it can
  // never sit on top of the fields it is pointing at.
  useEffect(() => {
    const node = formRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setFormVisible(!!entry?.isIntersecting), {
      threshold: 0.12,
    });
    io.observe(node);
    return () => io.disconnect();
  }, []);

  const presetBusinessType =
    audience === "retail" ? "retail" : audience === "services" ? "services" : "other";

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">
        {/* Hero */}
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-x-0 -top-56 h-[36rem] bg-[radial-gradient(ellipse_at_top,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_65%)]" />
          <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-5 pb-16 pt-16 sm:px-8 sm:pb-24 sm:pt-24 lg:grid-cols-[1.02fr_0.98fr] lg:gap-14">
            <Reveal>
              <span className="inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-4 py-1.5 text-xs font-medium text-primary">
                Official WhatsApp Business Platform
              </span>
              <h1 className="mt-7 max-w-2xl text-[2.6rem] font-extrabold leading-[1.05] tracking-tight text-foreground sm:text-[3.4rem]">
                Your AI employee.{" "}
                <span className="bg-gradient-to-r from-primary to-teal-500 bg-clip-text text-transparent">
                  Inside WhatsApp.
                </span>
              </h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
                AiDwar understands your business, replies to customers, and asks for your approval
                when needed. You focus on what matters.
              </p>

              <div className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center">
                <Button
                  size="lg"
                  onClick={() => scrollToId("demo")}
                  className="w-full rounded-full bg-gradient-to-r from-primary to-teal-500 px-8 transition-transform duration-200 hover:scale-[1.02] active:scale-[0.99] motion-reduce:transform-none sm:w-auto"
                >
                  Book a personalised demo
                  <ArrowRight className="size-4" />
                </Button>
                <button
                  type="button"
                  onClick={() => scrollToId("proof")}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-full border border-border px-6 text-sm font-medium text-foreground transition-colors duration-200 hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                >
                  See how it works
                </button>
              </div>

              <p className="mt-6 text-sm text-muted-foreground">
                Rather try it yourself?{" "}
                <Link
                  to="/signup"
                  className="font-medium text-primary underline underline-offset-4"
                  onClick={() => trackMarketing("signup_link_clicked", { placement: "hero" })}
                >
                  Start free
                </Link>{" "}
                ·{" "}
                <Link to="/pricing" className="underline underline-offset-4 hover:text-foreground">
                  See pricing
                </Link>
              </p>
            </Reveal>

            {/* Compact example of the same walkthrough shown in full below.
                Hidden on small screens to keep the first mobile view short. */}
            <Reveal delay={120} className="hidden lg:block">
              <HeroExample onSeeMore={() => scrollToId("proof")} />
            </Reveal>
          </div>
        </section>

        {/* Product proof */}
        <section id="proof" className="scroll-mt-20 border-t border-border bg-secondary/25">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-28">
            <Reveal>
              <ProductProof audience={audience} onAudienceChange={setAudience} />
            </Reveal>
          </div>
        </section>

        {/* Capabilities */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <div className="grid gap-10 lg:grid-cols-3 lg:gap-14">
              {CAPABILITIES.map((c, i) => (
                <Reveal key={c.title} delay={i * 80}>
                  <div className="border-l-2 border-primary/25 pl-6">
                    <c.icon className="size-6 text-primary" />
                    <h2 className="mt-4 text-2xl font-bold tracking-tight">{c.title}</h2>
                    <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* Benefits by business */}
        <section className="border-t border-border bg-secondary/25">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <Reveal>
              <h2 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
                What it changes, depending on what you run
              </h2>
            </Reveal>
            <div className="mt-10 grid gap-4 lg:grid-cols-3">
              {(Object.keys(AUDIENCE_BENEFITS) as ProofAudience[]).map((key, i) => {
                const b = AUDIENCE_BENEFITS[key];
                const active = key === audience;
                return (
                  <Reveal key={key} delay={i * 80}>
                    <button
                      type="button"
                      onClick={() => {
                        setAudience(key);
                        scrollToId("proof");
                      }}
                      aria-pressed={active}
                      className={
                        "h-full w-full rounded-3xl border p-7 text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 motion-reduce:transition-none " +
                        (active
                          ? "border-primary/40 bg-card shadow-[var(--shadow-card)]"
                          : "border-border bg-card/60 hover:-translate-y-1 hover:border-primary/30")
                      }
                    >
                      <b.icon className="size-5 text-primary" />
                      <h3 className="mt-4 text-lg font-semibold">{b.title}</h3>
                      <ul className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
                        {b.points.map((p) => (
                          <li key={p} className="flex gap-2">
                            <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                            {p}
                          </li>
                        ))}
                      </ul>
                      <span className="mt-5 inline-flex items-center gap-1.5 text-sm font-medium text-primary">
                        See an example <ArrowRight className="size-3.5" />
                      </span>
                    </button>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* Setup */}
        <section className="border-t border-border">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-8 sm:py-24">
            <Reveal>
              <h2 className="max-w-2xl text-3xl font-bold tracking-tight sm:text-4xl">
                Getting it working
              </h2>
            </Reveal>
            <ol className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {STEPS.map((s, i) => (
                <Reveal key={s.title} delay={i * 70}>
                  <li className="flex gap-4">
                    <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-sm font-bold text-primary">
                      {i + 1}
                    </span>
                    <div>
                      <h3 className="text-base font-semibold">{s.title}</h3>
                      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.body}</p>
                    </div>
                  </li>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        {/* FAQs */}
        <section className="border-t border-border bg-secondary/25">
          <div className="mx-auto max-w-3xl px-5 py-20 sm:px-8 sm:py-24">
            <Reveal>
              <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">Straight answers</h2>
            </Reveal>
            <dl className="mt-10 divide-y divide-border border-y border-border">
              {FAQS.map((f, i) => (
                <Reveal key={f.q} delay={i * 50}>
                  <div className="py-6">
                    <dt className="text-base font-semibold">{f.q}</dt>
                    <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.a}</dd>
                  </div>
                </Reveal>
              ))}
            </dl>
          </div>
        </section>

        {/* Demo form */}
        <section id="demo" className="scroll-mt-20 border-t border-border">
          <div
            ref={formRef}
            className="mx-auto grid max-w-6xl gap-10 px-5 py-20 sm:px-8 sm:py-24 lg:grid-cols-[1fr_1.1fr] lg:gap-16"
          >
            <Reveal>
              <h2 className="max-w-lg text-3xl font-bold tracking-tight sm:text-4xl">
                See how AiDwar would handle your customer questions.
              </h2>
              <p className="mt-5 max-w-md text-muted-foreground">
                A short, personalised walkthrough with someone from our team — built around your own
                business, not a generic deck.
              </p>
              <ul className="mt-7 space-y-3 text-sm text-muted-foreground">
                {[
                  "We show it answering questions built around your own catalogue or website",
                  "We show what happens when it doesn't know — how it hands over to you",
                  "We talk honestly about whether AiDwar fits how you work",
                ].map((p) => (
                  <li key={p} className="flex gap-3">
                    <span className="mt-2 size-1.5 shrink-0 rounded-full bg-primary" />
                    {p}
                  </li>
                ))}
              </ul>
              <p className="mt-7 text-xs text-muted-foreground">
                We&apos;ll message you on WhatsApp to agree a time that suits you.
              </p>
            </Reveal>

            <Reveal delay={100}>
              <DemoForm presetBusinessType={presetBusinessType} />
            </Reveal>
          </div>
        </section>
      </main>
      <SiteFooter />

      {/* Sticky mobile action — hidden once the form is on screen */}
      <div
        className={
          "fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur transition-transform duration-300 motion-reduce:transition-none sm:hidden " +
          (formVisible ? "translate-y-full" : "translate-y-0")
        }
      >
        <Button
          size="lg"
          onClick={() => scrollToId("demo")}
          className="w-full rounded-full bg-gradient-to-r from-primary to-teal-500"
        >
          Book a personalised demo
        </Button>
      </div>
      <div className={formVisible ? "" : "h-20 sm:hidden"} aria-hidden />
    </div>
  );
}
