import { createContext, useContext } from "react";
import { Link } from "@tanstack/react-router";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import type { Section, SectionTab } from "./sections";

/**
 * Batch 44: the section the new shell is showing (Campaigns, Customers …) and
 * its active sub-tab. Only the new shell provides it, so PageHeader and the
 * pages that read it render exactly as before in the classic look.
 */
export type ShellSectionState = {
  section: Section | null;
  activeTab: SectionTab | null;
  /** Counts next to a tab, by tab key (Aiden's unanswered questions). */
  counts: Record<string, number>;
};

export const ShellSectionContext = createContext<ShellSectionState | null>(null);

/** The new shell's section state, or null in the classic look. */
export function useShellSection(): ShellSectionState | null {
  return useContext(ShellSectionContext);
}

/** The section's sub-tabs as pills (the preview's .tabs2); nothing when it has fewer than two. */
export function SectionTabs({ className }: { className?: string }) {
  const state = useShellSection();
  const section = state?.section;
  if (!section || section.tabs.length < 2) return null;
  return (
    <nav aria-label={`${section.label} pages`} className={cn("flex flex-wrap gap-1", className)}>
      {section.tabs.map((t) => {
        const on = state.activeTab?.key === t.key;
        const count = state.counts[t.key] ?? 0;
        return (
          <Link
            key={t.key}
            to={t.to as never}
            search={(t.search ?? {}) as never}
            aria-current={on ? "page" : undefined}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-full px-3.5 py-[7px] text-sm font-semibold transition-colors duration-200",
              on
                ? "text-aiden-deep"
                : "text-muted-foreground hover:bg-surface hover:text-foreground",
            )}
          >
            {on ? (
              // Batch 57: the selected pill slides between sub-tabs.
              <motion.span
                layoutId="nd-tab-pill"
                aria-hidden="true"
                className="absolute inset-0 rounded-full bg-aiden-soft"
                transition={{ duration: 0.35, ease: [0.2, 0.8, 0.2, 1] }}
              />
            ) : null}
            <span className="relative">{t.label}</span>
            {count > 0 ? (
              <span className="tabular relative inline-grid h-5 min-w-5 place-items-center rounded-full bg-gold px-1.5 text-xs font-bold text-gold-ink">
                <span aria-hidden="true">{count > 99 ? "99+" : count}</span>
                <span className="sr-only">({count} waiting)</span>
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
