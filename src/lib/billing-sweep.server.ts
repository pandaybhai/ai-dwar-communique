import type { SupabaseClient } from "@supabase/supabase-js";
import { round2 } from "@/lib/billing";

/**
 * The nightly money sweep: warn before credits run out, warn the platform
 * before Meta float runs out, buy credits automatically when the merchant
 * asked us to, chase overdue top-ups, and expire credits nobody used.
 *
 * Every warning is rate-limited to once a day per workspace — a merchant who
 * is low on credits must not wake up to twelve identical messages.
 */

const DAY_MS = 864e5;

export type SweepCounts = {
  organizations: number;
  low_credits: number;
  float_low: number;
  auto_topups: number;
  reminders: number;
  expired: number;
  expiry_skipped: number;
};

function olderThan(iso: string | null | undefined, ms: number): boolean {
  if (!iso) return true;
  return Date.now() - new Date(iso).getTime() > ms;
}

export async function runBillingSweep(supabase: SupabaseClient): Promise<SweepCounts> {
  const counts: SweepCounts = {
    organizations: 0,
    low_credits: 0,
    float_low: 0,
    auto_topups: 0,
    reminders: 0,
    expired: 0,
    expiry_skipped: 0,
  };

  const { billingEnabled, notify, createCreditPurchase } = await import("@/lib/billing.server");
  const nowIso = new Date().toISOString();

  const { data: orgs } = await supabase
    .from("organizations")
    .select("id, name, funding_model")
    .eq("status", "active");

  for (const org of ((orgs ?? []) as Record<string, unknown>[])) {
    const orgId = String(org["id"]);
    try {
      if (!(await billingEnabled(supabase, orgId))) continue;
      counts.organizations += 1;

      const [{ data: settings }, { data: wallet }] = await Promise.all([
        supabase
          .from("organization_billing_settings")
          .select("*")
          .eq("organization_id", orgId)
          .maybeSingle(),
        supabase
          .from("wallet_balances")
          .select("balance, held")
          .eq("organization_id", orgId)
          .maybeSingle(),
      ]);
      const s = (settings ?? {}) as Record<string, unknown>;
      const available = round2(
        Number((wallet as Record<string, unknown> | null)?.["balance"] ?? 0) -
          Number((wallet as Record<string, unknown> | null)?.["held"] ?? 0),
      );

      // ---- low credits (once a day)
      const threshold = Number(s["low_credit_threshold"] ?? 0);
      if (
        threshold > 0 &&
        available < threshold &&
        olderThan(s["last_low_credit_notice_at"] as string | null, DAY_MS)
      ) {
        await notify(supabase, {
          organizationId: orgId,
          audience: "client",
          kind: "low_credits",
          payload: { available, threshold, link: "https://aidwar.in/app/billing" },
        });
        await supabase
          .from("organization_billing_settings")
          .upsert(
            { organization_id: orgId, last_low_credit_notice_at: nowIso },
            { onConflict: "organization_id" },
          );
        counts.low_credits += 1;
      }

      // ---- Meta float running low (platform-funded workspaces only)
      if (org["funding_model"] === "aidwar_prepaid") {
        const target = Number(s["meta_float_target"] ?? 0);
        const { data: estimate } = await supabase.rpc("meta_balance_estimate", { p_org: orgId });
        const float = Number(estimate ?? 0);
        if (
          target > 0 &&
          float < target &&
          olderThan(s["last_float_low_notice_at"] as string | null, DAY_MS)
        ) {
          await notify(supabase, {
            organizationId: orgId,
            audience: "admin",
            kind: "float_low",
            payload: { estimate: float, target },
          });
          await supabase
            .from("organization_billing_settings")
            .upsert(
              { organization_id: orgId, last_float_low_notice_at: nowIso },
              { onConflict: "organization_id" },
            );
          counts.float_low += 1;
        }
      }

      // ---- automatic top-up the merchant asked for
      const autoThreshold = Number(s["auto_topup_threshold"] ?? 0);
      const packId = (s["auto_topup_pack_id"] as string | null) ?? null;
      if (s["auto_topup_enabled"] === true && packId && available < autoThreshold) {
        const { data: owner } = await supabase
          .from("organization_members")
          .select("user_id")
          .eq("organization_id", orgId)
          .eq("role", "owner")
          .order("created_at", { ascending: true })
          .limit(1)
          .maybeSingle();
        const ownerId = (owner as { user_id?: string } | null)?.user_id ?? null;
        if (ownerId) {
          const purchase = await createCreditPurchase(supabase, {
            organizationId: orgId,
            userId: ownerId,
            packId,
            origin: "https://aidwar.in",
          });
          if ("url" in purchase) {
            await notify(supabase, {
              organizationId: orgId,
              audience: "client",
              kind: "topup_requested",
              payload: { amount: null, link: purchase.url, auto: true },
            });
            counts.auto_topups += 1;
          }
        }
      }

      // ---- credits nobody used
      counts.expired += await expireCredits(supabase, orgId, s, counts);
    } catch {
      // one workspace must never stop the sweep
    }
  }

  // ---- overdue top-up reminders, at 4 hours and again at 24
  const { data: tasks } = await supabase
    .from("topup_tasks")
    .select("id, organization_id, due_at, reminders_sent, meta_amount")
    .eq("status", "pending")
    .lt("due_at", nowIso)
    .limit(100);

  for (const task of ((tasks ?? []) as Record<string, unknown>[])) {
    try {
      const overdueMs = Date.now() - new Date(String(task["due_at"])).getTime();
      const sentAlready = Number(task["reminders_sent"] ?? 0);
      const shouldHave = overdueMs > 24 * 3600e3 ? 2 : overdueMs > 4 * 3600e3 ? 1 : 0;
      if (shouldHave <= sentAlready) continue;

      const { notify } = await import("@/lib/billing.server");
      await notify(supabase, {
        organizationId: (task["organization_id"] as string) ?? null,
        audience: "admin",
        kind: "topup_reminder",
        payload: { task_id: task["id"], meta_amount: Number(task["meta_amount"] ?? 0) },
      });
      await supabase
        .from("topup_tasks")
        .update({ reminders_sent: shouldHave, last_reminder_at: nowIso })
        .eq("id", task["id"] as string);
      counts.reminders += 1;
    } catch {
      // a reminder failing is never worth losing the rest of the sweep
    }
  }

  return counts;
}

/**
 * Expires whole purchases the workspace never touched. A purchase counts as
 * untouched only when the balance has never dipped below where that purchase
 * left it — a partly-spent pack is left alone and logged as a skip.
 */
async function expireCredits(
  supabase: SupabaseClient,
  organizationId: string,
  settings: Record<string, unknown>,
  counts: SweepCounts,
): Promise<number> {
  const months = Number(settings["credits_expire_months"] ?? 0);
  if (!(months > 0)) return 0;
  if (!olderThan(settings["last_expiry_sweep_at"] as string | null, DAY_MS)) return 0;

  const cutoff = new Date(Date.now() - months * 30 * DAY_MS).toISOString();
  const { data: entries } = await supabase
    .from("wallet_ledger")
    .select("id, entry_type, amount, balance_after, created_at, metadata")
    .eq("organization_id", organizationId)
    .in("entry_type", ["credit_purchase", "bonus_credits", "coupon_credits", "starter_credits"])
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(50);

  let expired = 0;
  for (const entry of ((entries ?? []) as Record<string, unknown>[])) {
    const metadata = (entry["metadata"] ?? {}) as Record<string, unknown>;
    if (metadata["expired"] === true) continue;

    const { data: after } = await supabase
      .from("wallet_ledger")
      .select("balance_after")
      .eq("organization_id", organizationId)
      .gt("created_at", entry["created_at"] as string)
      .order("balance_after", { ascending: true })
      .limit(1)
      .maybeSingle();

    const lowest = after ? Number((after as { balance_after: number }).balance_after) : null;
    const level = Number(entry["balance_after"] ?? 0);
    if (lowest !== null && lowest < level) {
      counts.expiry_skipped += 1;
      continue;
    }

    const amount = Number(entry["amount"] ?? 0);
    if (!(amount > 0)) continue;

    const { error } = await supabase.rpc("wallet_apply", {
      p_org: organizationId,
      p_type: "expiry",
      p_amount: -amount,
      p_ref_type: "wallet_ledger",
      p_ref_id: entry["id"],
      p_description: "Credits expired",
      p_metadata: { source_entry: entry["id"] },
    });
    if (error) {
      counts.expiry_skipped += 1;
      continue;
    }
    await supabase
      .from("wallet_ledger")
      .update({ metadata: { ...metadata, expired: true } })
      .eq("id", entry["id"] as string);
    expired += 1;
  }

  await supabase
    .from("organization_billing_settings")
    .upsert(
      { organization_id: organizationId, last_expiry_sweep_at: new Date().toISOString() },
      { onConflict: "organization_id" },
    );

  return expired;
}
