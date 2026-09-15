import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, BookOpenCheck, HandHelping, MessageSquareText } from "lucide-react";
import { DemoForm } from "@/components/marketing/demo-form";
import { HeroExample } from "@/components/marketing/product-proof";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const TITLE = "Request a personalised AiDwar demo";
const DESCRIPTION =
  "See how AiDwar can handle customer questions using your business information. Request a personalised demo with no account required.";

export const Route = createFileRoute("/demo")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: "https://aidwar.in/demo" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "canonical", href: "https://aidwar.in/demo" }],
  }),
  component: DemoPage,
});

const BENEFITS = [
  {
    icon: BookOpenCheck,
    title: "Learns your business",
    body: "Uses your catalogue, website and the answers you teach it.",
  },
  {
    icon: MessageSquareText,
    title: "Drafts useful replies",
    body: "Helps answer everyday questions using your own information.",
  },
  {
    icon: HandHelping,
    title: "Brings you decisions",
    body: "Designed to ask for owner review when a question needs judgement.",
  },
];

const FAQS = [
  {
    question: "What will I see in the demo?",
    answer:
      "We will use your catalogue or website to demonstrate customer answers, owner handoff, and whether AiDwar fits your workflow.",
  },
  {
    question: "Do I need an account?",
    answer: "No. Send the request and our team will contact you on WhatsApp to arrange the demo.",
  },
  {
    question: "Will this send anything to my customers?",
    answer:
      "No. This page only saves your demo request. It does not connect your number or send customer messages.",
  },
];

function DemoPage() {
  const formSectionRef = useRef<HTMLElement>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const heroActionRef = useRef<HTMLDivElement>(null);
  const [formVisible, setFormVisible] = useState(false);
  const [heroActionPassed, setHeroActionPassed] = useState(false);
  const [formFocused, setFormFocused] = useState(false);
  const [complete, setComplete] = useState(false);

  useEffect(() => {
    const node = formSectionRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setFormVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.08 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = heroActionRef.current;
    if (!node) return;
    const update = () => setHeroActionPassed(node.getBoundingClientRect().bottom < 0);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);

  function goToForm() {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    formSectionRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    window.setTimeout(() => formHeadingRef.current?.focus(), reduce ? 0 : 450);
  }

  const showSticky = heroActionPassed && !formVisible && !formFocused && !complete;

  return (
    <div className="min-h-screen overflow-x-clip bg-background text-foreground">
      <header className="border-b border-border/70 bg-background/95">
        <div className="mx-auto flex h-14 max-w-6xl items-center px-5 sm:px-8">
          <span className="text-xl font-bold text-foreground" aria-label="AiDwar">
            Ai<span className="text-primary">Dwar</span>
          </span>
        </div>
      </header>

      <main>
        <div className="mx-auto max-w-6xl px-5 pb-12 pt-7 sm:px-8 sm:pt-12 lg:grid lg:grid-cols-[minmax(0,0.96fr)_minmax(26rem,1.04fr)] lg:items-start lg:gap-16 lg:pb-20 lg:pt-14">
          <div className="min-w-0">
            <section aria-labelledby="demo-page-title">
              <p className="text-sm font-semibold text-primary">A personalised AiDwar demo</p>
              <h1
                id="demo-page-title"
                className="mt-3 max-w-xl text-[2.5rem] font-extrabold leading-[1.06] text-foreground sm:text-5xl lg:text-[3.4rem]"
              >
                Your AI employee. <span className="text-primary">Inside WhatsApp.</span>
              </h1>
              <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
                Let AiDwar handle customer questions — so you can focus on growing your business.
              </p>
              <p className="mt-3 max-w-xl text-base font-medium leading-7 text-foreground">
                Learns from your business. Drafts replies. Brings you the decisions.
              </p>
              <div ref={heroActionRef}>
                <Button
                  size="lg"
                  onClick={goToForm}
                  className="mt-6 min-h-12 w-full rounded-full bg-gradient-to-r from-primary to-teal-500 text-base transition-transform duration-200 hover:scale-[1.01] active:scale-[0.99] motion-reduce:transform-none sm:w-auto"
                >
                  Request my demo <ArrowRight className="size-4" />
                </Button>
                <p className="mt-3 text-sm text-muted-foreground">No account needed. No customer messages are sent.</p>
              </div>
            </section>

            <section aria-label="Illustrative product example" className="mt-8 sm:mt-10">
              <HeroExample />
            </section>

            <section aria-labelledby="benefits-title" className="mt-9 border-y border-border py-7 sm:mt-12">
              <h2 id="benefits-title" className="sr-only">How AiDwar helps</h2>
              <ul className="grid gap-5">
                {BENEFITS.map((benefit) => (
                  <li key={benefit.title} className="flex gap-3">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <benefit.icon className="size-5" />
                    </span>
                    <div>
                      <h3 className="text-base font-semibold">{benefit.title}</h3>
                      <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{benefit.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <section
            ref={formSectionRef}
            id="request-demo"
            aria-labelledby="request-demo-title"
            className="scroll-mt-4 pt-9 lg:sticky lg:top-6 lg:pt-0"
          >
            <div className="mb-5">
              <h2
                ref={formHeadingRef}
                id="request-demo-title"
                tabIndex={-1}
                className="text-2xl font-bold leading-tight outline-none sm:text-3xl"
              >
                See how AiDwar would handle your customer questions.
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Tell us a little about your business. Your answers stay in place if you go back.
              </p>
            </div>
            <DemoForm focused onFocusChange={setFormFocused} onComplete={() => setComplete(true)} />
          </section>
        </div>

        <section aria-labelledby="faq-title" className="border-t border-border bg-secondary/25">
          <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
            <h2 id="faq-title" className="text-2xl font-bold">A few useful answers</h2>
            <Accordion type="single" collapsible className="mt-4 border-t border-border">
              {FAQS.map((faq, index) => (
                <AccordionItem key={faq.question} value={`faq-${index}`}>
                  <AccordionTrigger className="min-h-12 text-base hover:no-underline">
                    {faq.question}
                  </AccordionTrigger>
                  <AccordionContent className="text-base leading-7 text-muted-foreground">
                    {faq.answer}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>
      </main>

      <footer className="border-t border-border pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-5 py-7 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>Meezoy Ventures Private Limited</p>
          <nav aria-label="Legal" className="flex gap-5">
            <Link to="/privacy" className="min-h-11 py-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              Privacy
            </Link>
            <Link to="/terms" className="min-h-11 py-3 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              Terms
            </Link>
          </nav>
        </div>
      </footer>

      <div
        aria-hidden={!showSticky}
        className={`fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur transition-transform duration-200 motion-reduce:transition-none lg:hidden ${
          showSticky ? "translate-y-0" : "pointer-events-none translate-y-full"
        }`}
      >
        <Button
          size="lg"
          onClick={goToForm}
          tabIndex={showSticky ? 0 : -1}
          className="min-h-12 w-full rounded-full bg-gradient-to-r from-primary to-teal-500 text-base"
        >
          Request my demo
        </Button>
      </div>
      <div className={showSticky ? "h-20 lg:hidden" : "hidden"} aria-hidden />
    </div>
  );
}