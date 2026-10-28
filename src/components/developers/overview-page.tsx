import { ArrowRight, Download, KeyRound } from "lucide-react";
import type { ClientRate, MessageCategory } from "@/lib/billing";
import { DOCS_ROOT, pageById } from "@/lib/developer-portal";
import { POSTMAN_PATH } from "@/lib/public-api-spec";
import { OPENAPI_PATH } from "@/lib/public-api-openapi";
import { API_PLANS, PLAN_LABELS } from "@/lib/public-api-plans";
import { BlockView } from "./blocks";
import { DocLink, Heading } from "./docs-ui";
import { HeroPlayground } from "./hero-playground";

/** /developers (Batch 38 item 9): what the API does, in plain words first. */

const RATE_LABELS: Record<MessageCategory, string> = {
  marketing: "Marketing (offers, announcements)",
  utility: "Utility (invoices, order updates)",
  authentication: "Authentication (one-time codes)",
  service: "Replies inside the 24-hour window",
};
const RATE_ORDER: MessageCategory[] = ["utility", "marketing", "authentication", "service"];

function price(rate: number, currency: string): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency || "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(rate);
}

function PriceTable({ rates }: { rates: ClientRate[] }) {
  const byCategory = new Map(rates.map((r) => [r.category, r]));
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--d-border)] bg-[var(--d-surface)]">
      <table className="w-full text-left text-[14.5px]" aria-label="Price per message (India)">
        <thead>
          <tr className="border-b border-[var(--d-border)] bg-[var(--d-subtle)]">
            <th
              scope="col"
              className="px-4 py-2.5 text-[12px] font-semibold uppercase tracking-wide text-[var(--d-muted)]"
            >
              Message
            </th>
            <th
              scope="col"
              className="px-4 py-2.5 text-right text-[12px] font-semibold uppercase tracking-wide text-[var(--d-muted)]"
            >
              Per message (India)
            </th>
          </tr>
        </thead>
        <tbody>
          {RATE_ORDER.map((c) => {
            const r = byCategory.get(c);
            return (
              <tr key={c} className="border-b border-[var(--d-border)] last:border-0">
                <td className="px-4 py-3 text-[var(--d-fg)]">{RATE_LABELS[c]}</td>
                <td className="px-4 py-3 text-right tabular-nums text-[var(--d-fg)]">
                  {r && r.rate !== null ? price(r.rate, r.currency) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function OverviewPage({ rates }: { rates: ClientRate[] }) {
  const page = pageById("overview");
  const section = (id: string) => page.sections.find((s) => s.id === id)!;
  return (
    <div className="mx-auto max-w-[1180px]">
      <section aria-labelledby="hero-title" className="pb-16">
        <HeroPlayground
          intro={
            <>
              <p className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--d-accent-strong)]">
                AiDwar API · v1.2
              </p>
              <h1
                id="hero-title"
                className="mt-3 text-[38px] font-bold leading-[1.06] tracking-tight text-[var(--d-fg)] sm:text-[50px]"
              >
                WhatsApp, from your own software.
              </h1>
              <p className="mt-5 max-w-[36rem] text-[18px] leading-relaxed text-[var(--d-muted)]">
                Send invoices and order updates, reply to customers and run campaigns with one
                simple API — from the WhatsApp number you already use in AiDwar.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <a
                  href="/app/settings?tab=api"
                  className="docs-plain inline-flex items-center gap-2 rounded-xl bg-[var(--d-accent)] px-5 py-3 text-[15px] font-semibold text-[var(--primary-foreground)] shadow-[var(--d-shadow)] transition-colors hover:bg-[var(--d-accent-strong)]"
                >
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                  Get your API key
                </a>
                <DocLink
                  href={`${DOCS_ROOT}/quickstart`}
                  className="docs-plain group inline-flex items-center gap-2 rounded-xl border border-[var(--d-border-strong)] bg-[var(--d-surface)] px-5 py-3 text-[15px] font-semibold text-[var(--d-fg)] transition-colors hover:border-[var(--d-accent)]"
                >
                  Quickstart — 5 minutes
                  <ArrowRight
                    className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                    aria-hidden="true"
                  />
                </DocLink>
              </div>
            </>
          }
        />
      </section>

      <section
        className="space-y-6 border-t border-[var(--d-border)] py-14"
        aria-labelledby="what-you-can-do"
      >
        <Heading id="what-you-can-do" level={2}>
          What you can do
        </Heading>
        {section("what-you-can-do").blocks.map((b, i) => (
          <BlockView key={i} block={b} />
        ))}
      </section>

      <div className="grid gap-12 border-t border-[var(--d-border)] py-14 lg:grid-cols-2">
        <section className="docs-prose space-y-4" aria-labelledby="who-its-for">
          <Heading id="who-its-for" level={2}>
            Who it's for
          </Heading>
          {section("who-its-for").blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}
        </section>
        <div className="space-y-10">
          <section className="docs-prose space-y-4" aria-labelledby="plan">
            <Heading id="plan" level={2}>
              Plan needed
            </Heading>
            <div className="flex flex-wrap gap-2">
              {API_PLANS.map((p) => (
                <span
                  key={p}
                  className="rounded-full border border-[color-mix(in_oklab,var(--d-accent)_40%,transparent)] bg-[var(--d-accent-soft)] px-3 py-1 text-[14px] font-semibold text-[var(--d-accent-strong)]"
                >
                  {PLAN_LABELS[p]}
                </span>
              ))}
            </div>
            {section("plan").blocks.map((b, i) => (
              <BlockView key={i} block={b} />
            ))}
          </section>
          <section className="docs-prose space-y-4" aria-labelledby="pricing">
            <Heading id="pricing" level={2}>
              What a message costs
            </Heading>
            {section("pricing").blocks.map((b, i) => (
              <BlockView key={i} block={b} />
            ))}
            {rates.some((r) => r.rate !== null) ? <PriceTable rates={rates} /> : null}
          </section>
        </div>
      </div>

      <section
        className="space-y-5 border-t border-[var(--d-border)] py-14"
        aria-labelledby="start"
      >
        <Heading id="start" level={2}>
          Start
        </Heading>
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
          {/* The page's links; its downloads sentence is the card beside them. */}
          <BlockView block={section("start").blocks[0]!} />
          <div className="docs-card self-start p-5">
            <p className="font-semibold text-[var(--d-fg)]">Downloads</p>
            <p className="mt-1 text-[14px] text-[var(--d-muted)]">
              Generated from the same description as these pages, so they are always current.
            </p>
            <div className="mt-4 grid gap-2">
              <a
                href={POSTMAN_PATH}
                download
                className="docs-plain inline-flex items-center gap-2 text-[14px] font-medium text-[var(--d-accent-strong)] hover:underline"
              >
                <Download className="h-4 w-4" aria-hidden="true" /> Postman collection
              </a>
              <a
                href={OPENAPI_PATH}
                className="docs-plain inline-flex items-center gap-2 text-[14px] font-medium text-[var(--d-accent-strong)] hover:underline"
              >
                <Download className="h-4 w-4" aria-hidden="true" /> OpenAPI 3.1 (JSON)
              </a>
              <a
                href="/llms.txt"
                className="docs-plain inline-flex items-center gap-2 text-[14px] font-medium text-[var(--d-accent-strong)] hover:underline"
              >
                <Download className="h-4 w-4" aria-hidden="true" /> llms.txt for AI coding tools
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
