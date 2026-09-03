import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What happens when a plan fee goes unpaid.
 *
 * The ladder is deliberately gentle and never destructive: remind, then pause
 * outbound marketing, then lock the workspace to read-only. Inbox stays open
 * at every step — a customer mid-conversation is never abandoned because an
 * invoice is late. Nothing is deleted, and one payment undoes all of it.
 */

export const DUNNING_STAGES = [
  { day: 0, stage: "due", action: "notify" },
  { day: 3, stage: "reminder_1", action: "notify" },
  { day: 7, stage: "reminder_2", action: "notify" },
  { day: 10, stage: "paused", action: "pause_outbound" },
  { day: 15, stage: "locked", action: "lock" },
] as const;

export type DunningStage = (typeof DUNNING_STAGES)[number]["stage"];

/** Stops scheduled campaigns and automations. Inbox and inbound stay live. */
export async function pauseOutbound(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ campaigns: number; automations: number }> {
  const { data: campaigns } = await supabase
    .from("campaigns")
    .update({ status: "paused" })
    .eq("organization_id", organizationId)
    .in("status", ["scheduled", "sending"])
    .select("id");

  const { data: automations } = await supabase
    .from("automations")
    .update({ is_active: false })
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .select("id");

  const campaignIds = ((campaigns ?? []) as Record<string, unknown>[]).map((c) => String(c["id"]));
  const automationIds = ((automations ?? []) as Record<string, unknown>[]).map((a) =>
    String(a["id"]),
  );

  if (campaignIds.length > 0 || automationIds.length > 0) {
    await supabase.from("organization_billing_settings").upsert(
      {
        organization_id: organizationId,
        dunning_paused: { campaigns: campaignIds, automations: automationIds },
      },
      { onConflict: "organization_id" },
    );
  }

  await supabase.from("organizations").update({ plan_status: "paused" }).eq("id", organizationId);
  return { campaigns: campaignIds.length, automations: automationIds.length };
}

/** Read-only workspace. Data stays exactly where it is. */
export async function lockWorkspace(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<void> {
  await pauseOutbound(supabase, organizationId);
  await supabase.from("organizations").update({ plan_status: "locked" }).eq("id", organizationId);
}

/** One payment undoes the whole ladder, restoring exactly what we paused. */
export async function restoreAfterPayment(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<void> {
  const { data: org } = await supabase
    .from("organizations")
    .select("plan_status")
    .eq("id", organizationId)
    .maybeSingle();
  const status = (org?.["plan_status"] as string | null) ?? null;

  const { data: settings } = await supabase
    .from("organization_billing_settings")
    .select("dunning_paused")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const paused = (settings?.["dunning_paused"] ?? {}) as {
    campaigns?: string[];
    automations?: string[];
  };

  if ((paused.campaigns ?? []).length > 0) {
    await supabase
      .from("campaigns")
      .update({ status: "scheduled" })
      .in("id", paused.campaigns ?? [])
      .eq("organization_id", organizationId)
      .eq("status", "paused");
  }
  if ((paused.automations ?? []).length > 0) {
    await supabase
      .from("automations")
      .update({ is_active: true })
      .in("id", paused.automations ?? [])
      .eq("organization_id", organizationId);
  }

  await supabase
    .from("organization_billing_settings")
    .update({ dunning_paused: {}, dunning_stage: null, dunning_last_at: null })
    .eq("organization_id", organizationId);

  if (status === "past_due" || status === "paused" || status === "locked") {
    await supabase.from("organizations").update({ plan_status: "active" }).eq("id", organizationId);
  }
}

function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

/**
 * Advances every overdue workspace by at most one rung per run, so a workspace
 * that has been ignored for a month doesn't jump straight to locked.
 */
export async function runDunning(
  supabase: SupabaseClient,
): Promise<{ notified: number; paused: number; locked: number }> {
  const counts = { notified: 0, paused: 0, locked: 0 };

  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, organization_id, invoice_number, total, due_date")
    .eq("status", "issued")
    .eq("purpose", "plan_fee")
    .lt("due_date", new Date().toISOString().slice(0, 10))
    .limit(500);

  const { notify } = await import("@/lib/billing.server");

  for (const row of (invoices ?? []) as Record<string, unknown>[]) {
    const organizationId = String(row["organization_id"]);
    const overdue = daysSince(String(row["due_date"]));

    const { data: settings } = await supabase
      .from("organization_billing_settings")
      .select("dunning_stage")
      .eq("organization_id", organizationId)
      .maybeSingle();
    const current = (settings?.["dunning_stage"] as string | null) ?? null;

    const reached = DUNNING_STAGES.filter((stage) => overdue >= stage.day);
    const target = reached[reached.length - 1];
    if (!target || target.stage === current) continue;

    // One rung at a time.
    const currentIndex = DUNNING_STAGES.findIndex((s) => s.stage === current);
    const next = DUNNING_STAGES[Math.min(currentIndex + 1, DUNNING_STAGES.length - 1)];
    const stage = next && next.day <= overdue ? next : target;

    if (stage.action === "pause_outbound") {
      await pauseOutbound(supabase, organizationId);
      counts.paused += 1;
    } else if (stage.action === "lock") {
      await lockWorkspace(supabase, organizationId);
      counts.locked += 1;
    } else {
      counts.notified += 1;
    }

    await notify(supabase, {
      organizationId,
      audience: "client",
      kind: "invoice_overdue",
      payload: {
        invoice_number: row["invoice_number"],
        amount: row["total"],
        days_overdue: overdue,
        stage: stage.stage,
      },
    });

    await supabase.from("organization_billing_settings").upsert(
      {
        organization_id: organizationId,
        dunning_stage: stage.stage,
        dunning_last_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" },
    );

    await supabase.from("activity_log").insert({
      organization_id: organizationId,
      action: "dunning_advanced",
      details: { stage: stage.stage, days_overdue: overdue, invoice: row["invoice_number"] },
    });
  }

  return counts;
}
