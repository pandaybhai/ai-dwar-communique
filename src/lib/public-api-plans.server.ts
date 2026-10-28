import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PLAN_AVAILABILITY,
  PLAN_LABELS,
  endpointFor,
  eventFor,
  onEveryPlan,
  planAllows,
  planNeeded,
  type Availability,
} from "@/lib/public-api-plans";

/**
 * Batch 38 item 5: the server side of the plan table (public-api-plans.ts).
 * authenticateApiKey calls endpointPlanGate for every API call, after the
 * key and the public_api flag. A row every API plan has (all of them today)
 * is allowed without reading anything; only a narrowed row reads the
 * workspace's plan (organizations.plan_version_id -> plan_versions.plan_id
 * -> plans.key, kept for a minute) — and a plan that can't be read is a 503,
 * never "allowed".
 */

const PLAN_TTL_MS = 60_000;
const planCache = new Map<string, { at: number; key: string | null }>();

/** Test hook. */
export function forgetWorkspacePlans(): void {
  planCache.clear();
}

/** The workspace's plan key (lower case), null when it has none. Throws when it can't be read. */
export async function workspacePlanKey(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const hit = planCache.get(organizationId);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.key;
  const { data: org, error } = await supabase
    .from("organizations")
    .select("plan_version_id")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const versionId = (org as { plan_version_id?: string | null } | null)?.plan_version_id ?? null;
  let key: string | null = null;
  if (versionId) {
    const { data: version, error: versionError } = await supabase
      .from("plan_versions")
      .select("plan_id")
      .eq("id", versionId)
      .maybeSingle();
    if (versionError) throw new Error(versionError.message);
    const planId = (version as { plan_id?: string | null } | null)?.plan_id ?? null;
    if (planId) {
      const { data: plan, error: planError } = await supabase
        .from("plans")
        .select("key")
        .eq("id", planId)
        .maybeSingle();
      if (planError) throw new Error(planError.message);
      key = ((plan as { key?: string | null } | null)?.key ?? null)?.toLowerCase() ?? null;
    }
  }
  planCache.set(organizationId, { at: Date.now(), key });
  return key;
}

export type PlanCheck = { allowed: true } | { allowed: false; plan: string } | { error: true };

/** Whether this workspace's plan has the row. */
export async function checkPlan(
  supabase: SupabaseClient,
  organizationId: string,
  row: Availability,
): Promise<PlanCheck> {
  if (onEveryPlan(row)) return { allowed: true };
  try {
    const key = await workspacePlanKey(supabase, organizationId);
    return planAllows(row, key) ? { allowed: true } : { allowed: false, plan: planNeeded(row) };
  } catch {
    return { error: true };
  }
}

/**
 * Null when the request's endpoint is in the workspace's plan (or isn't in
 * the table: the router answers what doesn't exist), else the 403 — or a 503
 * when the plan can't be read.
 */
export async function endpointPlanGate(
  supabase: SupabaseClient,
  organizationId: string,
  request: Request,
  table: Availability[] = PLAN_AVAILABILITY,
): Promise<Response | null> {
  let pathname = "";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return null;
  }
  const row = endpointFor(request.method, pathname, table);
  if (!row) return null;
  const check = await checkPlan(supabase, organizationId, row);
  if ("error" in check) {
    return Response.json(
      { error: "We couldn't check your plan. Please try again.", code: "unavailable" },
      { status: 503 },
    );
  }
  if (check.allowed) return null;
  const label = PLAN_LABELS[check.plan as keyof typeof PLAN_LABELS] ?? check.plan;
  return Response.json(
    {
      error: `${row.method} ${row.path} isn't part of this workspace's plan. It is available on the ${label} plan and above.`,
      code: "endpoint_not_in_plan",
      plan_needed: check.plan,
    },
    { status: 403 },
  );
}

/** Whether this workspace's webhook may hear `event` (a plan that can't be read: no). */
export async function eventInPlan(
  supabase: SupabaseClient,
  organizationId: string,
  event: string,
  table: Availability[] = PLAN_AVAILABILITY,
): Promise<boolean> {
  const row = eventFor(event, table);
  if (!row) return false;
  const check = await checkPlan(supabase, organizationId, row);
  return "allowed" in check && check.allowed;
}
