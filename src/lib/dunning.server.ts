import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * What happens when a plan fee goes unpaid.
 *
 * The ladder is deliberately gentle and never destructive: remind, remind
 * again, pause outbound marketing, then pause the plan (the AI drops to draft
 * mode through the plan-status guard). Inbox stays open at every step — a
 * customer mid-conversation is never abandoned because an invoice is late.
 * Nothing is deleted, and one payment undoes all of it.
 *
 * Days are counted from the invoice due date; the last two rungs read their
 * offsets from platform_settings (dunning_pause_campaigns_days and
 * dunning_suspend_days).
 */

export type DunningStage = "reminder_1" | "reminder_2" | "paused" | "suspended";

type Rung = { stage: DunningStage; day: number; action: "notify" | "pause_outbound" | "suspend" };

export function dunningLadder(settings: {
  dunning_pause_campaigns_days: number;
  dunning_suspend_days: number;
}): Rung[] {
  const pause = Math.max(4, Number(settings.dunning_pause_campaigns_days ?? 10));
  const suspend = Math.max(pause + 1, Number(settings.dunning_suspend_days ?? 30));
  return [
    { stage: "reminder_1", day: 1, action: "notify" },
    { stage: "reminder_2", day: 3, action: "notify" },
    { stage: "paused", day: pause, action: "pause_outbound" },
    { stage: "suspended", day: suspend, action: "suspend" },
  ];
}

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
    // Merge with anything paused on an earlier rung so a restore brings back
    // everything, not just the last batch.
    const { data: settings } = await supabase
      .from("organization_billing_settings")
      .select("dunning_paused")
      .eq("organization_id", organizationId)
      .maybeSingle();
    const prior = (settings?.["dunning_paused"] ?? {}) as {
      campaigns?: string[];
      automations?: string[];
    };
    await supabase.from("organization_billing_settings").upsert(
      {
        organization_id: organizationId,
        dunning_paused: {
          campaigns: [...new Set([...(prior.campaigns ?? []), ...campaignIds])],
          automations: [...new Set([...(prior.automations ?? []), ...automationIds])],
        },
      },
      { onConflict: "organization_id" },
    );
  }

  return { campaigns: campaignIds.length, automations: automationIds.length };
}

/** Plan paused: outbound stopped and the plan itself on hold until paid. */
export async function suspendPlan(supabase: SupabaseClient, organizationId: string): Promise<void> {
  await pauseOutbound(supabase, organizationId);
  await supabase.from("organizations").update({ plan_status: "paused" }).eq("id", organizationId);
}

/** Read-only workspace (expired trial). Data stays exactly where it is. */
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
    .select("plan_status, plan_version_id")
    .eq("id", organizationId)
    .maybeSingle();
  const status = (org?.["plan_status"] as string | null) ?? null;

  const { data: settings } = await supabase
    .from("organization_billing_settings")
    .select("dunning_paused, dunning_stage")
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

  if (settings) {
    await supabase
      .from("organization_billing_settings")
      .update({ dunning_paused: {}, dunning_stage: null, dunning_last_at: null })
      .eq("organization_id", organizationId);
  }

  if (
    (status === "past_due" || status === "paused" || status === "locked") &&
    org?.["plan_version_id"]
  ) {
    await supabase.from("organizations").update({ plan_status: "active" }).eq("id", organizationId);
  }

  if (settings?.["dunning_stage"]) {
    await supabase.from("activity_log").insert({
      organization_id: organizationId,
      action: "dunning_cleared",
      details: { from_stage: settings["dunning_stage"] },
    });
  }
}

function daysSince(dateOnly: string, now: Date): number {
  return Math.floor((now.getTime() - new Date(`${dateOnly}T00:00:00Z`).getTime()) / 86_400_000);
}

/**
 * Advances every overdue workspace by at most one rung per run (and never
 * twice inside 20 hours), so a workspace that has been ignored for a month
 * doesn't jump straight to suspended.
 */
export async function runDunning(
  supabase: SupabaseClient,
  now = new Date(),
): Promise<{ notified: number; paused: number; suspended: number; skipped: number }> {
  const counts = { notified: 0, paused: 0, suspended: 0, skipped: 0 };

  const { loadSupplier } = await import("@/lib/invoices.server");
  const supplier = await loadSupplier(supabase);
  const ladder = dunningLadder(supplier);

  const { data: invoices } = await supabase
    .from("invoices")
    .select("id, organization_id, invoice_number, total, amount_paid, due_date")
    .in("status", ["issued", "partially_paid"])
    .eq("purpose", "plan_fee")
    .eq("kind", "tax_invoice")
    .not("due_date", "is", null)
    .lt("due_date", now.toISOString().slice(0, 10))
    .order("due_date", { ascending: true })
    .limit(500);

  // One ladder per workspace, driven by its oldest overdue invoice.
  const oldest = new Map<string, Record<string, unknown>>();
  for (const row of (invoices ?? []) as Record<string, unknown>[]) {
    const orgId = String(row["organization_id"]);
    if (!oldest.has(orgId)) oldest.set(orgId, row);
  }
  if (oldest.size === 0) return counts;

  const { data: eligibleOrgs } = await supabase
    .from("organizations")
    .select("id")
    .in("id", [...oldest.keys()])
    .not("plan_version_id", "is", null)
    .not("billing_enabled_at", "is", null)
    .neq("plan_status", "cancelled");
  const eligible = new Set(((eligibleOrgs ?? []) as { id: string }[]).map((o) => o.id));

  const { notify } = await import("@/lib/billing.server");

  for (const [organizationId, row] of oldest) {
    if (!eligible.has(organizationId)) {
      counts.skipped += 1;
      continue;
    }
    const overdue = daysSince(String(row["due_date"]), now);

    const { data: settings } = await supabase
      .from("organization_billing_settings")
      .select("dunning_stage, dunning_last_at")
      .eq("organization_id", organizationId)
      .maybeSingle();
    const current = (settings?.["dunning_stage"] as string | null) ?? null;
    const lastAt = (settings?.["dunning_last_at"] as string | null) ?? null;

    // Never two rungs in one day, whatever the schedule does.
    if (lastAt && now.getTime() - new Date(lastAt).getTime() < 20 * 3_600_000) {
      counts.skipped += 1;
      continue;
    }

    const currentIndex = ladder.findIndex((r) => r.stage === current);
    const next = ladder[currentIndex + 1];
    if (!next || overdue < next.day) {
      counts.skipped += 1;
      continue;
    }

    if (next.action === "pause_outbound") {
      await pauseOutbound(supabase, organizationId);
      counts.paused += 1;
    } else if (next.action === "suspend") {
      await suspendPlan(supabase, organizationId);
      counts.suspended += 1;
    } else {
      counts.notified += 1;
    }

    const outstanding = Math.max(
      0,
      Number(row["total"] ?? 0) - Number(row["amount_paid"] ?? 0),
    );
    await notify(supabase, {
      organizationId,
      audience: "client",
      kind: "invoice_overdue",
      payload: {
        invoice_id: row["id"],
        invoice_number: row["invoice_number"],
        amount: Math.round(outstanding * 100) / 100,
        days_overdue: overdue,
        stage: next.stage,
      },
    });

    await supabase.from("organization_billing_settings").upsert(
      {
        organization_id: organizationId,
        dunning_stage: next.stage,
        dunning_last_at: now.toISOString(),
      },
      { onConflict: "organization_id" },
    );

    await supabase.from("activity_log").insert({
      organization_id: organizationId,
      action: "dunning_advanced",
      details: { stage: next.stage, days_overdue: overdue, invoice: row["invoice_number"] },
    });
  }

  return counts;
}
