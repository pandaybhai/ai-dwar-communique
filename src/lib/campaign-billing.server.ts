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

export type HoldResult = {
  ok: boolean;
  error?: string;
  /** Set when the wallet refused the reservation (not a failed call). */
  code?: "insufficient_credits" | "hold_failed";
};

/**
 * Reserve the estimate once, at the moment the first batch goes out. The
 * wallet refuses a reservation it can't cover (code "insufficient_credits"),
 * so a campaign never starts sending on credits it doesn't have.
 */
export async function holdCampaign(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<HoldResult> {
  const { billingEnabled, holdCampaignSpend } = await import("@/lib/billing.server");
  if (!(await billingEnabled(supabase, organizationId))) return { ok: true };

  const campaign = await loadCampaign(supabase, organizationId, campaignId);
  if (!campaign) return { ok: true };

  const already = Number(campaign.held_amount ?? 0);
  const estimate = Number(campaign.estimated_cost ?? 0);
  if (already > 0 || estimate <= 0) return { ok: true };

  // A run that held and died before writing held_amount: adopt its hold,
  // never hold a second time.
  const { data: prior, error: priorError } = await supabase
    .from("wallet_ledger")
    .select("amount")
    .eq("organization_id", organizationId)
    .eq("entry_type", "hold")
    .eq("reference_type", "campaign")
    .eq("reference_id", campaignId)
    .limit(1);
  if (priorError) return { ok: false, error: priorError.message };
  const priorHold = Math.abs(Number((prior as Array<{ amount: number }> | null)?.[0]?.amount ?? 0));
  if (priorHold > 0) return claimHold(supabase, organizationId, campaignId, priorHold);

  const result = await holdCampaignSpend(supabase, {
    organizationId,
    campaignId,
    amount: estimate,
    actorId: null,
  });
  if ("error" in result) {
    // A run overlapping this one may have held and recorded it meanwhile; its
    // reservation is this campaign's, so ours being refused changes nothing.
    const now = await loadCampaign(supabase, organizationId, campaignId);
    if (Number(now?.held_amount ?? 0) > 0) return { ok: true };
    return { ok: false, error: result.error, code: result.code };
  }

  const claimed = await claimHold(supabase, organizationId, campaignId, estimate);
  if (claimed.ok && !claimed.won) {
    // Another run held it at the same moment and wrote first: give ours back.
    const { error } = await supabase.rpc("wallet_apply", {
      p_org: organizationId,
      p_type: "hold_release",
      p_amount: estimate,
      p_ref_type: "campaign_duplicate_hold",
      p_ref_id: campaignId,
      p_description: "Duplicate campaign reservation returned",
      p_metadata: { campaign_id: campaignId },
      p_actor: null,
    });
    if (error) return { ok: false, error: error.message };
  }
  return { ok: claimed.ok, ...(claimed.error ? { error: claimed.error } : {}) };
}

/**
 * Records the hold on the campaign in one conditional update (only while
 * nothing is recorded), so of two runs holding at once exactly one wins.
 */
async function claimHold(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
  amount: number,
): Promise<{ ok: boolean; won: boolean; error?: string }> {
  const { data, error } = await supabase
    .from("campaigns")
    .update({ held_amount: amount })
    .eq("id", campaignId)
    .eq("organization_id", organizationId)
    .eq("held_amount", 0)
    .select("id");
  if (error) return { ok: false, won: false, error: error.message };
  return { ok: true, won: Boolean(data?.length) };
}

/**
 * Campaigns that ended (completed, cancelled or failed) while still holding
 * credits — a settle that failed, or a campaign that failed after its hold —
 * are settled here. settleCampaignSpend is safe to repeat.
 */
export async function settleEndedHolds(
  supabase: SupabaseClient,
  limit = 50,
): Promise<{ settled: number; failed: number }> {
  const { data, error } = await supabase
    .from("campaigns")
    .select("id, organization_id")
    .in("status", ["completed", "cancelled", "failed"])
    .gt("held_amount", 0)
    .limit(limit);
  if (error) throw new Error(error.message);
  let settled = 0;
  let failed = 0;
  for (const row of (data ?? []) as Array<{ id: string; organization_id: string }>) {
    const result = await settleCampaignSpend(supabase, row.organization_id, row.id).catch(
      (e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }),
    );
    if (result.ok) settled += 1;
    else {
      failed += 1;
      console.error(
        JSON.stringify({ at: "campaign_settle_failed", campaign_id: row.id, error: result.error }),
      );
    }
  }
  return { settled, failed };
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
  // (from_hold); only the part never used goes back. Batch 28: what the
  // reservation itself still has (wallet_campaign_holds) is the truth when
  // it can be read — a message priced after the campaign ended took its part
  // already — else held minus the ledger's charge, as before.
  const remaining = await holdRemaining(supabase, organizationId, campaignId);
  const release = round2(Math.max(0, remaining ?? held - charged.amount));

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

/**
 * What the ledger has actually charged for this campaign's messages, summed
 * in the database (campaign_ledger_charge, 20261016_send_at_scale.sql: one
 * row back, indexed).
 */
export async function campaignLedgerCharge(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<{ amount: number; error: string | null }> {
  const { round2 } = await import("@/lib/billing");
  const { data, error } = await supabase.rpc("campaign_ledger_charge", {
    p_org: organizationId,
    p_campaign_id: campaignId,
  });
  // Batch 28 (item 8): 20261016 said the code works without it; it didn't —
  // a missing function failed every settle. Now it really falls back to
  // summing the same debit rows here (paged), as before the function.
  if (error && isMissingFunction(error)) return ledgerChargeByRows(supabase, organizationId, campaignId);
  if (error) return { amount: 0, error: error.message };
  // The function always returns a number.
  const sum = typeof data === "number" || typeof data === "string" ? Number(data) : NaN;
  if (!Number.isFinite(sum)) return { amount: 0, error: "campaign_ledger_charge returned no number" };
  return { amount: round2(Math.abs(sum)), error: null };
}

/** PostgREST's "no such function" (PGRST202) or Postgres's (42883): a migration not applied yet. */
export function isMissingFunction(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/** campaign_ledger_charge without the function: the same sum over the debit rows, 1,000 at a time. */
async function ledgerChargeByRows(
  supabase: SupabaseClient,
  organizationId: string,
  campaignId: string,
): Promise<{ amount: number; error: string | null }> {
  const { round2 } = await import("@/lib/billing");
  let sum = 0;
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("wallet_ledger")
      .select("amount")
      .eq("organization_id", organizationId)
      .eq("entry_type", "debit_message")
      .eq("metadata->>campaign_id", campaignId)
      .order("id")
      .range(from, from + 999);
    if (error) return { amount: 0, error: error.message };
    const rows = (data ?? []) as Array<{ amount: number | string | null }>;
    for (const r of rows) sum += Math.abs(Number(r.amount ?? 0));
    if (rows.length < 1000) break;
  }
  return { amount: round2(sum), error: null };
}

/**
 * What this campaign's own reservation still holds in the wallet
 * (wallet_campaign_holds, 20261065 — written only by wallet_apply). Null
 * when it can't be read (no row yet, or the table isn't there).
 */
async function holdRemaining(supabase: SupabaseClient, organizationId: string, campaignId: string): Promise<number | null> {
  const { data, error } = await supabase
    .from("wallet_campaign_holds")
    .select("remaining")
    .eq("campaign_id", campaignId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error || !data) return null;
  const n = Number((data as { remaining?: number | string | null }).remaining);
  return Number.isFinite(n) ? n : null;
}

/**
 * Meta prices messages for a while after a campaign completes, and the
 * webhook only re-reads the campaign's total every few seconds: campaigns
 * that ended inside the window get their charged_amount brought up to the
 * ledger (syncCampaignCharged: re-read, raise-only, so never twice).
 */
export async function syncRecentCharged(
  supabase: SupabaseClient,
  opts: { now?: number; windowMs?: number; limit?: number } = {},
): Promise<number> {
  const since = new Date((opts.now ?? Date.now()) - (opts.windowMs ?? 6 * 3_600_000)).toISOString();
  const { data } = await supabase
    .from("campaigns")
    .select("id, organization_id")
    .in("status", ["completed", "cancelled"])
    .gte("completed_at", since)
    .limit(opts.limit ?? 50);
  let synced = 0;
  for (const row of (data ?? []) as Array<{ id: string; organization_id: string }>) {
    const r = await syncCampaignCharged(supabase, row.organization_id, row.id).catch(() => null);
    if (r?.ok) synced += 1;
  }
  return synced;
}

/**
 * Batch 28 (item 12): the billing sweep's pass over ended campaigns. The
 * campaign worker only did this while some campaign was live (it returns
 * before its bookkeeping when nothing is sending), so a campaign that ended
 * alone — 1803da67, priced 10 minutes after it completed — kept its hold for
 * good. Ended campaigns still holding are settled (the ledger and the
 * reservation's own remainder are the truth: what remains is released,
 * nothing is charged here), and recently ended ones get charged_amount
 * raised to their ledger sum.
 */
export async function reconcileEndedCampaigns(
  supabase: SupabaseClient,
  now: number = Date.now(),
): Promise<{ settled: number; failed: number; synced: number }> {
  const holds = await settleEndedHolds(supabase);
  const synced = await syncRecentCharged(supabase, { now, windowMs: 7 * 24 * 3_600_000 });
  return { ...holds, synced };
}
