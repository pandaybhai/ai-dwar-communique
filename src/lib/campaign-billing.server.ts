import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Money around a campaign, in three moves:
 *   hold   — when dispatch starts, reserve the estimate so two campaigns
 *            can't spend the same credits.
 *   charge — what actually went out, counted from sent messages.
 *   release— whatever was reserved and never used comes back.
 * Every function is a no-op when billing is off for the workspace, so
 * nothing changes for those workspaces.
 */

type Campaign = {
  id: string;
  estimated_cost: number | null;
  held_amount: number | null;
  charged_amount: number | null;
  sent_count: number | null;
  template_name: string | null;
};

async function loadCampaign(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<Campaign | null> {
  const { data } = await supabase
    .from("campaigns")
    .select("id, estimated_cost, held_amount, charged_amount, sent_count, template_name")
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  return (data as Campaign | null) ?? null;
}

/** Reserve the estimate once, at the moment the first batch goes out. */
export async function holdCampaign(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { billingEnabled, holdCampaignSpend } = await import("@/lib/billing.server");
  if (!(await billingEnabled(supabase, organizationId))) return { ok: true };

  const campaign = await loadCampaign(supabase, organizationId, campaignId);
  if (!campaign) return { ok: true };

  const already = Number(campaign.held_amount ?? 0);
  const estimate = Number(campaign.estimated_cost ?? 0);
  if (already > 0 || estimate <= 0) return { ok: true };

  const result = await holdCampaignSpend(supabase, {
    organizationId,
    campaignId,
    amount: estimate,
    actorId: null,
  });
  if ("error" in result) return { ok: false, error: result.error };

  await supabase.from("campaigns").update({ held_amount: estimate }).eq("id", campaignId);
  return { ok: true };
}

/**
 * Charge for what was actually sent and give back the rest of the hold.
 * Safe to call twice — it only ever charges the difference.
 */
export async function settleCampaignSpend(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<void> {
  const { billingEnabled, rateFor } = await import("@/lib/billing.server");
  const { round2 } = await import("@/lib/billing");
  if (!(await billingEnabled(supabase, organizationId))) return;

  const campaign = await loadCampaign(supabase, organizationId, campaignId);
  if (!campaign) return;

  const held = Number(campaign.held_amount ?? 0);
  if (held <= 0) return;

  const alreadyCharged = Number(campaign.charged_amount ?? 0);
  const sent = Number(campaign.sent_count ?? 0);

  let category = "marketing";
  if (campaign.template_name) {
    const { data: template } = await supabase
      .from("message_templates")
      .select("category")
      .eq("organization_id", organizationId)
      .eq("name", campaign.template_name)
      .limit(1)
      .maybeSingle();
    category = String((template as { category?: string } | null)?.category ?? "marketing").toLowerCase();
  }
  const { rate } = await rateFor(
    supabase,
    organizationId,
    (["marketing", "utility", "authentication", "service"].includes(category)
      ? category
      : "marketing") as "marketing" | "utility" | "authentication" | "service",
  );

  const spend = round2(Math.min(held, rate * sent));
  const toCharge = round2(spend - alreadyCharged);

  // Release first: the charge is taken from real balance, not the hold.
  await supabase.rpc("wallet_apply", {
    p_org: organizationId,
    p_type: "hold_release",
    p_amount: held,
    p_ref_type: "campaign",
    p_ref_id: campaignId,
    p_description: "Campaign reservation released",
    p_metadata: { campaign_id: campaignId },
    p_actor: null,
  });

  if (toCharge > 0) {
    await supabase.rpc("wallet_apply", {
      p_org: organizationId,
      p_type: "debit",
      p_amount: toCharge,
      p_ref_type: "campaign",
      p_ref_id: campaignId,
      p_description: "Campaign messages sent",
      p_metadata: { campaign_id: campaignId, messages: sent },
      p_actor: null,
    });
  }

  await supabase
    .from("campaigns")
    .update({
      held_amount: 0,
      charged_amount: round2(alreadyCharged + Math.max(0, toCharge)),
      returned_amount: round2(Math.max(0, held - spend)),
    })
    .eq("id", campaignId);
}
