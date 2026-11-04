import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MANUAL_SOURCE,
  PLAN_SOURCE,
  featureForFlag,
  isManualOverride,
  manualFlagKeys,
  missingSourceColumn,
  planValueFor,
  type OverrideRow,
} from "@/lib/feature-ownership";

/**
 * Batch 63 (A): the writes behind "who owns a feature switch"
 * (feature-ownership.ts). Super Admin's switches and the AI-assistants
 * switch go through writeManualOverride; "Reset to plan" through
 * resetOverrideToPlan. The plan sync (applyPlanFeatures) asks
 * planOwnedFeatureRows which rows it may write.
 */

/** A workspace's override rows with their source (without it before 20261350). */
export async function readOverrideRows(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<OverrideRow[]> {
  const first = await supabase
    .from("organization_feature_overrides")
    .select("flag_key, enabled, source")
    .eq("organization_id", organizationId);
  if (!first.error) return ((first.data ?? []) as OverrideRow[]).map(asRow);
  if (!missingSourceColumn(first.error)) throw new Error(first.error.message);
  const plain = await supabase
    .from("organization_feature_overrides")
    .select("flag_key, enabled")
    .eq("organization_id", organizationId);
  if (plain.error) throw new Error(plain.error.message);
  return ((plain.data ?? []) as OverrideRow[]).map(asRow);
}

function asRow(r: OverrideRow): OverrideRow {
  return { flag_key: String(r.flag_key), enabled: r.enabled === true, source: r.source ?? null };
}

async function readManualFlags(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await supabase
    .from("organization_billing_settings")
    .select("limits_override")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const limits = ((data as { limits_override?: Record<string, unknown> | null } | null)
    ?.limits_override ?? {}) as Record<string, unknown>;
  return (limits["_manual_flags"] ?? {}) as Record<string, unknown>;
}

/**
 * The flag keys the plan sync must leave alone: rows marked 'manual' plus
 * everything in _manual_flags. A failed read throws — the caller then writes
 * nothing rather than overwrite a switch it couldn't check.
 */
export async function manualOverrideKeys(
  supabase: SupabaseClient,
  organizationId: string,
  manualFlags: Record<string, unknown>,
): Promise<{ rows: OverrideRow[]; manual: Set<string> }> {
  const rows = await readOverrideRows(supabase, organizationId);
  return { rows, manual: manualFlagKeys(rows, manualFlags) };
}

/** Upsert one row, with `source` when the column exists. */
async function upsertRow(
  supabase: SupabaseClient,
  row: { organization_id: string; flag_key: string; enabled: boolean; source: string },
): Promise<{ error: string | null }> {
  const withSource = await supabase
    .from("organization_feature_overrides")
    .upsert(row, { onConflict: "organization_id,flag_key" });
  if (!withSource.error) return { error: null };
  if (!missingSourceColumn(withSource.error)) return { error: withSource.error.message };
  const { source: _source, ...plain } = row;
  const without = await supabase
    .from("organization_feature_overrides")
    .upsert(plain, { onConflict: "organization_id,flag_key" });
  return { error: without.error ? without.error.message : null };
}

/** Writes limits_override._manual_flags[featureKey] (value) or removes it (undefined). */
async function setManualFlag(
  supabase: SupabaseClient,
  organizationId: string,
  featureKey: string,
  value: boolean | undefined,
  actorId: string | null,
): Promise<void> {
  const { data } = await supabase
    .from("organization_billing_settings")
    .select("limits_override")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const limits = {
    ...(((data as { limits_override?: Record<string, unknown> | null } | null)?.limits_override ??
      {}) as Record<string, unknown>),
  };
  const manual = { ...((limits["_manual_flags"] ?? {}) as Record<string, unknown>) };
  if (value === undefined) {
    if (!(featureKey in manual)) return;
    delete manual[featureKey];
  } else {
    if (manual[featureKey] === value) return;
    manual[featureKey] = value;
  }
  limits["_manual_flags"] = manual;
  await supabase
    .from("organization_billing_settings")
    .upsert(
      {
        organization_id: organizationId,
        limits_override: limits,
        ...(actorId ? { updated_by: actorId } : {}),
      },
      { onConflict: "organization_id" },
    );
}

export type OwnershipResult =
  | { ok: true; enabled: boolean | null; source: "manual" | "plan" | "default" }
  | { ok: false; error: string };

/**
 * A person sets a switch. The row is marked 'manual' and, for a registry
 * feature set by Super Admin, _manual_flags records it too (so the plan sync
 * keeps it even before 20261350 is applied). `recordManualFlag: false` is the
 * workspace's own AI-assistants switch: _manual_flags.mcp means "AiDwar
 * support switched it off" there (mcp-workspace.server.ts), so only the
 * column marks it.
 */
export async function writeManualOverride(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    flagKey: string;
    enabled: boolean;
    actorId: string | null;
    recordManualFlag?: boolean;
    via: string;
    /** The caller writes its own activity line (setMcpAccess's mcp_access_changed). */
    quiet?: boolean;
  },
): Promise<OwnershipResult> {
  const { error } = await upsertRow(supabase, {
    organization_id: args.organizationId,
    flag_key: args.flagKey,
    enabled: args.enabled,
    source: MANUAL_SOURCE,
  });
  if (error) return { ok: false, error: "We couldn't change that setting. Please try again." };
  const feature = featureForFlag(args.flagKey);
  if (feature && args.recordManualFlag !== false) {
    await setManualFlag(supabase, args.organizationId, feature.key, args.enabled, args.actorId);
  }
  if (args.quiet) return { ok: true, enabled: args.enabled, source: "manual" };
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(supabase, args.organizationId, args.actorId, "feature_override_set", {
    flag_key: args.flagKey,
    enabled: args.enabled,
    source: MANUAL_SOURCE,
    via: args.via,
  });
  return { ok: true, enabled: args.enabled, source: "manual" };
}

/** The workspace's current plan features (null: no plan). */
async function planFeaturesOf(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string[] | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("plan_version_id, plan_versions(features)")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = (data ?? null) as {
    plan_version_id?: string | null;
    plan_versions?: { features?: string[] | null } | null;
  } | null;
  if (!row?.plan_version_id) return null;
  return (row.plan_versions?.features ?? []) as string[];
}

/**
 * "Reset to plan": the switch goes back to what the plan says (the row is
 * written as the plan's, as applyPlanFeatures would write it) and the
 * by-hand record is removed, so later plan changes manage it again. With no
 * plan the row is removed and the global default applies.
 */
export async function resetOverrideToPlan(
  supabase: SupabaseClient,
  args: { organizationId: string; flagKey: string; actorId: string | null },
): Promise<OwnershipResult> {
  // Only registry features are written by the plan sync; any other flag's
  // reset removes the row, as Super Admin > Flags' Reset always did.
  const planFeatures = featureForFlag(args.flagKey)
    ? await planFeaturesOf(supabase, args.organizationId)
    : null;
  const value = planValueFor(args.flagKey, planFeatures);
  if (value === null) {
    const { error } = await supabase
      .from("organization_feature_overrides")
      .delete()
      .eq("organization_id", args.organizationId)
      .eq("flag_key", args.flagKey);
    if (error) return { ok: false, error: "We couldn't reset that setting. Please try again." };
  } else {
    const { error } = await upsertRow(supabase, {
      organization_id: args.organizationId,
      flag_key: args.flagKey,
      enabled: value,
      source: PLAN_SOURCE,
    });
    if (error) return { ok: false, error: "We couldn't reset that setting. Please try again." };
  }
  const feature = featureForFlag(args.flagKey);
  await setManualFlag(
    supabase,
    args.organizationId,
    feature?.key ?? args.flagKey,
    undefined,
    args.actorId,
  );
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(
    supabase,
    args.organizationId,
    args.actorId,
    "feature_override_reset_to_plan",
    {
      flag_key: args.flagKey,
      enabled: value,
    },
  );
  return { ok: true, enabled: value, source: value === null ? "default" : "plan" };
}

/** Whether one switch is a person's, read fresh (rows + _manual_flags). */
export async function overrideIsManual(
  supabase: SupabaseClient,
  organizationId: string,
  flagKey: string,
): Promise<boolean> {
  const [rows, manualFlags] = await Promise.all([
    readOverrideRows(supabase, organizationId),
    readManualFlags(supabase, organizationId),
  ]);
  return isManualOverride(rows.find((r) => r.flag_key === flagKey) ?? null, manualFlags, flagKey);
}

export { readManualFlags };
