import { useOrg } from "@/lib/org-context";

/**
 * Cross-organization views are always built against an explicit scope rather
 * than an implicit "every organization". Today a platform super admin resolves
 * to `all`; a partner tier can later resolve to its own client organizations
 * without any query being rewritten.
 */
export type AdminScope = { mode: "all" } | { mode: "organizations"; organizationIds: string[] };

export function useAdminScope(): AdminScope {
  const { isSuperAdmin, memberships } = useOrg();
  if (isSuperAdmin) return { mode: "all" };
  return { mode: "organizations", organizationIds: memberships.map((m) => m.organization.id) };
}

/**
 * Narrows a PostgREST query to the scope. `column` is the organization key on
 * the table being queried ("id" on organizations itself).
 */
export function applyScope<T extends { in: (column: string, values: string[]) => T }>(
  query: T,
  scope: AdminScope,
  column = "organization_id",
): T {
  if (scope.mode === "all") return query;
  // An empty scope must return nothing, never everything.
  return query.in(
    column,
    scope.organizationIds.length ? scope.organizationIds : ["00000000-0000-0000-0000-000000000000"],
  );
}

export function scopeLabel(scope: AdminScope): string {
  return scope.mode === "all"
    ? "All organizations"
    : `${scope.organizationIds.length} organization${scope.organizationIds.length === 1 ? "" : "s"}`;
}
