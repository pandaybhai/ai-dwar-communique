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

/**
 * Batch 51: a template deleted from the gallery (deleted_at, 20261250) while it
 * still carries the DELETED mark (Paused). One recreated later under the same
 * name comes back as In review / Approved and shows again. Before the column
 * exists deleted_at is undefined and nothing is hidden.
 */
export function isDeletedTemplate(t: Pick<TemplateRow, "status"> & { deleted_at?: string | null }) {
  return Boolean(t.deleted_at) && reviewStateOf(t) === "OTHER";
}

/** The delete request (the Templates route's own "delete" action). */
export function deleteTemplateRequest(organizationId: string, templateId: string) {
  return { action: "delete", organization_id: organizationId, template_id: templateId };
}
