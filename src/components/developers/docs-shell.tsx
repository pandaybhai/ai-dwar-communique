import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { KeyRound, Menu, Moon, Search, Sun, X } from "lucide-react";
import { DOCS_ROOT, navigation, type NavItem } from "@/lib/developer-portal";
import { SiteFooter } from "@/components/site-footer";
import { DocLink, MethodBadge } from "./docs-ui";
import { SearchDialog } from "./search-dialog";

/**
 * The developer portal's frame (Batch 38 item 9): a top bar (search,
 * light/dark, Get your API key), the sidebar (a menu on small screens) and
 * the page. Ctrl/Cmd+K or / opens search.
 */

const THEME_KEY = "aidwar-docs-theme";

/** Runs before first paint (the layout's head), so a dark-mode reader never sees a flash of light. */
export const THEME_SCRIPT = `try{var t=localStorage.getItem("${THEME_KEY}");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";document.documentElement.dataset.docsTheme=t}catch(e){}`;

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState("light");
  useEffect(() => {
    setTheme(document.documentElement.dataset["docsTheme"] === "dark" ? "dark" : "light");
    return () => {
      delete document.documentElement.dataset["docsTheme"];
    };
  }, []);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset["docsTheme"] = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // private mode: this page only
    }
    setTheme(next);
  };
  return [theme, toggle];
}

function NavLink({
  item,
  current,
  onNavigate,
}: {
  item: NavItem;
  current: string;
  onNavigate: () => void;
}) {
  const active = current === item.href;
  return (
    <DocLink
      href={item.href}
      className={`docs-plain flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[14px] transition-colors ${
        active
          ? "bg-[var(--d-accent-soft)] font-semibold text-[var(--d-accent-strong)]"
          : "text-[var(--d-muted)] hover:bg-[var(--d-subtle)] hover:text-[var(--d-fg)]"
      }`}
    >
      {item.method ? (
        <MethodBadge short method={item.method} className="w-[38px] shrink-0 text-center" />
      ) : null}
      <span
        className={`min-w-0 truncate ${item.label.includes(".") && !item.method ? "docs-mono text-[13px]" : ""}`}
        onClick={onNavigate}
      >
        {item.label}
      </span>
    </DocLink>
  );
}

function Sidebar({ current, onNavigate }: { current: string; onNavigate: () => void }) {
  return (
    <nav aria-label="Docs" className="space-y-7 pb-16">
      {navigation().map((g) => (
        <div key={g.title}>
          <p className="mb-2 px-2.5 text-[11.5px] font-semibold uppercase tracking-[0.09em] text-[var(--d-faint)]">
            {g.title}
          </p>
          <ul className="space-y-0.5">
            {g.items.map((item) => (
              <li key={item.href}>
                <NavLink item={item} current={current} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
          {g.groups?.map((sub) => (
            <div key={sub.title} className="mt-4">
              <p className="mb-1 px-2.5 text-[12.5px] font-semibold text-[var(--d-fg)]">
                {sub.title}
              </p>
              <ul className="space-y-0.5">
                {sub.items.map((item) => (
                  <li key={item.href}>
                    <NavLink item={item} current={current} onNavigate={onNavigate} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </nav>
  );
}

export function DocsShell({ children }: { children: ReactNode }) {
  const current = useRouterState({
    select: (s) => s.location.pathname.replace(/\/+$/, "") || DOCS_ROOT,
  });
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const [theme, toggleTheme] = useTheme();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(input|textarea|select)$/i.test(
        (e.target as HTMLElement | null)?.tagName ?? "",
      );
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => setMenu(false), [current]);

  return (
    <div className="docs-root min-h-screen">
      <a
        href="#docs-main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[90] focus:rounded-md focus:bg-[var(--d-surface)] focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-50 border-b border-[var(--d-border)] bg-[color-mix(in_oklab,var(--d-bg)_86%,transparent)] backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
          <button
            type="button"
            className="-ml-1 rounded-md p-2 text-[var(--d-muted)] lg:hidden"
            aria-label={menu ? "Close the menu" : "Open the menu"}
            aria-expanded={menu}
            onClick={() => setMenu((m) => !m)}
          >
            {menu ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <Link to="/" className="text-[19px] font-bold tracking-tight text-[var(--d-fg)]">
            Ai<span className="text-[var(--d-accent)]">Dwar</span>
          </Link>
          <DocLink
            href={DOCS_ROOT}
            className="docs-plain rounded-md bg-[var(--d-accent-soft)] px-2 py-0.5 text-[12.5px] font-semibold text-[var(--d-accent-strong)]"
          >
            Developers
          </DocLink>
          <button
            type="button"
            onClick={() => setSearching(true)}
            className="mx-auto hidden h-10 w-full max-w-md items-center gap-2 rounded-xl border border-[var(--d-border)] bg-[var(--d-surface)] px-3 text-[14px] text-[var(--d-faint)] shadow-[var(--d-shadow)] transition-colors hover:border-[var(--d-border-strong)] sm:flex"
            aria-label="Search the docs (Ctrl K)"
          >
            <Search className="h-4 w-4" aria-hidden="true" />
            <span className="flex-1 text-left">Search the docs…</span>
            <kbd className="rounded-md border border-[var(--d-border)] px-1.5 py-0.5 text-[11px] text-[var(--d-muted)]">
              ⌘K
            </kbd>
          </button>
          <div className="ml-auto flex items-center gap-1 sm:ml-0">
            <button
              type="button"
              className="rounded-md p-2 text-[var(--d-muted)] sm:hidden"
              aria-label="Search the docs"
              onClick={() => setSearching(true)}
            >
              <Search className="h-5 w-5" />
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-md p-2 text-[var(--d-muted)] transition-colors hover:text-[var(--d-fg)]"
              aria-label={theme === "dark" ? "Use light mode" : "Use dark mode"}
            >
              {theme === "dark" ? (
                <Sun className="h-[18px] w-[18px]" />
              ) : (
                <Moon className="h-[18px] w-[18px]" />
              )}
            </button>
            <a
              href="/app/settings?tab=api"
              className="docs-plain ml-1 hidden items-center gap-1.5 rounded-lg bg-[var(--d-accent)] px-3 py-2 text-[13.5px] font-semibold text-[var(--primary-foreground)] shadow-sm transition-colors hover:bg-[var(--d-accent-strong)] md:inline-flex"
            >
              <KeyRound className="h-4 w-4" aria-hidden="true" />
              Get your API key
            </a>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-[1600px]">
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-[17rem] shrink-0 overflow-y-auto border-r border-[var(--d-border)] px-3 pt-8 lg:block">
          <Sidebar current={current} onNavigate={() => undefined} />
        </aside>
        {menu ? (
          <div className="fixed inset-0 top-16 z-40 overflow-y-auto bg-[var(--d-bg)] px-4 pt-6 lg:hidden">
            <Sidebar current={current} onNavigate={() => setMenu(false)} />
          </div>
        ) : null}
        <main id="docs-main" className="min-w-0 flex-1 px-5 pb-24 pt-10 sm:px-8 lg:px-12">
          {children}
        </main>
      </div>
      <SiteFooter />
      <SearchDialog open={searching} onClose={() => setSearching(false)} />
    </div>
  );
}
