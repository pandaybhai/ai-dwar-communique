import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/site-footer";
import { useSession } from "@/hooks/use-session";
import { SITE_TOKENS, useSitePreviewSearch, useSiteSurface } from "@/lib/new-site";

/**
 * Batch 50: the frame of a public page in the new look (switch `new_site`).
 * The wrapper carries the new design's tokens (SITE_TOKENS) and
 * `data-design="new"` for the `nd:` variants; the footer is the current
 * SiteFooter, unchanged, so every policy link and the company line stay word
 * for word.
 */
export function NewSiteShell({
  children,
  footer = true,
}: {
  children: ReactNode;
  footer?: boolean;
}) {
  useSiteSurface(true);
  return (
    <div
      data-design="new"
      data-site="new"
      style={SITE_TOKENS}
      className="flex min-h-screen flex-col overflow-x-clip bg-background font-sans text-foreground antialiased"
    >
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-[60] focus:rounded-lg focus:bg-card focus:px-3 focus:py-2 focus:shadow-lg"
      >
        Skip to content
      </a>
      <NewSiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      {footer ? <SiteFooter /> : null}
    </div>
  );
}

/** Wordmark, Pricing, Log in, Start free (or Go to dashboard when signed in). */
export function NewSiteHeader() {
  const { session, loading } = useSession();
  const preview = useSitePreviewSearch();
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/70 bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-[1200px] items-center gap-2 px-[max(16px,env(safe-area-inset-left))] sm:gap-4">
        <Link
          to="/"
          search={preview as never}
          className="font-display text-[1.375rem] font-extrabold tracking-[-0.02em] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
        >
          aidwar
        </Link>
        <span className="flex-1" />
        <nav aria-label="Main" className="flex items-center gap-1 sm:gap-2">
          <Link
            to="/pricing"
            search={preview as never}
            className="rounded-full px-3 py-2 text-[0.9375rem] font-semibold text-muted-foreground transition-colors duration-200 hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
            activeProps={{
              className: "bg-surface text-foreground shadow-xs",
              "aria-current": "page",
            }}
          >
            Pricing
          </Link>
          {loading ? (
            <span className="h-[39px] w-28 rounded-[11px] bg-muted" aria-hidden="true" />
          ) : session ? (
            <Button asChild>
              <Link to="/app">Go to dashboard</Link>
            </Button>
          ) : (
            <>
              <Link
                to="/login"
                search={preview as never}
                className="rounded-full px-3 py-2 text-[0.9375rem] font-semibold text-muted-foreground transition-colors duration-200 hover:bg-surface hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
              >
                Log in
              </Link>
              <Button asChild>
                <Link to="/signup" search={preview as never}>
                  Start free
                </Link>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
