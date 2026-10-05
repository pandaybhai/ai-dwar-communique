import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Money around a campaign, in three moves:
 *   hold   — when dispatch starts, reserve the estimate so two campaigns
 *            can't spend the same credits.
 *   charge — each message, once, by the database when Meta prices it
 *            (debit_message ledger rows); never charged from here.
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
 * Close the reservation once the campaign finishes.
 *
 * The charge itself is never taken here. Each campaign message is charged
 * exactly once, by the database, as a debit_message ledger row when Meta
 * reports its price (billing_debit_message, idempotent per message). Those
 * rows are the only source of truth: charged_amount is read back from them,
 * never computed and never written unless the ledger calls succeeded.
 *
 * Safe to call twice: a settled campaign has held_amount 0, and a campaign
 * whose release landed but whose row update failed is never released again.
 * On any failure the campaign row is left untouched (held_amount stays set)
 * so the settle can be retried.
 */
export async function settleCampaignSpend(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<{ ok: boolean; error?: string }> {
  const { billingEnabled } = await import("@/lib/billing.server");
  const { round2 } = await import("@/lib/billing");
  if (!(await billingEnabled(supabase, organizationId))) return { ok: true };

  const campaign = await loadCampaign(supabase, organizationId, campaignId);
  if (!campaign) return { ok: true };

  const held = Number(campaign.held_amount ?? 0);
  if (held <= 0) return { ok: true };

  const charged = await campaignLedgerCharge(supabase, organizationId, campaignId);
  if (charged.error !== null) return { ok: false, error: charged.error };

  // Messages already priced were taken out of the hold as they were charged
  // (from_hold); only the part never used goes back.
  const release = round2(Math.max(0, held - charged.amount));

  const { data: released, error: releasedError } = await supabase
    .from("wallet_ledger")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("entry_type", "hold_release")
    .eq("reference_type", "campaign")
    .eq("reference_id", campaignId)
    .limit(1);
  if (releasedError) return { ok: false, error: releasedError.message };

  if (release > 0 && !(released ?? []).length) {
    const { error } = await supabase.rpc("wallet_apply", {
      p_org: organizationId,
      p_type: "hold_release",
      p_amount: release,
      p_ref_type: "campaign",
      p_ref_id: campaignId,
      p_description: "Campaign reservation released",
      p_metadata: { campaign_id: campaignId },
      p_actor: null,
    });
    if (error) return { ok: false, error: error.message };
  }

  const { error: updateError } = await supabase
    .from("campaigns")
    .update({
      held_amount: 0,
      charged_amount: charged.amount,
      returned_amount: release,
    })
    .eq("id", campaignId)
    .eq("organization_id", organizationId);
  if (updateError) return { ok: false, error: updateError.message };
  // A message priced while this settle ran must not leave the total behind.
  await syncCampaignCharged(supabase, organizationId, campaignId);
  return { ok: true };
}

/**
 * campaigns.charged_amount = the sum of this campaign's debit_message rows.
 *
 * Meta prices messages after a campaign finishes (often seconds after the
 * settle), so each price that lands brings the total up to date. It is a
 * fresh read of the ledger every time, never an addition, so nothing is
 * counted twice; and it only ever raises the stored total (the ledger only
 * grows), so two prices arriving together can't leave it short. No debit
 * rows (billing off, free messages) writes nothing.
 */
export async function syncCampaignCharged(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<{ ok: boolean; amount: number; error?: string }> {
  const charged = await campaignLedgerCharge(supabase, organizationId, campaignId);
  if (charged.error !== null) return { ok: false, amount: 0, error: charged.error };
  if (charged.amount <= 0) return { ok: true, amount: 0 };
  const { error } = await supabase
    .from("campaigns")
    .update({ charged_amount: charged.amount })
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .lt("charged_amount", charged.amount);
  if (error) return { ok: false, amount: charged.amount, error: error.message };
  return { ok: true, amount: charged.amount };
}

/** What the ledger has actually charged for this campaign's messages. */
async function campaignLedgerCharge(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<{ amount: number; error: string | null }> {
  const { round2 } = await import("@/lib/billing");
  const { data, error } = await supabase
    .from("wallet_ledger")
    .select("amount")
    .eq("organization_id", organizationId)
    .eq("entry_type", "debit_message")
    .eq("metadata->>campaign_id", campaignId);
  if (error) return { amount: 0, error: error.message };
  const total = ((data ?? []) as Array<{ amount: number | string | null }>).reduce(
    (sum, row) => sum + Math.abs(Number(row.amount ?? 0)),
    0,
  );
  return { amount: round2(total), error: null };
}
