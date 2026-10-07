import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Publishing a Flows v2 draft is all-or-nothing: the old published version is
 * archived, the draft becomes the published version and the flow is switched
 * on — or nothing changes at all. It is one transaction (flow_publish_version,
 * supabase/aidwar-migrations/20261015_flow_publish_atomic.sql).
 */

export type PublishResult = { ok: true } | { ok: false; error: string };

const FAILED = "We couldn't publish this flow — nothing was changed. Please try again.";

export async function publishFlowVersion(
  db: SupabaseClient,
  args: { organizationId: string; flowId: string; versionId: string; graph: unknown; userId: string },
): Promise<PublishResult> {
  const { error } = await db.rpc("flow_publish_version", {
    p_organization_id: args.organizationId,
    p_flow_id: args.flowId,
    p_version_id: args.versionId,
    p_graph: args.graph,
    p_user: args.userId,
  });
  if (!error) return { ok: true };
  console.error("[flows-v2] publish failed", error.message);
  return { ok: false, error: FAILED };
}
