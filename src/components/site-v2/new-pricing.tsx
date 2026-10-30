import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Check, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/marketing/reveal";
import { MessageRatesTable } from "@/components/marketing/message-rates";
import {
  CreditsExplained,
  FEATURED,
  inr,
  limitLine,
  type Plan,
} from "@/components/marketing/pricing-copy";
import type { ClientRate } from "@/lib/billing";
import { useSitePreviewSearch } from "@/lib/new-site";
import { cn } from "@/lib/utils";
import { NewSiteShell } from "./site-shell";

const WRAP = "mx-auto w-full max-w-[1200px] px-[max(16px,env(safe-area-inset-left))]";

/**
 * Batch 50: the pricing page in the new design (switch new_site). The same
 * server-read plans and INR message rates (getPublicPlans, getPublicRates),
 * the same words (pricing-copy.tsx), the same Start free / Talk to us links.
 */
export function NewPricing({
  plans,
  failed,
  rates,
  gstRegistered = false,
}: {
  plans: Plan[] | null;
  failed: boolean;
  rates: ClientRate[];
  /** Batch 55: "Plus 18% GST" only while AiDwar is GST-registered. */
  gstRegistered?: boolean;
}) {
  const [annual, setAnnual] = useState(false);
  const preview = useSitePreviewSearch();

  return (
    <NewSiteShell>
      <section
        className={cn(WRAP, "flex flex-col items-center gap-5 pb-12 pt-14 text-center sm:pt-20")}
      >
        <h1 className="m-0 max-w-3xl font-display text-[clamp(2.25rem,5.2vw,3.75rem)] font-extrabold leading-[1.04] tracking-[-0.035em] [text-wrap:balance]">
          Pricing that grows with the shop, not against it
        </h1>
        <p className="m-0 max-w-2xl text-[1.0625rem] text-muted-foreground">
          Every plan starts with a free day one on WhatsApp. No card needed.
        </p>
        <p className="m-0 max-w-2xl text-sm text-muted-foreground">
          One monthly plan for the platform. Message credits are topped up separately and charged at
          cost plus a small margin — you always see the per-message rate before you send.
        </p>
        <div
          role="group"
          aria-label="Billing period"
          className="mt-2 inline-flex rounded-[14px] border border-border bg-surface p-1"
        >
          {[
            { on: !annual, label: "Monthly", set: false },
            { on: annual, label: "Yearly", set: true },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              aria-pressed={o.on}
              onClick={() => setAnnual(o.set)}
              className={cn(
                "rounded-[10px] px-4 py-2 text-sm font-semibold transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden",
                o.on ? "bg-ink text-ink-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
              {o.set ? (
                <span className="ml-1.5 text-xs font-medium opacity-90">2 months free</span>
              ) : null}
            </button>
          ))}
        </div>
      </section>

      <section className={cn(WRAP, "pb-20")}>
        {failed ? (
          <div className="rounded-[20px] border border-border bg-surface p-10 text-center">
            <p className="m-0 text-sm text-muted-foreground">
              We couldn't load the plans just now. Refresh the page, or write to us at{" "}
              <a
                className="font-semibold text-aiden-deep underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
                href="mailto:support@aidwar.in"
              >
                support@aidwar.in
              </a>{" "}
              and we'll send them over.
            </p>
          </div>
        ) : (
          <ul className="m-0 grid list-none gap-5 p-0 md:grid-cols-2 lg:grid-cols-4">
            {(plans ?? []).map((plan, index) => {
              const featured = plan.key === FEATURED;
              const price = annual ? plan.price_annual : plan.price_monthly;
              const custom = price === null || price === 0;
              return (
                <li key={plan.key} className="h-full">
                  <Reveal delay={index * 60} className="h-full">
                    <div
                      className={cn(
                        "flex h-full flex-col rounded-[20px] border bg-surface p-6",
                        featured
                          ? "border-aiden shadow-xl ring-2 ring-aiden/25"
                          : "border-border shadow-md",
                      )}
                    >
                      {featured ? (
                        <span className="mb-3 inline-flex w-fit items-center gap-1 rounded-full bg-aiden-soft px-3 py-1 text-xs font-bold text-aiden-deep">
                          <Sparkles className="h-3 w-3" aria-hidden="true" />
                          Most popular
                        </span>
                      ) : null}
                      <h2 className="m-0 font-display text-[1.375rem] font-semibold">
                        {plan.name}
                      </h2>
                      <p className="m-0 mt-1 min-h-10 text-sm text-muted-foreground">
                        {plan.tagline}
                      </p>
                      <div className="mt-5">
                        {custom ? (
                          <div className="font-display text-3xl font-semibold">Let's talk</div>
                        ) : (
                          <>
                            <span className="font-display text-[2.5rem] font-extrabold leading-none tracking-[-0.03em] tabular-nums">
                              {inr(price)}
                            </span>
                            <span className="text-sm text-muted-foreground">
                              {annual ? " / year" : " / month"}
                            </span>
                            {!annual && plan.price_annual ? (
                              <p className="m-0 mt-1 text-sm text-muted-foreground">
                                or {inr(plan.price_annual)}/yr
                              </p>
                            ) : null}
                          </>
                        )}
                        <p className="m-0 mt-1 text-xs text-muted-foreground">
                          {custom
                            ? "Custom terms and white-label"
                            : gstRegistered
                              ? "Plus 18% GST, plus credits"
                              : "Plus credits"}
                        </p>
                      </div>
                      <ul className="m-0 mt-6 flex flex-1 list-none flex-col gap-2.5 p-0 text-sm">
                        {limitLine(plan.limits).map((line) => (
                          <li key={line} className="flex items-start gap-2">
                            <Check
                              className="mt-0.5 h-4 w-4 shrink-0 text-aiden-deep"
                              aria-hidden="true"
                            />
                            <span>{line}</span>
                          </li>
                        ))}
                        {plan.highlights.map((line) => (
                          <li key={line} className="flex items-start gap-2">
                            <Check
                              className="mt-0.5 h-4 w-4 shrink-0 text-aiden-deep"
                              aria-hidden="true"
                            />
                            <span className="text-muted-foreground">{line}</span>
                          </li>
                        ))}
                        {/* Batch 52: AiDwar MCP is on every plan, trial included. */}
                        <li className="flex items-start gap-2">
                          <Check
                            className="mt-0.5 h-4 w-4 shrink-0 text-aiden-deep"
                            aria-hidden="true"
                          />
                          <span>
                            <a
                              href="/developers#mcp"
                              className="rounded font-semibold text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
                            >
                              Connect your AI assistant
                            </a>{" "}
                            <span className="text-muted-foreground">
                              (Claude, ChatGPT, Codex, Cursor)
                            </span>
                          </span>
                        </li>
                      </ul>
                      {custom ? (
                        <Button asChild variant="outline" className="mt-6">
                          <a href="mailto:support@aidwar.in?subject=AiDwar%20Enterprise">
                            Talk to us
                          </a>
                        </Button>
                      ) : (
                        <Button asChild className="mt-6" variant={featured ? "default" : "outline"}>
                          <Link to="/signup" search={{ ...preview, plan: plan.key } as never}>
                            Start free
                          </Link>
                        </Button>
                      )}
                    </div>
                  </Reveal>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="border-t border-border bg-surface">
        <div className="mx-auto w-full max-w-4xl px-[max(16px,env(safe-area-inset-left))] py-16 sm:py-20">
          <h2 className="m-0 font-display text-[clamp(1.5rem,3vw,2rem)] font-extrabold tracking-[-0.02em]">
            How message credits work
          </h2>
          <div className="mt-6 space-y-5 text-body leading-relaxed text-muted-foreground">
            <CreditsExplained gstRegistered={gstRegistered} />
          </div>
          <MessageRatesTable rates={rates} />
          <p className="m-0 mt-6 text-sm text-muted-foreground">
            Cancelling a plan or asking for a refund? See{" "}
            <Link
              to="/refunds"
              className="font-semibold text-aiden-deep underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
            >
              Refunds &amp; Cancellations
            </Link>
            .
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild>
              <Link to="/signup" search={preview as never}>
                Start free
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/terms">Read the terms</Link>
            </Button>
          </div>
        </div>
      </section>
    </NewSiteShell>
  );
}
