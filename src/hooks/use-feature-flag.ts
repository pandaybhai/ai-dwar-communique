import { useOrg } from "@/lib/org-context";

/**
 * Resolves a feature flag for the current organization:
 * global default from feature_flags, overridden by
 * organization_feature_overrides when a row exists.
 */
export function useFeatureFlag(key: string): { enabled: boolean; loading: boolean } {
  const { isFeatureEnabled, flagsLoading } = useOrg();
  return { enabled: isFeatureEnabled(key), loading: flagsLoading };
}
