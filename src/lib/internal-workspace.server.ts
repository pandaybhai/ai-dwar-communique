import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch 58: an internal workspace — our own test and demo workspaces, which
 * are never billed.
 *
 * There is no second "not billed" mechanism. A workspace is not billed when
 * organizations.billing_enabled_at is NULL: that is what Admin > Billing
 * already reads for "Workspaces we don't bill", what runPlanBilling and
 * runDunning filter on, and what every debit function in the database checks
 * (billing_debit_message, trg_ai_runs_billing, billing_debit_ai_run,
 * trg_messages_meta_consume: "enabled_at is null → return false").
 *
 * The Super Admin switch only writes that column, plus a marker of who decided
 * it and why on organization_billing_settings.limits_override
 * (_internal_workspace — the same place _manual_flags keeps a person's
 * decisions), so the decision is visible, audit-logged and survives a plan
 * change: the live trigger org_plan_assigned_before stamps billing_enabled_at
 * again whenever plan_version_id changes, and assignPlan calls
 * reapplyInternalWorkspace right after, which clears it again.
 *
 * Usage keeps being recorded as before (messages.cost_amount, ai_runs,
 * ai_cost_totals); Admin > Billing shows the workspace's AI cost as our own
 * internal cost. Switching it off stamps billing_enabled_at = now(), so the
 * database's "debits only after billing_enabled_at" rule never back-charges
 * the internal months.
 */

export const INTERNAL_MARKER_KEY = "_internal_workspace";

export type InternalMarker = { at: string; by: string; reason: string };

/** Notices to the workspace about money it would owe: never for an internal one. */
export const INTERNAL_SKIPPED_NOTICE_KINDS: ReadonlySet<string> = new Set([
  "invoice_issued",
  "invoice_overdue",
  "payment_failed",
  "low_credits",
  "trial_ending",
]);

export function markerOf(limitsOverride: unknown): InternalMarker | null {
  const raw = (limitsOverride ?? {}) as Record<string, unknown>;
  const m = raw[INTERNAL_MARKER_KEY] as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object" || !m["at"]) return null;
  return { at: String(m["at"]), by: String(m["by"] ?? ""), reason: String(m["reason"] ?? "") };
}

/**
 * The ids among these that are marked internal. A failed read throws: a
 * caller about to chase money must not guess.
 */
export async function internalWorkspaceIds(
  supabase: SupabaseClient,
  organizationIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(organizationIds.filter(Boolean))];
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from("organization_billing_settings")
      .select("organization_id, limits_override")
      .in("organization_id", ids.slice(i, i + 200));
    if (error) throw new Error(`billing settings read failed: ${error.message}`);
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      if (markerOf(row["limits_override"])) out.add(String(row["organization_id"]));
    }
  }
  return out;
}

export async function isInternalWorkspace(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  return (await internalWorkspaceIds(supabase, [organizationId])).has(organizationId);
}

export async function readInternalWorkspace(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{
  internal: InternalMarker | null;
  billing_enabled_at: string | null;
  has_plan: boolean;
  active_mandate: boolean;
}> {
  const [{ data: settings }, { data: org }, { data: mandate }] = await Promise.all([
    supabase
      .from("organization_billing_settings")
      .select("limits_override")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    supabase
      .from("organizations")
      .select("billing_enabled_at, plan_version_id")
      .eq("id", organizationId)
      .maybeSingle(),
    supabase
      .from("subscriptions")
      .select("id")
      .eq("organization_id", organizationId)
      .in("status", ["authenticated", "active"])
      .limit(1)
      .maybeSingle(),
  ]);
  return {
    internal: markerOf((settings as Record<string, unknown> | null)?.["limits_override"]),
    billing_enabled_at: ((org as Record<string, unknown> | null)?.["billing_enabled_at"] as string | null) ?? null,
    has_plan: Boolean((org as Record<string, unknown> | null)?.["plan_version_id"]),
    active_mandate: Boolean(mandate),
  };
}

/**
 * The Super Admin switch "Internal workspace - don't bill". The caller has
 * checked super admin (and requireSuperAdmin is checked again by the route).
 */
export async function setInternalWorkspace(
  supabase: SupabaseClient,
  input: { organizationId: string; internal: boolean; reason: string; actorId: string },
): Promise<{ ok: true; internal: boolean; billing_enabled_at: string | null } | { error: string }> {
  const reason = input.reason.trim();
  if (input.internal && reason.length < 3) return { error: "Say why this workspace isn't billed." };
  if (!input.organizationId) return { error: "Which workspace?" };

  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id, plan_version_id, billing_enabled_at")
    .eq("id", input.organizationId)
    .maybeSingle();
  if (orgError || !org) return { error: "That workspace doesn't exist." };

  const { data: settings, error: settingsError } = await supabase
    .from("organization_billing_settings")
    .select("limits_override")
    .eq("organization_id", input.organizationId)
    .maybeSingle();
  if (settingsError) return { error: "We couldn't read this workspace's billing settings." };
  const overrides = {
    ...(((settings as Record<string, unknown> | null)?.["limits_override"] ?? {}) as Record<string, unknown>),
  };
  const before = markerOf(overrides);
  const at = new Date().toISOString();

  if (input.internal) {
    overrides[INTERNAL_MARKER_KEY] = { at, by: input.actorId, reason } satisfies InternalMarker;
  } else {
    delete overrides[INTERNAL_MARKER_KEY];
  }
  const { error: writeError } = await supabase.from("organization_billing_settings").upsert(
    { organization_id: input.organizationId, limits_override: overrides, updated_by: input.actorId },
    { onConflict: "organization_id" },
  );
  if (writeError) return { error: "We couldn't save that. Please try again." };

  // Off again: billing starts now (never back-charged), and only for a
  // workspace on a plan — the same rule the plan-assigned trigger follows.
  const billingEnabledAt = input.internal
    ? null
    : (org as Record<string, unknown>)["plan_version_id"]
      ? at
      : null;
  const { error: orgWriteError } = await supabase
    .from("organizations")
    .update({ billing_enabled_at: billingEnabledAt })
    .eq("id", input.organizationId);
  if (orgWriteError) return { error: "We couldn't switch billing for this workspace." };

  await supabase.from("activity_log").insert({
    organization_id: input.organizationId,
    user_id: input.actorId,
    action: input.internal ? "internal_workspace_on" : "internal_workspace_off",
    details: {
      reason: input.internal ? reason : reason || null,
      was_internal: Boolean(before),
      billing_enabled_at_before: (org as Record<string, unknown>)["billing_enabled_at"] ?? null,
      billing_enabled_at_after: billingEnabledAt,
    },
  });

  return { ok: true, internal: input.internal, billing_enabled_at: billingEnabledAt };
}

/**
 * After a plan change: the live trigger stamped billing_enabled_at again; an
 * internal workspace stays unbilled. A no-op for every other workspace.
 */
export async function reapplyInternalWorkspace(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  try {
    if (!(await isInternalWorkspace(supabase, organizationId))) return false;
    const { error } = await supabase
      .from("organizations")
      .update({ billing_enabled_at: null })
      .eq("id", organizationId)
      .not("billing_enabled_at", "is", null);
    if (error) {
      console.error("[internal-workspace] re-apply failed", organizationId, error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.error("[internal-workspace] re-apply failed", organizationId, String(error));
    return false;
  }
}
