import { createFileRoute, Link } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { DemoForm } from "@/components/marketing/demo-form";
import { trackMarketing } from "@/lib/marketing-analytics";

const TITLE = "Book a personalised demo — AiDwar";
const DESCRIPTION =
  "See how AiDwar would answer your customers on WhatsApp, built around your own catalogue. A short walkthrough with our team — no account needed.";

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

const WHAT_YOU_GET = [
  "We show AiDwar answering questions built around your own catalogue or website",
  "We show what happens when it doesn't know — how it hands over to you",
  "We talk honestly about whether AiDwar fits how you work",
];

function DemoPage() {
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">
        <section className="relative overflow-hidden">
          <div className="pointer-events-none absolute inset-x-0 -top-56 h-[36rem] bg-[radial-gradient(ellipse_at_top,color-mix(in_oklab,var(--primary)_18%,transparent),transparent_65%)]" />
          <div className="relative mx-auto grid max-w-6xl gap-12 px-5 pb-20 pt-14 sm:px-8 sm:pb-24 sm:pt-20 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
            <div>
              <h1 className="max-w-lg text-[2.4rem] font-extrabold leading-[1.08] tracking-tight text-foreground sm:text-5xl">
                See how AiDwar would handle{" "}
                <span className="bg-gradient-to-r from-primary to-teal-500 bg-clip-text text-transparent">
                  your customer questions.
                </span>
              </h1>
              <p className="mt-6 max-w-md text-base leading-relaxed text-muted-foreground sm:text-lg">
                A short, personalised walkthrough with someone from our team — built around your own
                business, not a generic deck. No account needed.
              </p>
              <ul className="mt-8 space-y-3 text-sm text-muted-foreground">
                {WHAT_YOU_GET.map((p) => (
                  <li key={p} className="flex gap-3">
                    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <Check className="size-3 text-primary" />
                    </span>
                    {p}
                  </li>
                ))}
              </ul>
              <p className="mt-8 text-xs leading-relaxed text-muted-foreground">
                We&apos;ll message you on WhatsApp to agree a time that suits you.
              </p>
            </div>

            <div>
              <DemoForm />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-5 py-8 text-xs text-muted-foreground sm:flex-row sm:px-8">
          <p>© Meezoy Ventures Private Limited</p>
          <div className="flex items-center gap-5">
            <Link to="/" className="hover:text-foreground">
              Home
            </Link>
            <Link
              to="/signup"
              className="font-medium text-primary underline underline-offset-4"
              onClick={() => trackMarketing("signup_link_clicked", { placement: "demo_footer" })}
            >
              Start free
            </Link>
            <Link to="/privacy" className="hover:text-foreground">
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
