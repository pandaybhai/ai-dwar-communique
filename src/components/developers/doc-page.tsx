import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, FlaskConical } from "lucide-react";
import {
  DOCS_ROOT,
  endpointPlans,
  navigation,
  pageMarkdown,
  type Page,
} from "@/lib/developer-portal";
import { API_ORIGIN } from "@/lib/public-api";
import { curlFor } from "@/lib/public-api-spec";
import { consoleEndpointFor, tryItHref } from "@/lib/public-api-console";
import { BlockView } from "./blocks";
import { CodePanel, CopyButton } from "./code-panel";
import { DocLink, Heading, MethodBadge } from "./docs-ui";

/**
 * One docs page (Batch 38 item 9): prose in the centre, and on wide screens a
 * sticky dark code panel on the right that follows the section in view —
 * the code changes as you scroll. On narrow screens each section's code sits
 * right after it.
 */

function flatNav(): Array<{ label: string; href: string }> {
  return navigation()
    .filter((g) => g.title !== "Downloads")
    .flatMap((g) => [...g.items, ...(g.groups ?? []).flatMap((x) => x.items)]);
}

export function DocPage({ page }: { page: Page }) {
  const withCode = page.sections.filter((s) => s.code);
  const [active, setActive] = useState(withCode[0]?.id ?? null);
  const refs = useRef(new Map<string, HTMLElement>());
  const markdown = useMemo(() => pageMarkdown(page), [page]);

  useEffect(() => {
    setActive(page.sections.find((s) => s.code)?.id ?? null);
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Map<string, number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        // The topmost section with code that is in the reading band.
        const visible = page.sections.filter((s) => s.code && (seen.get(`sec-${s.id}`) ?? 0) > 0);
        if (visible[0]) setActive(visible[0].id);
      },
      { rootMargin: "-20% 0px -55% 0px", threshold: [0, 0.01, 0.5, 1] },
    );
    for (const el of refs.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [page]);

  const activeSection = page.sections.find((s) => s.id === active) ?? withCode[0] ?? null;
  const activeGroup = activeSection?.code ?? null;
  const asideGroup = activeSection?.aside ?? null;
  const e = page.endpoint;
  const all = flatNav();
  const at = all.findIndex((x) => x.href === page.path);
  const prev = at > 0 ? all[at - 1] : null;
  const next = at >= 0 && at < all.length - 1 ? all[at + 1] : null;

  return (
    <div
      className={
        withCode.length
          ? "grid gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,34rem)]"
          : "max-w-[46rem]"
      }
    >
      <article className="min-w-0">
        <header className="docs-prose">
          {page.eyebrow ? (
            <p className="text-[13px] font-semibold uppercase tracking-[0.08em] text-[var(--d-accent-strong)]">
              {page.eyebrow}
            </p>
          ) : null}
          <h1
            className={`mt-2 text-[34px] font-bold leading-[1.15] tracking-tight text-[var(--d-fg)] sm:text-[40px] ${page.kind === "event" ? "docs-mono text-[28px] sm:text-[32px]" : ""}`}
          >
            {page.title}
          </h1>
          <p className="mt-3 text-[17px] leading-relaxed text-[var(--d-muted)] sm:text-[18px]">
            {page.description}
          </p>
          {e ? (
            <div className="mt-6 space-y-3">
              <div className="flex min-w-0 items-center gap-3 rounded-xl border border-[var(--d-border)] bg-[var(--d-surface)] py-2 pl-3 pr-2 shadow-[var(--d-shadow)]">
                <MethodBadge method={e.method} />
                <code className="docs-mono min-w-0 flex-1 truncate text-[14px] text-[var(--d-fg)]">
                  <span className="hidden text-[var(--d-faint)] sm:inline">{API_ORIGIN}</span>
                  {e.path}
                </code>
                <CopyButton
                  value={`${API_ORIGIN}${e.path}`}
                  label="Copy URL"
                  className="text-[var(--d-muted)] hover:bg-[var(--d-subtle)] hover:text-[var(--d-fg)]"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-[var(--d-muted)]">
                <span className="rounded-full border border-[var(--d-border)] px-2.5 py-1">
                  Bearer API key
                </span>
                <span className="rounded-full border border-[var(--d-border)] px-2.5 py-1">
                  {endpointPlans(e)}
                </span>
                <span className="rounded-full border border-[var(--d-border)] px-2.5 py-1">
                  Since {e.since ?? "v1.0"}
                </span>
              </div>
            </div>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <CopyButton
              value={markdown}
              label="Copy page as Markdown"
              showText
              className="border border-[var(--d-border)] bg-[var(--d-surface)] px-3 py-1.5 text-[13px] text-[var(--d-fg)] hover:border-[var(--d-border-strong)]"
            />
            {e ? (
              <>
                <CopyButton
                  value={curlFor(e)}
                  label="Copy as cURL"
                  showText
                  className="border border-[var(--d-border)] bg-[var(--d-surface)] px-3 py-1.5 text-[13px] text-[var(--d-fg)] hover:border-[var(--d-border-strong)]"
                />
                {consoleEndpointFor(e.id) ? (
                  <a
                    href={tryItHref(e.id)}
                    className="docs-plain inline-flex items-center gap-1.5 rounded-md bg-[var(--d-accent)] px-3 py-1.5 text-[13px] font-semibold text-[var(--primary-foreground)] shadow-sm transition-colors hover:bg-[var(--d-accent-strong)]"
                  >
                    <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
                    Try it
                  </a>
                ) : null}
              </>
            ) : null}
          </div>
        </header>

        <div className="mt-10 space-y-14">
          {page.sections.map((s) => (
            <section
              key={s.id}
              id={`sec-${s.id}`}
              ref={(el) => {
                if (el) refs.current.set(s.id, el);
                else refs.current.delete(s.id);
              }}
              className="scroll-mt-24"
            >
              <div className="docs-prose space-y-4">
                {s.title ? (
                  <Heading id={s.id} level={2}>
                    {s.title}
                  </Heading>
                ) : null}
                {s.blocks.map((b, i) => (
                  <BlockView key={i} block={b} />
                ))}
              </div>
              {s.code ? (
                <div className="mt-5 xl:hidden">
                  <CodePanel group={s.code} maxHeight="28rem" />
                </div>
              ) : null}
            </section>
          ))}
        </div>

        <nav
          aria-label="Previous and next page"
          className="mt-16 grid gap-3 border-t border-[var(--d-border)] pt-6 sm:grid-cols-2"
        >
          {prev ? (
            <DocLink href={prev.href} className="docs-card docs-plain group p-4">
              <span className="flex items-center gap-1 text-[12.5px] text-[var(--d-muted)]">
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Previous
              </span>
              <span className="mt-1 block font-semibold text-[var(--d-fg)]">{prev.label}</span>
            </DocLink>
          ) : (
            <span />
          )}
          {next ? (
            <DocLink href={next.href} className="docs-card docs-plain group p-4 text-right">
              <span className="flex items-center justify-end gap-1 text-[12.5px] text-[var(--d-muted)]">
                Next
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
              <span className="mt-1 block font-semibold text-[var(--d-fg)]">{next.label}</span>
            </DocLink>
          ) : null}
        </nav>
      </article>

      {activeGroup ? (
        <aside className="hidden xl:block" aria-label="Code">
          <div className="sticky top-[5.5rem]">
            <CodePanel
              key={active ?? "first"}
              group={activeGroup}
              fade
              maxHeight={asideGroup ? "calc(62vh - 6rem)" : "calc(100vh - 8rem)"}
            />
            {asideGroup ? (
              <CodePanel
                key={`${active ?? "first"}-aside`}
                group={asideGroup}
                fade
                className="mt-4"
                maxHeight="calc(38vh - 4rem)"
              />
            ) : null}
            {page.path !== DOCS_ROOT ? (
              <p className="mt-3 text-[12px] text-[var(--d-faint)]">
                The code follows the section you're reading.
              </p>
            ) : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
