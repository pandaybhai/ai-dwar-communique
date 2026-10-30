import type { PaginationWords } from "@/components/data-pagination";

/**
 * Batch 57: words Aiden Workspace hands to shared Classic pieces it renders
 * (they take them as an optional prop and keep their own words in Classic).
 */
const n = (k: number) => k.toLocaleString("en-IN");

export const PAGINATION_WORDS: PaginationWords = {
  showing: (start, end, total) =>
    total === 0 ? "Nothing to show yet" : `Showing ${n(start)} to ${n(end)} of ${n(total)}`,
  previous: "Previous",
  next: "Next",
  page: (page, pages) => `Page ${n(page)} of ${n(pages)}`,
};
