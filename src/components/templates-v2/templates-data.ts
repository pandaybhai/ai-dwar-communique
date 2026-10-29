import type { TemplateRow } from "@/lib/templates";

/**
 * Batch 47: the review states the Templates gallery groups a template into,
 * the Batch 41 page's rule: Pending covers both of Meta's review states;
 * paused or disabled ones show under All only.
 */
export type ReviewState = "APPROVED" | "PENDING" | "REJECTED" | "OTHER";

export function reviewStateOf(t: Pick<TemplateRow, "status">): ReviewState {
  const st = t.status.toUpperCase();
  if (st === "APPROVED") return "APPROVED";
  if (st === "REJECTED") return "REJECTED";
  if (st === "PENDING" || st === "IN_APPEAL") return "PENDING";
  return "OTHER";
}

export const TEMPLATE_STATUS_FILTERS: Array<{ key: ReviewState | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "APPROVED", label: "Approved" },
  { key: "PENDING", label: "In review" },
  { key: "REJECTED", label: "Rejected" },
];
