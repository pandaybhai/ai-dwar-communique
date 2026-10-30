import type { SupabaseClient } from "@supabase/supabase-js";
import { isFlowDeleted } from "@/lib/flow-delete";
import { metaTemplateStatus } from "@/lib/templates";

/**
 * Batch 51: deleting a message template (Campaigns > Templates, new design).
 * Refused while a campaign that hasn't finished or an active flow sends it.
 * Otherwise Meta deletes it on its business account (the template's own
 * WABA, through graphFetch like every other template call), and the row is
 * marked exactly as Meta's DELETED notice marks it in the template webhook
 * and sync (metaTemplateStatus("DELETED"), no reason). Batch 51's deleted_at
 * column, when applied, lets the new gallery hide it; before then it shows
 * as Paused, as a template deleted in WhatsApp Manager does today.
 */

/** Campaign states that will still send: scheduled, waiting on credits approval, sending, paused. */
export const CAMPAIGN_STATES_USING_TEMPLATE = [
  "scheduled",
  "awaiting_approval",
  "sending",
  "paused",
] as const;

export type TemplateUse = { campaigns: string[]; flows: string[] };

export type DeleteTemplateResult =
  | { ok: true; name: string; language: string }
  | { ok: false; status: number; error: string; usedBy?: TemplateUse };

type TemplateRow = {
  id: string;
  waba_id: string | null;
  meta_template_id: string | null;
  name: string;
  language: string;
  status: string;
};

type GraphCall = (
  path: string,
  accessToken: string,
  init: { method?: string; query?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; body: Record<string, unknown> }>;

/** Does a Flows v2 graph send this template (a "template" step with its id)? */
export function graphSendsTemplate(graph: unknown, templateId: string): boolean {
  const nodes = (graph as { nodes?: unknown } | null)?.nodes;
  if (!Array.isArray(nodes)) return false;
  return nodes.some((n) => {
    const node = n as { type?: unknown; data?: Record<string, unknown> | null };
    return node?.type === "template" && String(node.data?.["template_id"] ?? "") === templateId;
  });
}

/**
 * What still sends this template: campaigns that haven't ended (by name and
 * language, as campaigns store it) and active flows — a published Flows v2
 * version with a template step on it, or an enabled legacy flow step. A read
 * that fails is returned as an error: never delete on a guess.
 */
export async function templateInUse(
  supabase: SupabaseClient,
  organizationId: string,
  template: Pick<TemplateRow, "id" | "name" | "language">,
): Promise<TemplateUse | { error: string }> {
  const [campaigns, versions, steps] = await Promise.all([
    supabase
      .from("campaigns")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("template_name", template.name)
      .eq("template_language", template.language)
      .in("status", [...CAMPAIGN_STATES_USING_TEMPLATE]),
    supabase
      .from("flow_versions")
      .select("flow_id, graph")
      .eq("organization_id", organizationId)
      .eq("status", "published"),
    supabase
      .from("flow_steps")
      .select("flow_id, flows!inner(id, name, is_enabled, config, organization_id)")
      .eq("template_id", template.id)
      .eq("is_enabled", true)
      .eq("flows.organization_id", organizationId),
  ]);
  if (campaigns.error || versions.error || steps.error)
    return { error: "We couldn't check where this template is used. Please try again." };

  const flowIds = Array.from(
    new Set(
      ((versions.data ?? []) as Array<{ flow_id: string; graph: unknown }>)
        .filter((v) => graphSendsTemplate(v.graph, template.id))
        .map((v) => v.flow_id),
    ),
  );
  const flowNames: string[] = [];
  if (flowIds.length) {
    const { data, error } = await supabase
      .from("flows")
      .select("id, name, is_enabled, config")
      .eq("organization_id", organizationId)
      .in("id", flowIds);
    if (error) return { error: "We couldn't check where this template is used. Please try again." };
    for (const f of (data ?? []) as Array<{
      name: string | null;
      is_enabled: boolean | null;
      config: Record<string, unknown> | null;
    }>) {
      if (f.is_enabled && !isFlowDeleted(f)) flowNames.push(f.name || "A flow");
    }
  }
  type Flow = {
    name: string | null;
    is_enabled: boolean | null;
    config: Record<string, unknown> | null;
  };
  for (const s of (steps.data ?? []) as Array<{ flows: Flow | Flow[] | null }>) {
    const f = Array.isArray(s.flows) ? s.flows[0] : s.flows;
    if (f?.is_enabled && !isFlowDeleted(f)) flowNames.push(f.name || "A flow");
  }

  return {
    campaigns: ((campaigns.data ?? []) as Array<{ name: string | null }>).map(
      (c) => c.name || "A campaign",
    ),
    flows: Array.from(new Set(flowNames)),
  };
}

/** The refusal, naming what uses it. */
export function inUseMessage(use: TemplateUse): string {
  const parts: string[] = [];
  if (use.campaigns.length)
    parts.push(
      `${use.campaigns.length === 1 ? "the campaign" : "the campaigns"} ${use.campaigns.map((n) => `“${n}”`).join(", ")}`,
    );
  if (use.flows.length)
    parts.push(
      `${use.flows.length === 1 ? "the active flow" : "the active flows"} ${use.flows.map((n) => `“${n}”`).join(", ")}`,
    );
  return `This template is still used by ${parts.join(" and ")}. Finish or cancel the campaign, or change or switch off the flow, then delete it.`;
}

export async function deleteMessageTemplate(
  supabase: SupabaseClient,
  args: { organizationId: string; templateId: string; graphFetch: GraphCall },
): Promise<DeleteTemplateResult> {
  const { data: row, error: readError } = await supabase
    .from("message_templates")
    .select("id, waba_id, meta_template_id, name, language, status")
    .eq("id", args.templateId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (readError)
    return { ok: false, status: 500, error: "We couldn't read that template. Please try again." };
  const template = row as TemplateRow | null;
  if (!template) return { ok: false, status: 404, error: "That template isn't in this workspace." };
  if (!template.meta_template_id || !template.waba_id)
    return {
      ok: false,
      status: 400,
      error: "Meta hasn't given this template an id yet. Sync with Meta, then try again.",
    };

  const use = await templateInUse(supabase, args.organizationId, template);
  if ("error" in use) return { ok: false, status: 500, error: use.error };
  if (use.campaigns.length || use.flows.length)
    return { ok: false, status: 409, error: inUseMessage(use), usedBy: use };

  const { listWabaConnections } = await import("@/lib/whatsapp-numbers.server");
  const connection = (await listWabaConnections(supabase, args.organizationId)).find(
    (c) => c.wabaId === template.waba_id,
  );
  if (!connection)
    return {
      ok: false,
      status: 400,
      error: "The business account this template belongs to isn't connected any more.",
    };

  // Meta's delete for one language of one template: its id and its name.
  const result = await args.graphFetch(
    `${template.waba_id}/message_templates`,
    connection.accessToken,
    {
      method: "DELETE",
      query: { hsm_id: template.meta_template_id, name: template.name },
    },
  );
  if (!result.ok) {
    const { graphErrorMessage } = await import("@/lib/whatsapp-api.server");
    return { ok: false, status: 400, error: graphErrorMessage(result.body) };
  }

  // Exactly what the template webhook / sync write for Meta's DELETED.
  const now = new Date().toISOString();
  await supabase
    .from("message_templates")
    .update({ status: metaTemplateStatus("DELETED"), rejection_reason: null, updated_at: now })
    .eq("id", template.id)
    .eq("organization_id", args.organizationId);
  // Batch 51 (20261250): lets the gallery hide it. A missing column is fine.
  const marked = await supabase
    .from("message_templates")
    .update({ deleted_at: now })
    .eq("id", template.id)
    .eq("organization_id", args.organizationId);
  if (marked.error) console.warn("[templates] deleted_at not written", marked.error.message);

  return { ok: true, name: template.name, language: template.language };
}
