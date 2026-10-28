/**
 * Batch 35: a deleted chat flow (Flows v2) — soft delete, the website-source
 * way: flows.config.deleted_at is set, the flow is hidden everywhere, never
 * starts again and its running conversations are ended silently. It can be
 * restored for FLOW_RESTORE_DAYS days; then the daily flow-scan purges its
 * definition (purge_deleted_flows). Shared by the browser and the server.
 */

export const FLOW_RESTORE_DAYS = 30;
const DAY_MS = 86_400_000;

type WithConfig = { config?: Record<string, unknown> | null } | null | undefined;

/** When the flow was deleted, or null. A row without config (or no row) is a live flow. */
export function flowDeletedAt(flow: WithConfig): string | null {
  const at = flow?.config?.["deleted_at"];
  return typeof at === "string" && at ? at : null;
}

export function isFlowDeleted(flow: WithConfig): boolean {
  return flowDeletedAt(flow) !== null;
}

/** Whole days left to restore it (0 = can't any more). */
export function restoreDaysLeft(flow: WithConfig, now: Date = new Date()): number {
  const at = flowDeletedAt(flow);
  if (!at || flow?.config?.["purged_at"]) return 0;
  const left = Date.parse(at) + FLOW_RESTORE_DAYS * DAY_MS - now.getTime();
  return left > 0 ? Math.ceil(left / DAY_MS) : 0;
}

/** The confirm dialog's words for how many conversations are in the flow now. */
export function activeRunsLine(n: number): string {
  if (n === 0) return "No conversations are in this flow right now.";
  return `${n} conversation${n === 1 ? " is" : "s are"} in this flow right now. ${n === 1 ? "It" : "They"} will end quietly — the customer${n === 1 ? " gets" : "s get"} no message.`;
}
