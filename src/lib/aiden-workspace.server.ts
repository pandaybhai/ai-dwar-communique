import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DESIGN_SWITCHED_EVENT,
  modeUnlocks,
  superAdminOverrideFrom,
  type DesignCounts,
  type DesignName,
} from "@/lib/aiden-workspace";

/**
 * Batch 53: the server half of Aiden Workspace (src/lib/aiden-workspace.ts).
 * Everything here tolerates 20261270 not being applied: a missing column,
 * table or function reads as "nothing recorded" and a write is skipped,
 * so the app keeps today's behaviour until the file is applied.
 */

/**
 * The unlock: the first time Aiden is switched on (draft or replying) the
 * workspace is stamped, once. Called after a successful mode change on the
 * two server paths that switch Aiden on (setAgentMode, switchAgentOn). It
 * never throws and never changes the mode change's answer; the function
 * itself checks Aiden really is on and only stamps an empty column.
 */
export async function stampAidenWorkspaceUnlock(
  supabase: SupabaseClient,
  organizationId: string,
  mode: string,
): Promise<void> {
  if (!modeUnlocks(mode)) return;
  try {
    const { error } = await supabase.rpc("aiden_workspace_stamp_unlock", { p_org: organizationId });
    if (error && error.code !== "PGRST202") {
      console.log(JSON.stringify({ scope: "aiden_workspace", stage: "unlock_failed", error: error.message }));
    }
  } catch {
    // Recording the unlock must never touch Aiden's own switch.
  }
}

export type DesignState = {
  superAdminOverride: boolean | null;
  choice: DesignName | null;
  unlockedAt: string | null;
  introSeenAt: string | null;
};

const asDesign = (v: unknown): DesignName | null =>
  v === "classic" || v === "aiden_workspace" ? v : null;

/** What the resolver needs beyond the client's flags, for one member. */
export async function loadDesignState(
  service: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<DesignState> {
  const [override, billing, org, pref] = await Promise.all([
    service
      .from("organization_feature_overrides")
      .select("enabled")
      .eq("organization_id", organizationId)
      .eq("flag_key", "new_design")
      .maybeSingle(),
    service
      .from("organization_billing_settings")
      .select("limits_override")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    service
      .from("organizations")
      .select("aiden_workspace_unlocked_at")
      .eq("id", organizationId)
      .maybeSingle(),
    service
      .from("user_design_preferences")
      .select("design, intro_seen_at")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  const row = override.data as { enabled?: boolean } | null;
  const limits = ((billing.data as { limits_override?: Record<string, unknown> } | null)?.limits_override ??
    {}) as Record<string, unknown>;
  const manual = (limits["_manual_flags"] ?? {}) as Record<string, unknown>;
  const manualFlag = typeof manual["new_design"] === "boolean" ? (manual["new_design"] as boolean) : null;
  const p = (pref.error ? null : pref.data) as { design?: unknown; intro_seen_at?: string | null } | null;
  const o = (org.error ? null : org.data) as { aiden_workspace_unlocked_at?: string | null } | null;
  return {
    superAdminOverride: superAdminOverrideFrom(typeof row?.enabled === "boolean" ? row.enabled : null, manualFlag),
    choice: asDesign(p?.design),
    unlockedAt: o?.aiden_workspace_unlocked_at ?? null,
    introSeenAt: p?.intro_seen_at ?? null,
  };
}

/**
 * The person's choice, remembered on every device, and design.switched in
 * the analytics events (from, to, who, which workspace, the page).
 */
export async function saveDesignChoice(
  service: SupabaseClient,
  args: { organizationId: string; userId: string; design: DesignName; from: DesignName; path: string | null },
): Promise<{ saved: boolean }> {
  const { error } = await service
    .from("user_design_preferences")
    .upsert(
      { user_id: args.userId, design: args.design, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  const { emitEvent } = await import("@/lib/events.server");
  await emitEvent(service, DESIGN_SWITCHED_EVENT, {
    organizationId: args.organizationId,
    actorUserId: args.userId,
    entityType: "user",
    entityId: args.userId,
    properties: { from: args.from, to: args.design, path: args.path, saved: !error },
  });
  return { saved: !error };
}

export async function markIntroSeen(service: SupabaseClient, userId: string): Promise<{ saved: boolean }> {
  const now = new Date().toISOString();
  const { error } = await service
    .from("user_design_preferences")
    .upsert({ user_id: userId, intro_seen_at: now, updated_at: now }, { onConflict: "user_id" });
  return { saved: !error };
}

const PAGE = 1000;

/** Super Admin: who chose which design, and the switches of the last N days. */
export async function designCounts(service: SupabaseClient, days = 30): Promise<DesignCounts> {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const [classic, aw, unlocked] = await Promise.all([
    service.from("user_design_preferences").select("user_id", { count: "exact", head: true }).eq("design", "classic"),
    service
      .from("user_design_preferences")
      .select("user_id", { count: "exact", head: true })
      .eq("design", "aiden_workspace"),
    service
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .not("aiden_workspace_unlocked_at", "is", null),
  ]);
  let toClassic = 0;
  let toAw = 0;
  const people = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await service
      .from("analytics_events")
      .select("actor_user_id, properties")
      .eq("event_type", DESIGN_SWITCHED_EVENT)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error || !data) break;
    for (const r of data as Array<{ actor_user_id: string | null; properties: Record<string, unknown> | null }>) {
      if (r.properties?.["to"] === "classic") toClassic += 1;
      else if (r.properties?.["to"] === "aiden_workspace") toAw += 1;
      if (r.actor_user_id) people.add(r.actor_user_id);
    }
    if (data.length < PAGE) break;
  }
  return {
    people: { classic: classic.count ?? 0, aiden_workspace: aw.count ?? 0 },
    switches: { to_classic: toClassic, to_aiden_workspace: toAw, people: people.size },
    unlocked_workspaces: unlocked.error ? 0 : (unlocked.count ?? 0),
    days,
  };
}
