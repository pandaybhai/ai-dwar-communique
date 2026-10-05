import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Publishing a Flows v2 draft is all-or-nothing: the old published version is
 * archived, the draft becomes the published version and the flow is switched
 * on — or nothing changes at all.
 *
 * With migration 20261015_flow_publish_atomic.sql (supabase/aidwar-migrations) applied this is one
 * transaction (flow_publish_version). Until it is, the same three writes run
 * in order and every write that already landed is put back when a later one
 * fails, so a flow is never left with its old version archived and no new one
 * published, or published but switched off.
 */

export type PublishResult = { ok: true } | { ok: false; error: string };

const FAILED = "We couldn't publish this flow — nothing was changed. Please try again.";

/** PostgREST's "no such function" (the migration isn't applied yet). */
function missingFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function/i.test(error.message ?? "");
}

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
  if (!missingFunction(error)) {
    console.error("[flows-v2] publish failed", error.message);
    return { ok: false, error: FAILED };
  }
  return publishStepByStep(db, args);
}

async function publishStepByStep(
  db: SupabaseClient,
  args: { organizationId: string; flowId: string; versionId: string; graph: unknown; userId: string },
): Promise<PublishResult> {
  const { data: before, error: readError } = await db
    .from("flow_versions")
    .select("id")
    .eq("flow_id", args.flowId)
    .eq("organization_id", args.organizationId)
    .eq("status", "published");
  if (readError) return { ok: false, error: FAILED };
  const previous = ((before ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => id !== args.versionId);

  const putBackPrevious = async () => {
    for (const id of previous) await db.from("flow_versions").update({ status: "published" }).eq("id", id).eq("status", "archived");
  };

  if (previous.length) {
    const { error } = await db.from("flow_versions").update({ status: "archived" }).in("id", previous).eq("status", "published");
    if (error) return { ok: false, error: FAILED };
  }

  const { data: published, error: publishError } = await db
    .from("flow_versions")
    .update({ status: "published", graph: args.graph, published_at: new Date().toISOString(), published_by: args.userId })
    .eq("id", args.versionId)
    .eq("flow_id", args.flowId)
    .eq("status", "draft")
    .select("id");
  if (publishError || !((published ?? []) as unknown[]).length) {
    await putBackPrevious();
    return { ok: false, error: FAILED };
  }

  const { error: enableError } = await db.from("flows").update({ is_enabled: true }).eq("id", args.flowId).eq("organization_id", args.organizationId);
  if (enableError) {
    await db.from("flow_versions").update({ status: "draft", published_at: null, published_by: null }).eq("id", args.versionId);
    await putBackPrevious();
    return { ok: false, error: FAILED };
  }
  return { ok: true };
}
