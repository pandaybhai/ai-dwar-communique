/**
 * Batch 63 (A): who owns a workspace's feature switch.
 *
 * A row in organization_feature_overrides is either the plan's (written by
 * the plan sync, applyPlanFeatures in billing.server.ts) or a person's
 * (Super Admin's feature switches, the workspace's own AI-assistants switch).
 * A person's row survives every plan change: assign_plan, a trial reset,
 * resync_plan_features and a plan purchase never write it.
 *
 * A row is a person's ("manual") when either
 *  - its `source` column is 'manual' (20261350_batch63.sql; until that file
 *    is applied the column isn't there and every row reads as the plan's), or
 *  - the feature is in limits_override._manual_flags (Batch 18's record,
 *    written by setFeatureOverride and, from Batch 63, by every Super Admin
 *    switch), keyed by the registry key ("mcp", not "mcp_access").
 *
 * Client-safe: no server imports.
 */
import { FEATURES } from "@/lib/feature-registry";

export const MANUAL_SOURCE = "manual";
export const PLAN_SOURCE = "plan";

export type OverrideRow = { flag_key: string; enabled: boolean; source?: string | null };

/** The registry entry for a flag key (or a registry key), if it is a feature. */
export function featureForFlag(flagKey: string) {
  return FEATURES.find((f) => f.flag_key === flagKey || f.key === flagKey) ?? null;
}

/** True when a person set this switch (it must survive a plan change). */
export function isManualOverride(
  row: Pick<OverrideRow, "flag_key" | "source"> | null | undefined,
  manualFlags: Record<string, unknown> | null | undefined,
  flagKey?: string,
): boolean {
  const key = row?.flag_key ?? flagKey ?? "";
  if (row?.source === MANUAL_SOURCE) return true;
  const feature = featureForFlag(key);
  const manual = manualFlags ?? {};
  return Boolean(feature && feature.key in manual) || key in manual;
}

/** Flag keys of every switch a person set, from the rows and _manual_flags. */
export function manualFlagKeys(
  rows: Array<Pick<OverrideRow, "flag_key" | "source">>,
  manualFlags: Record<string, unknown> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) if (isManualOverride(r, manualFlags)) out.add(r.flag_key);
  for (const key of Object.keys(manualFlags ?? {})) {
    const feature = featureForFlag(key);
    out.add(feature ? feature.flag_key : key);
  }
  return out;
}

/**
 * The column 20261350 adds isn't there yet (42703 from Postgres, PGRST204 /
 * a "source" schema-cache message from PostgREST). The caller then reads or
 * writes without it, exactly as before.
 */
export function missingSourceColumn(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return (
    /\bsource\b/.test(String(error.message ?? "")) &&
    /column|schema cache/i.test(String(error.message ?? ""))
  );
}

/** What the plan alone says for one feature (null: no plan, so the global default applies). */
export function planValueFor(flagKey: string, planFeatures: string[] | null): boolean | null {
  if (!planFeatures) return null;
  const feature = featureForFlag(flagKey);
  if (feature?.key === "billing") return true;
  return planFeatures.includes(flagKey) || Boolean(feature && planFeatures.includes(feature.key));
}

/** The one line Super Admin reads under a switch. */
export function ownershipLabel(args: {
  hasRow: boolean;
  manual: boolean;
  enabled: boolean;
  fromPlan: boolean | null;
  globalDefault: boolean;
}): string {
  const baseline = args.fromPlan !== null ? args.fromPlan : args.globalDefault;
  if (args.manual) {
    return `Set by hand — ${args.enabled ? "on" : "off"}${
      args.enabled === baseline
        ? ""
        : ` (differs from ${args.fromPlan !== null ? "plan" : "default"})`
    } · kept on plan changes`;
  }
  if (args.fromPlan !== null) return `From plan — ${args.enabled ? "on" : "off"}`;
  if (args.hasRow) return `From plan sync — ${args.enabled ? "on" : "off"}`;
  return `Global default — ${args.globalDefault ? "on" : "off"}`;
}
