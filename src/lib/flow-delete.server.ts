/**
 * Batch 35: deleting and restoring a chat flow (Flows v2). Everything that
 * changes data runs in one database function (flow_soft_delete /
 * flow_restore_deleted / purge_deleted_flows, 20261130), so a delete can never
 * leave a flow half-deleted or a run half-ended. Ended runs send nothing.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlowDeleted, restoreDaysLeft } from "@/lib/flow-delete";

export type FlowDeleteAnswer<T> =
  { ok: true; data: T } | { ok: false; status: number; error: string };

type FlowRow = {
  id: string;
  name: string;
  key: string;
  whatsapp_account_id: string | null;
  config: Record<string, unknown> | null;
};

const ACTIVE = ["running", "waiting", "paused"];
const NOT_YET =
  "Deleting flows needs today's database update — ask support to apply it. Nothing was changed.";

/** The flow, and why it can't be deleted (a built-in store flow, or the platform's onboarding flow). */
async function loadForDelete(
  db: SupabaseClient,
  organizationId: string,
  flowId: string,
): Promise<{ flow: FlowRow | null; refusal: string | null }> {
  const { data } = await db
    .from("flows")
    .select("id, name, key, whatsapp_account_id, config")
    .eq("id", flowId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const flow = data as FlowRow | null;
  if (!flow) return { flow: null, refusal: null };
  if (!flow.key.startsWith("v2:")) {
    return {
      flow,
      refusal:
        "This is one of the built-in store flows that comes with every workspace. Switch it off instead — it can't be deleted.",
    };
  }
  if (flow.whatsapp_account_id) {
    const { data: platform } = await db
      .from("platform_settings")
      .select("onboarding_whatsapp_account_id")
      .maybeSingle();
    const onboardingId =
      (platform as { onboarding_whatsapp_account_id?: string | null } | null)
        ?.onboarding_whatsapp_account_id ?? null;
    if (onboardingId && flow.whatsapp_account_id === onboardingId) {
      return {
        flow,
        refusal:
          "This flow runs on AiDwar's own onboarding number, so it's a platform flow and can't be deleted here.",
      };
    }
  }
  return { flow, refusal: null };
}

/** What the confirm dialog says: how many conversations are in this flow right now. */
export async function flowDeleteCheck(
  db: SupabaseClient,
  organizationId: string,
  flowId: string,
): Promise<FlowDeleteAnswer<{ active_runs: number; refusal: string | null }>> {
  const { flow, refusal } = await loadForDelete(db, organizationId, flowId);
  if (!flow) return { ok: false, status: 404, error: "Flow not found." };
  const { count } = await db
    .from("flow_runs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("flow_id", flowId)
    .in("status", ACTIVE);
  return { ok: true, data: { active_runs: count ?? 0, refusal } };
}

export async function deleteFlow(
  db: SupabaseClient,
  args: { organizationId: string; userId: string; flowId: string },
): Promise<FlowDeleteAnswer<{ ended_runs: number }>> {
  const { flow, refusal } = await loadForDelete(db, args.organizationId, args.flowId);
  if (!flow) return { ok: false, status: 404, error: "Flow not found." };
  if (refusal) return { ok: false, status: 409, error: refusal };
  if (isFlowDeleted(flow)) return { ok: true, data: { ended_runs: 0 } };

  const { data, error } = await db.rpc("flow_soft_delete", {
    p_org: args.organizationId,
    p_flow: args.flowId,
    p_actor: args.userId,
  });
  if (error) {
    if (error.code === "PGRST202") return { ok: false, status: 503, error: NOT_YET };
    console.error("[flow-delete] failed", error.message);
    return {
      ok: false,
      status: 500,
      error: "We couldn't delete this flow. Nothing was changed — try again.",
    };
  }
  const ended = Number(data ?? 0);
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(db, args.organizationId, args.userId, "flow_v2_deleted", {
    flow_id: flow.id,
    name: flow.name,
    ended_runs: ended,
  });
  return { ok: true, data: { ended_runs: ended } };
}

export async function restoreFlow(
  db: SupabaseClient,
  args: { organizationId: string; userId: string; flowId: string },
): Promise<FlowDeleteAnswer<{ restored: true }>> {
  const { flow } = await loadForDelete(db, args.organizationId, args.flowId);
  if (!flow || !flow.key.startsWith("v2:"))
    return { ok: false, status: 404, error: "Flow not found." };
  if (!isFlowDeleted(flow)) return { ok: true, data: { restored: true } };
  if (restoreDaysLeft(flow) === 0) {
    return {
      ok: false,
      status: 410,
      error: "This flow was deleted more than 30 days ago and can't be restored.",
    };
  }
  const { error } = await db.rpc("flow_restore_deleted", {
    p_org: args.organizationId,
    p_flow: args.flowId,
  });
  if (error) {
    if (error.code === "PGRST202") return { ok: false, status: 503, error: NOT_YET };
    if (/FLOW_RESTORE_EXPIRED/.test(error.message)) {
      return {
        ok: false,
        status: 410,
        error: "This flow was deleted more than 30 days ago and can't be restored.",
      };
    }
    return { ok: false, status: 500, error: "We couldn't restore this flow. Try again." };
  }
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(db, args.organizationId, args.userId, "flow_v2_undeleted", {
    flow_id: flow.id,
    name: flow.name,
  });
  return { ok: true, data: { restored: true } };
}

/**
 * The daily sweep (flow-scan): definitions of flows deleted over 30 days ago
 * go (purge_deleted_flows; never messages, never run history). Never throws;
 * before the migration it reports itself skipped.
 */
export async function purgeDeletedFlows(
  db: SupabaseClient,
): Promise<{ purged: number; skipped?: string }> {
  try {
    const { data, error } = await db.rpc("purge_deleted_flows", { p_limit: 100 });
    if (error)
      return { purged: 0, skipped: error.code === "PGRST202" ? "function_missing" : error.message };
    return { purged: Number(data ?? 0) };
  } catch (error) {
    return { purged: 0, skipped: error instanceof Error ? error.message : String(error) };
  }
}
