import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { WaitlistDialog } from "@/components/waitlist-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Reveal } from "@/components/marketing/reveal";

const TITLE = "Pricing — AiDwar WhatsApp marketing plans";
const DESCRIPTION =
  "Simple monthly plans for WhatsApp marketing in India. Pay for the platform, top up message credits as you go. GST invoices on every payment.";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: PricingPage,
});

type Plan = {
  key: string;
  name: string;
  tagline: string | null;
  currency: string;
  price_monthly: number | null;
  price_annual: number | null;
  limits: Record<string, number>;
  highlights: string[];
};

const FEATURED = "growth";

function inr(value: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value);
}

function limitLine(limits: Record<string, number>): string[] {
  const lines: string[] = [];
  const members = Number(limits["members"] ?? 0);
  const numbers = Number(limits["numbers"] ?? 0);
  const ai = Number(limits["ai_answers"] ?? 0);
  lines.push(members === -1 ? "Unlimited team members" : `${members} team members`);
  lines.push(
    numbers === -1
      ? "Unlimited business numbers"
      : `${numbers} business ${numbers === 1 ? "number" : "numbers"}`,
  );
  lines.push(
    ai === -1 ? "Unlimited AI answers" : `${ai.toLocaleString("en-IN")} AI answers a month`,
  );
  return lines;
}

function PricingPage() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [annual, setAnnual] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/public/plans")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("failed"))))
      .then((body: { plans: Plan[] }) => {
        if (live) setPlans(body.plans ?? []);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader />
      <main className="flex-1">
        <section className="border-b border-border bg-gradient-to-b from-primary/5 to-background">
          <div className="mx-auto max-w-6xl px-5 py-16 text-center sm:px-8 sm:py-24">
            <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-5xl">
              Pricing that grows with the shop, not against it
            </h1>
            <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-muted-foreground">
              One monthly plan for the platform. Message credits are topped up separately and
              charged at cost plus a small margin — you always see the per-message rate before you
              send.
            </p>

            <div className="mt-8 inline-flex items-center gap-1 rounded-full border border-border bg-background p-1">
              <button
                type="button"
                onClick={() => setAnnual(false)}
                className={`rounded-full px-4 py-1.5 text-sm transition-colors duration-200 ${!annual ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setAnnual(true)}
                className={`rounded-full px-4 py-1.5 text-sm transition-colors duration-200 ${annual ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                Yearly
                <span className="ml-1.5 text-xs opacity-80">2 months free</span>
              </button>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 py-16 sm:px-8">
          {failed ? (
            <div className="rounded-2xl border border-border bg-secondary/40 p-10 text-center">
              <p className="text-sm text-muted-foreground">
                We couldn't load the plans just now. Refresh the page, or write to us at{" "}
                <a className="text-primary underline" href="mailto:support@aidwar.in">
                  support@aidwar.in
                </a>{" "}
                and we'll send them over.
              </p>
            </div>
          ) : !plans ? (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-96 rounded-2xl" />
              ))}
            </div>
          ) : (
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
              {plans.map((plan, index) => {
                const featured = plan.key === FEATURED;
                const price = annual ? plan.price_annual : plan.price_monthly;
                const custom = price === null || price === 0;
                return (
                  <Reveal key={plan.key} delay={index * 60} className="h-full">
                    <div
                      className={`flex h-full flex-col rounded-2xl border p-6 transition-shadow duration-200 ${
                        featured
                          ? "border-primary bg-primary/5 shadow-lg shadow-primary/10"
                          : "border-border bg-background hover:shadow-md"
                      }`}
                    >
                      {featured ? (
                        <span className="mb-3 inline-flex w-fit items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">
                          <Sparkles className="h-3 w-3" />
                          Most popular
                        </span>
                      ) : null}
                      <h2 className="font-heading text-xl font-bold">{plan.name}</h2>
                      <p className="mt-1 min-h-10 text-sm text-muted-foreground">{plan.tagline}</p>

                      <div className="mt-5">
                        {custom ? (
                          <div className="font-heading text-3xl font-bold">Let's talk</div>
                        ) : (
                          <>
                            <span className="font-heading text-4xl font-bold">{inr(price)}</span>
                            <span className="text-sm text-muted-foreground">
                              {annual ? " / year" : " / month"}
                            </span>
                          </>
                        )}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {custom ? "Custom terms and white-label" : "Plus 18% GST, plus credits"}
                        </p>
                      </div>

                      <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                        {limitLine(plan.limits).map((line) => (
                          <li key={line} className="flex items-start gap-2">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                            <span>{line}</span>
                          </li>
                        ))}
                        {plan.highlights.map((line) => (
                          <li key={line} className="flex items-start gap-2">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                            <span className="text-muted-foreground">{line}</span>
                          </li>
                        ))}
                      </ul>

                      {custom ? (
                        <Button asChild variant="outline" className="mt-6 rounded-full">
                          <a href="mailto:support@aidwar.in?subject=AiDwar%20Enterprise">
                            Talk to us
                          </a>
                        </Button>
                      ) : (
                        <WaitlistDialog
                          trigger={
                            <Button
                              className="mt-6 rounded-full"
                              variant={featured ? "default" : "outline"}
                            >
                              Get started
                            </Button>
                          }
                        />
                      )}
                    </div>
                  </Reveal>
                );
              })}
            </div>
          )}
        </section>

        <section className="border-t border-border bg-secondary/40">
          <div className="mx-auto max-w-4xl px-5 py-16 sm:px-8">
            <h2 className="font-heading text-2xl font-bold">How message credits work</h2>
            <div className="mt-6 space-y-5 text-sm leading-relaxed text-muted-foreground">
              <p>
                Meta charges per conversation, and the rate depends on what you're sending —
                promotions, order updates or one-time passcodes. We pass that through with a clear
                margin, show you the exact rate in your billing page before you send, and never
                bill you for replies inside the 24-hour service window.
              </p>
              <p>
                Credits are prepaid: top up whenever you like, and every campaign tells you what it
                will cost before it goes out. If a campaign would take you below zero, we stop it
                and ask you first.
              </p>
              <p>
                Every payment gets a GST tax invoice with your GSTIN on it, downloadable from your
                billing page. Turn on auto-pay and the plan fee takes care of itself.
              </p>
            </div>
            <div className="mt-8 flex flex-wrap gap-3">
              <WaitlistDialog
                trigger={<Button className="rounded-full">Get early access</Button>}
              />
              <Button asChild variant="outline" className="rounded-full">
                <Link to="/terms">Read the terms</Link>
              </Button>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
