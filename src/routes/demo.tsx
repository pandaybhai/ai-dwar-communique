import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BookOpen,
  BookOpenCheck,
  HandHelping,
  History,
  MessageSquareText,
  PauseCircle,
  PencilLine,
  Send,
} from "lucide-react";
import { DemoForm } from "@/components/marketing/demo-form";
import { HeroExample } from "@/components/marketing/product-proof";
import { RecordedProof } from "@/components/marketing/recorded-proof";
import { getPublishedProof } from "@/lib/demo-proof.functions";
import type { PublicProof } from "@/lib/demo-proof";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { trackMarketing } from "@/lib/marketing-analytics";
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
  loader: () => getPublishedProof(),
  errorComponent: () => <DemoPage proof={[]} />,
  notFoundComponent: () => <DemoPage proof={[]} />,
  component: DemoRoute,
});

/** The page is worth showing even if the recorded proof can't be read. */
function DemoRoute() {
  const data = Route.useLoaderData();
  return <DemoPage proof={(data?.proof ?? []) as PublicProof[]} />;
}

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
      "You share your website or catalogue, we show you a grounded answer built from it and an owner handoff, and you decide whether AiDwar fits your business.",
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

type CampaignContext = "general" | "retail" | "services" | "growing";
type DemoNeed = "replies" | "handoff" | "campaigns";

const CAMPAIGN_CONTEXTS: Record<CampaignContext, { eyebrow: string; headline: string; supporting: string }> = {
  general: {
    eyebrow: "A personalised AiDwar demo",
    headline: "Your AI employee. Inside WhatsApp.",
    supporting: "Let AiDwar handle customer questions — so you can focus on growing your business.",
  },
  retail: {
    eyebrow: "For retail and D2C teams",
    headline: "Turn your catalogue into helpful customer replies.",
    supporting: "Show AiDwar your products, then see how it drafts answers and brings uncertain questions to you.",
  },
  services: {
    eyebrow: "For service businesses",
    headline: "Handle routine questions. Keep judgement with your team.",
    supporting: "See how AiDwar drafts service answers and hands decisions to the right person.",
  },
  growing: {
    eyebrow: "For growing teams",
    headline: "Give every customer question a clear next step.",
    supporting: "See shared replies, owner review and follow-up context working together in one demo.",
  },
};

const NEEDS: Array<{ id: DemoNeed; label: string; title: string; example: string }> = [
  { id: "replies", label: "Customer replies", title: "Answer from your business knowledge", example: "A customer asks about a product or service. AiDwar drafts from the information you supplied." },
  { id: "handoff", label: "Owner approvals", title: "Bring judgement to the right person", example: "A customer asks for an exception. AiDwar holds the reply and marks what needs your input." },
  { id: "campaigns", label: "Follow-ups", title: "Keep the next action visible", example: "A customer wants details later. AiDwar keeps the follow-up and conversation context together." },
];

const INDUSTRIES = [
  { id: "retail", label: "Retail", outcome: "Answer product, availability and delivery questions from your catalogue." },
  { id: "services", label: "Services", outcome: "Collect enquiry details and bring appointment decisions to your team." },
  { id: "education", label: "Education", outcome: "Explain course information and flag admissions questions that need a person." },
  { id: "healthcare", label: "Healthcare", outcome: "Share approved clinic information while keeping clinical judgement with your team." },
  { id: "realestate", label: "Real estate", outcome: "Answer property basics and organize serious enquiries for an agent." },
] as const;

const DELIVERABLES = [
  { number: "01", title: "Share your website or catalogue", body: "We use the business information you choose to provide." },
  { number: "02", title: "See answer and handoff", body: "Review one grounded reply and one question that needs you." },
  { number: "03", title: "Discuss fit", body: "Decide where AiDwar could help your team and where it should not." },
];

function DemoPage({ proof }: { proof: PublicProof[] }) {
  const formSectionRef = useRef<HTMLElement>(null);
  const formHeadingRef = useRef<HTMLHeadingElement>(null);
  const heroActionRef = useRef<HTMLDivElement>(null);
  const [formVisible, setFormVisible] = useState(false);
  const [heroActionPassed, setHeroActionPassed] = useState(false);
  const [formFocused, setFormFocused] = useState(false);
  const [complete, setComplete] = useState(false);
  const [campaignContext, setCampaignContext] = useState<CampaignContext>("general");
  const [need, setNeed] = useState<DemoNeed>("replies");
  const [industry, setIndustry] = useState("retail");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const candidate = (params.get("context") ?? params.get("utm_content") ?? "").toLowerCase();
    const aliases: Record<string, CampaignContext> = {
      retail: "retail", ecommerce: "retail", d2c: "retail",
      services: "services", service: "services", appointments: "services",
      growing: "growing", teams: "growing", "growing-teams": "growing",
    };
    const matched = aliases[candidate];
    if (!matched) return;
    setCampaignContext(matched);
    if (matched === "retail" || matched === "services") setIndustry(matched);
  }, []);

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
  const campaign = CAMPAIGN_CONTEXTS[campaignContext];
  const selectedNeed = NEEDS.find((item) => item.id === need) ?? NEEDS[0]!;
  const selectedIndustry = INDUSTRIES.find((item) => item.id === industry) ?? INDUSTRIES[0]!;

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
               <p className="text-sm font-semibold text-primary">{campaign.eyebrow}</p>
              <h1
                id="demo-page-title"
                className="mt-3 max-w-xl text-[2.5rem] font-extrabold leading-[1.06] text-foreground sm:text-5xl lg:text-[3.4rem]"
              >
                 {campaignContext === "general" ? <>Your AI employee. <span className="text-primary">Inside WhatsApp.</span></> : campaign.headline}
              </h1>
              <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
                 {campaign.supporting}
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

            <section
              aria-label={proof.length ? "Recorded product test" : "Illustrative product example"}
              className="mt-8 sm:mt-10"
            >
              {proof.length ? <RecordedProof proof={proof} /> : <HeroExample />}
            </section>

            <section aria-labelledby="choose-title" className="mt-9">
              <p className="text-xs font-semibold uppercase tracking-wide text-primary">Shape your demo</p>
              <h2 id="choose-title" className="mt-2 text-2xl font-bold">Choose what you want to see</h2>
              <div role="tablist" aria-label="Demo focus" className="mt-4 grid grid-cols-3 gap-1 rounded-xl bg-secondary p-1">
                {NEEDS.map((item) => (
                  <button key={item.id} type="button" role="tab" aria-selected={need === item.id} onClick={() => { setNeed(item.id); trackMarketing("demo_need_selected", { primary_need: item.id }); }} className={cn("min-h-11 rounded-lg px-2 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary sm:text-sm", need === item.id ? "bg-card text-primary shadow-sm" : "text-muted-foreground hover:text-foreground")}>{item.label}</button>
                ))}
              </div>
              <div className="mt-3 border-l-2 border-primary pl-4">
                <p className="text-sm font-semibold">{selectedNeed.title}</p>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{selectedNeed.example}</p>
              </div>
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
                See AiDwar answer questions from your own business.
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Share your website or catalogue, see a grounded answer and an owner handoff, then
                decide whether it fits. Website is optional. Your answers stay in place if you go
                back.
              </p>
            </div>
            <DemoForm presetBusinessType={industry} presetPrimaryNeed={need} focused onFocusChange={setFormFocused} onComplete={() => setComplete(true)} />
          </section>
        </div>

        <section aria-labelledby="deliverable-title" className="border-y border-border bg-secondary/25">
          <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
            <p className="text-sm font-semibold text-primary">What your demo includes</p>
            <h2 id="deliverable-title" className="mt-2 text-2xl font-bold sm:text-3xl">From your information to a useful decision</h2>
            <ol className="mt-6 grid gap-5 md:grid-cols-3">
              {DELIVERABLES.map((item) => <li key={item.number} className="border-t border-border pt-4"><span className="text-xs font-bold text-primary">{item.number}</span><h3 className="mt-2 font-semibold">{item.title}</h3><p className="mt-1 text-sm leading-6 text-muted-foreground">{item.body}</p></li>)}
            </ol>
          </div>
        </section>

        <section aria-labelledby="industry-title">
          <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
            <h2 id="industry-title" className="text-2xl font-bold sm:text-3xl">Built around how your business works</h2>
            <div role="tablist" aria-label="Industry examples" className="mt-5 flex gap-2 overflow-x-auto pb-2">
              {INDUSTRIES.map((item) => <button key={item.id} type="button" role="tab" aria-selected={industry === item.id} onClick={() => { setIndustry(item.id); trackMarketing("demo_context_selected", { industry: item.id }); }} className={cn("min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary", industry === item.id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>{item.label}</button>)}
            </div>
            <p className="mt-4 max-w-2xl text-base leading-7 text-foreground">{selectedIndustry.outcome}</p>
          </div>
        </section>

        <section aria-labelledby="control-title" className="border-y border-border bg-foreground text-background">
          <div className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">
            <p className="text-sm font-semibold text-primary">Example of the controls available in AiDwar</p>
            <h2 id="control-title" className="mt-2 text-2xl font-bold sm:text-3xl">You decide how much control to hand over</h2>
            <div className="mt-6 grid gap-3 sm:grid-cols-3">
              {[{ label: "Off", icon: PauseCircle, text: "Your team handles the conversation." }, { label: "Draft only", icon: PencilLine, text: "Replies wait for a person to review." }, { label: "Replying", icon: Send, text: "Known questions can be answered from supplied knowledge." }].map((item, index) => <div key={item.label} className={cn("rounded-xl border p-4", index === 1 ? "border-primary bg-primary/15" : "border-background/20")}><item.icon className="size-5 text-primary"/><p className="mt-3 font-semibold">{item.label}</p><p className="mt-1 text-sm leading-6 text-background/70">{item.text}</p></div>)}
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <div className="flex gap-3 border-t border-background/20 pt-4"><BookOpen className="size-5 shrink-0 text-primary"/><div><p className="font-semibold">Knowledge sources</p><p className="mt-1 text-sm text-background/70">See the website, catalogue and taught answers it can use.</p></div></div>
              <div className="flex gap-3 border-t border-background/20 pt-4"><History className="size-5 shrink-0 text-primary"/><div><p className="font-semibold">Work history</p><p className="mt-1 text-sm text-background/70">Review drafts, replies and owner handoffs in one place.</p></div></div>
            </div>
          </div>
        </section>

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