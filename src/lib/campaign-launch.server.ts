import type { SupabaseClient } from "@supabase/supabase-js";
import type { AudienceContact } from "@/lib/campaigns.server";
import type { VariableMappings } from "@/lib/campaigns";

/**
 * Batch 38: the one campaign launch and the one cancel, shared by the app
 * (/api/campaigns/launch, /api/campaigns/control) and the Public API
 * (/api/v1/campaigns). Moved here from those routes without changing what
 * they do: the app's answers are word for word the same.
 *
 * A launch writes the campaign row ("sending", "scheduled" or
 * "awaiting_approval") and its campaign_recipients list; it sends nothing.
 * The campaign worker (runCampaignDispatch) then takes the wallet hold
 * before the first message and sends — exactly as for a campaign launched
 * in the app. A cancel skips what is still queued, marks the campaign
 * cancelled and gives back the unused hold (settleCampaignSpend).
 */

export type LaunchRefusal = {
  ok: false;
  status: number;
  /** For the Public API; the app answers with `error` alone. */
  code: string;
  error: string;
  estimate?: Record<string, unknown>;
};

export type LaunchSuccess = {
  ok: true;
  campaignId: string;
  status: string;
  totalRecipients: number;
  needsApproval: boolean;
  estimatedCost: number | null;
  scheduledAt: string | null;
};

export type LaunchInput = {
  organizationId: string;
  /** The member who launched it; null for a Public API launch. */
  userId: string | null;
  name: string;
  templateName: string;
  /** Public API only: the template's language when it has several. */
  templateLanguage?: string | null;
  whatsappAccountId: string | null;
  segmentId: string | null;
  /**
   * The audience, already resolved (opted-in contacts of this workspace).
   * Left out, it is the segment's (or everyone's) as the app has always done.
   */
  contacts?: AudienceContact[];
  mappings: VariableMappings;
  /** Public API: values given per recipient, which win over `mappings`. */
  recipientValues?: Map<string, Record<string, string>>;
  sendSettings: Record<string, unknown>;
  scheduledAt: Date | null;
  /** Extra details on the activity log entry (a Public API launch: source "api", its key id). */
  activityDetails?: Record<string, unknown>;
  /** Extra fields on the campaign.launched event (the API key that launched it). */
  eventProperties?: Record<string, unknown>;
};

const refuse = (
  status: number,
  code: string,
  error: string,
  extra: Partial<LaunchRefusal> = {},
): LaunchRefusal => ({ ok: false, status, code, error, ...extra });

export type CampaignCategory = "marketing" | "utility" | "authentication" | "service";

export function campaignCategory(raw: unknown): CampaignCategory {
  const category = String(raw ?? "marketing").toLowerCase();
  return (
    ["marketing", "utility", "authentication", "service"].includes(category)
      ? category
      : "marketing"
  ) as CampaignCategory;
}

/** A locked or paused workspace spends nothing until a plan is chosen. */
export async function workspaceLocked(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("plan_status")
    .eq("id", organizationId)
    .maybeSingle();
  const planStatus = (orgRow as { plan_status?: string | null } | null)?.plan_status ?? null;
  return planStatus === "locked" || planStatus === "paused";
}

export async function launchCampaign(
  supabase: SupabaseClient,
  input: LaunchInput,
): Promise<LaunchSuccess | LaunchRefusal> {
  const { organizationId, userId } = input;
  const { resolveAudienceContacts, isSegmentNotFound } = await import("@/lib/campaigns.server");
  const { extractVariables, templateBodyText } = await import("@/lib/templates");
  const { resolveAllVariables } = await import("@/lib/campaigns");
  const { normalizePhone } = await import("@/lib/phone");
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");

  if (await workspaceLocked(supabase, organizationId)) {
    return refuse(402, "workspace_locked", "This workspace is locked — choose a plan to continue.");
  }

  const name = input.name.trim();
  const templateName = input.templateName.trim();
  if (!name) return refuse(400, "invalid_name", "Give your campaign a name.");
  if (!templateName) return refuse(400, "invalid_template_name", "Pick an approved template.");

  // A campaign sends from exactly one number; its WABA decides which
  // template library is valid.
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const { connection, error: connectionError } = await getWhatsAppConnection(
    supabase,
    organizationId,
    input.whatsappAccountId,
  );
  if (!connection) {
    return refuse(
      400,
      "no_whatsapp_number",
      connectionError ?? "Connect a number before launching a campaign.",
    );
  }

  let templateQuery = supabase
    .from("message_templates")
    .select("name, language, components, status")
    .eq("organization_id", organizationId)
    .eq("waba_id", connection.wabaId)
    .eq("name", templateName)
    .eq("status", "APPROVED");
  if (input.templateLanguage) templateQuery = templateQuery.eq("language", input.templateLanguage);
  const { data: template } = await templateQuery.limit(1).maybeSingle();
  if (!template) {
    return refuse(
      400,
      "template_not_approved",
      "That template isn't approved on the number you picked. Choose another template or another number.",
    );
  }

  const variableOrder = extractVariables(templateBodyText(template.components as never));

  let contacts: AudienceContact[];
  if (input.contacts) {
    contacts = input.contacts;
  } else {
    try {
      contacts = await resolveAudienceContacts(supabase, organizationId, input.segmentId);
    } catch (error) {
      if (isSegmentNotFound(error)) return refuse(404, "segment_not_found", error.message);
      return refuse(500, "unavailable", "We couldn't work out this audience. Please try again.");
    }
  }
  if (contacts.length === 0) {
    return refuse(
      400,
      "empty_audience",
      "No opted-in contacts match this audience yet, so there's nobody to send to.",
    );
  }

  const scheduledAt = input.scheduledAt;
  const isFuture = Boolean(scheduledAt && scheduledAt.getTime() > Date.now() + 30_000);
  const nowIso = new Date().toISOString();

  // Money check. Workspaces without billing switched on are untouched:
  // the estimate comes back disabled and nothing is blocked or held.
  const { estimateCampaignCost, campaignCostEstimate } = await import("@/lib/billing.server");
  const { data: templateMeta } = await supabase
    .from("message_templates")
    .select("category")
    .eq("organization_id", organizationId)
    .eq("waba_id", connection.wabaId)
    .eq("name", template.name)
    .limit(1)
    .maybeSingle();
  const estimateInput = {
    organizationId,
    recipients: contacts.length,
    category: campaignCategory((templateMeta as { category?: string } | null)?.category),
    whatsappAccountId: connection.accountId,
  };
  // A member's launch checks their campaigns.send (as always); an API
  // launch was checked by its key.
  const estimate = userId
    ? await estimateCampaignCost(supabase, { ...estimateInput, actorId: userId })
    : await campaignCostEstimate(supabase, estimateInput);

  if (estimate.enabled && !estimate.can_send) {
    return refuse(
      402,
      "insufficient_credits",
      `This campaign costs about ${estimate.estimate.toFixed(2)} and you have ${estimate.available.toFixed(2)} in credits. Add credits and try again.`,
      { estimate: estimate as unknown as Record<string, unknown> },
    );
  }

  const needsApproval = estimate.enabled && estimate.needs_approval;
  const status = needsApproval ? "awaiting_approval" : isFuture ? "scheduled" : "sending";

  const { data: campaign, error: campaignErr } = await supabase
    .from("campaigns")
    .insert({
      organization_id: organizationId,
      name,
      whatsapp_account_id: connection.accountId,
      template_name: template.name,
      template_language: template.language,
      variable_mappings: input.mappings,
      send_settings: input.sendSettings,
      segment_id: input.segmentId,
      status,
      scheduled_at: scheduledAt ? scheduledAt.toISOString() : null,
      started_at: status === "sending" ? nowIso : null,
      total_recipients: contacts.length,
      estimated_cost: estimate.enabled ? estimate.estimate : null,
      created_by: userId,
    })
    .select("id, status")
    .single();

  if (campaignErr || !campaign) {
    return refuse(500, "unavailable", "We couldn't create this campaign. Please try again.");
  }
  const campaignId = campaign.id as string;

  const rows = contacts.map((c) => ({
    campaign_id: campaignId,
    organization_id: organizationId,
    contact_id: c.id,
    phone: normalizePhone(c.phone),
    resolved_variables: {
      ...resolveAllVariables(variableOrder, input.mappings, c),
      ...(input.recipientValues?.get(c.id) ?? {}),
    },
  }));

  for (let i = 0; i < rows.length; i += 500) {
    const { error: insErr } = await supabase
      .from("campaign_recipients")
      .upsert(rows.slice(i, i + 500), { onConflict: "campaign_id,contact_id" });
    if (insErr) {
      await supabase.from("campaigns").update({ status: "failed" }).eq("id", campaignId);
      return refuse(500, "unavailable", "We couldn't build the recipient list. Please try again.");
    }
  }

  const { emitEvent, recordUsage } = await import("@/lib/events.server");
  await emitEvent(supabase, "campaign.launched", {
    organizationId,
    actorUserId: userId,
    whatsappAccountId: connection.accountId,
    entityType: "campaign",
    entityId: campaignId,
    properties: {
      campaign_id: campaignId,
      template_name: templateName ?? null,
      segment_id: input.segmentId ?? null,
      waba_id: connection.wabaId,
      recipient_count: rows.length,
      ...(input.eventProperties ?? {}),
    },
  });
  await recordUsage(supabase, "campaign_messages", {
    organizationId,
    quantity: rows.length,
    metadata: {
      campaign_id: campaignId,
      whatsapp_account_id: connection.accountId,
      stage: "queued",
    },
  });

  await logServerActivity(supabase, organizationId, userId, "campaign_launched", {
    name,
    recipient_count: rows.length,
    whatsapp_account_id: connection.accountId,
    ...(input.activityDetails ? { ...input.activityDetails, campaign_id: campaignId } : {}),
  });

  // Big spend: the campaign waits, and the owner is told it needs a nod.
  if (needsApproval) {
    await supabase.from("billing_notifications").insert({
      organization_id: organizationId,
      audience: "client",
      kind: "campaign_approval_needed",
      channel: "inapp",
      payload: {
        campaign_id: campaignId,
        campaign_name: name,
        recipients: rows.length,
        estimated_cost: estimate.estimate,
        requested_by: userId,
      },
    });
  }

  return {
    ok: true,
    campaignId,
    status: String(campaign.status),
    totalRecipients: rows.length,
    needsApproval,
    estimatedCost: estimate.enabled ? estimate.estimate : null,
    scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
  };
}

/**
 * Cancels a campaign that hasn't finished: every queued/sending recipient is
 * skipped, the campaign is marked cancelled (only if it still hasn't
 * finished — conditional on its status, so a campaign that completed
 * meanwhile stays completed) and the unused hold goes back to the wallet.
 * The caller has already read the campaign as the workspace's own.
 */
export async function cancelCampaign(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<{ ok: true } | { ok: false; finished: boolean; error: string }> {
  // One statement over every queued/sending row; a sender writing the
  // same rows at that moment can make Postgres pick this one as a
  // deadlock victim, so it is tried again (Batch 12).
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error: skipError } = await supabase
      .from("campaign_recipients")
      .update({ status: "skipped" })
      .eq("campaign_id", campaignId)
      .in("status", ["queued", "sending"]);
    if (!skipError) break;
    await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
  }
  const { data: moved, error: moveError } = await supabase
    .from("campaigns")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .not("status", "in", "(completed,cancelled,failed)")
    .select("id");
  if (moveError)
    return {
      ok: false,
      finished: false,
      error: "We couldn't cancel this campaign. Please try again.",
    };
  if (!moved?.length)
    return { ok: false, finished: true, error: "This campaign has already finished." };

  // Whatever was reserved and not spent goes back to the wallet.
  const { settleCampaignSpend } = await import("@/lib/campaign-billing.server");
  const settled = await settleCampaignSpend(supabase, organizationId, campaignId);
  if (!settled.ok) {
    console.error(
      JSON.stringify({
        at: "campaign_settle_failed",
        campaign_id: campaignId,
        error: settled.error,
      }),
    );
  }
  return { ok: true };
}
