import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { CornerDownLeft, Search } from "lucide-react";
import { search, searchIndex, type SearchEntry } from "@/lib/developer-portal";
import { MethodBadge } from "./docs-ui";

/** Ctrl/Cmd+K search over every page, endpoint, event and guide (Batch 38 item 9). */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const entries = useMemo(() => searchIndex(), []);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const results: SearchEntry[] = useMemo(
    () =>
      query.trim()
        ? search(entries, query, 9)
        : entries
            .filter((e) =>
              ["Quickstart", "Send a template", "Webhooks", "Errors"].some((t) =>
                e.title.startsWith(t),
              ),
            )
            .slice(0, 6),
    [entries, query],
  );

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setCursor(0);
    const t = window.setTimeout(() => input.current?.focus(), 10);
    return () => window.clearTimeout(t);
  }, [open]);
  useEffect(() => setCursor(0), [query]);

  if (!open) return null;
  const go = (e: SearchEntry | undefined) => {
    if (!e) return;
    onClose();
    void navigate({ to: e.href as never });
  };
  return (
    <div
      className="docs-overlay fixed inset-0 z-[80] flex items-start justify-center px-4 pt-[12vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search the docs"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--d-border)] bg-[var(--d-surface)] shadow-[var(--d-shadow-lift)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-[var(--d-border)] px-4 focus-within:border-[var(--d-accent)]">
          <Search className="h-4 w-4 text-[var(--d-faint)]" aria-hidden="true" />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === "Enter") go(results[cursor]);
              else if (e.key === "Escape") onClose();
            }}
            placeholder="Search endpoints, events and guides…"
            aria-label="Search"
            aria-controls="docs-search-results"
            aria-activedescendant={results[cursor] ? `docs-result-${cursor}` : undefined}
            className="docs-search-input h-14 flex-1 bg-transparent text-[16px] text-[var(--d-fg)] outline-none placeholder:text-[var(--d-faint)]"
          />
          <kbd className="rounded-md border border-[var(--d-border)] px-1.5 py-0.5 text-[11px] text-[var(--d-muted)]">
            Esc
          </kbd>
        </div>
        <ul id="docs-search-results" role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
          {results.length ? (
            results.map((r, i) => (
              <li key={r.href} id={`docs-result-${i}`} role="option" aria-selected={i === cursor}>
                <button
                  type="button"
                  onMouseMove={() => setCursor(i)}
                  onClick={() => go(r)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left ${i === cursor ? "bg-[var(--d-accent-soft)]" : ""}`}
                >
                  {r.method ? (
                    <MethodBadge short method={r.method} className="w-12 text-center" />
                  ) : (
                    <span className="w-12 text-center text-[10.5px] font-semibold uppercase tracking-wide text-[var(--d-faint)]">
                      {r.kind}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-medium text-[var(--d-fg)]">
                      {r.title}
                    </span>
                    <span className="block truncate text-[12.5px] text-[var(--d-muted)]">
                      {r.path ?? r.text}
                    </span>
                  </span>
                  {i === cursor ? (
                    <CornerDownLeft className="h-4 w-4 text-[var(--d-faint)]" aria-hidden="true" />
                  ) : null}
                </button>
              </li>
            ))
          ) : (
            <li className="px-3 py-8 text-center text-[14px] text-[var(--d-muted)]">
              Nothing matches “{query}”.
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
