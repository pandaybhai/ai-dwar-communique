import { useOrg } from "@/lib/org-context";
import { permissionDeniedReason, type PermissionKey } from "@/lib/permissions";

/**
 * Effective permissions for the active organization, resolved server-side the
 * same way public.has_permission resolves them. Always gate UI on a permission
 * key — never on a role name.
 */
export function usePermissions() {
  const { permissions, permissionOverrides, permissionsLoading, can, reloadPermissions } = useOrg();

  return {
    permissions,
    overrides: permissionOverrides,
    loading: permissionsLoading,
    can: (key: PermissionKey | string) => can(key),
    /** Convenience for disabled controls: returns undefined when allowed. */
    reasonFor: (key: PermissionKey | string, label: string) =>
      can(key) ? undefined : permissionDeniedReason(label),
    reload: reloadPermissions,
  };
}
