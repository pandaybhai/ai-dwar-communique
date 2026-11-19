import type { SupabaseClient } from "@supabase/supabase-js";
import { ownerFirstName, phoneLast4, sortRenewals, type RenewalRow } from "@/lib/renewals";

/**
 * Batch 82: Admin → Billing → Renewals due, and one workspace's own access
 * period for its banner. Service client reads; the callers check who asks
 * (Super Admin; a member of that workspace). Until 20261450 is applied the
 * column read fails and both answer "nothing".
 */

export async function listRenewals(supabase: SupabaseClient): Promise<RenewalRow[]> {
  const { data: orgs, error } = await supabase
    .from("organizations")
    .select("id, name, plan_period_ends_at")
    .not("plan_period_ends_at", "is", null)
    .order("plan_period_ends_at", { ascending: true })
    .limit(500);
  if (error || !orgs) return [];
  const list = orgs as Array<{ id: string; name: string | null; plan_period_ends_at: string }>;
  if (list.length === 0) return [];
  const ids = list.map((o) => o.id);

  const [{ data: owners }, { data: payments }] = await Promise.all([
    supabase
      .from("organization_members")
      .select("organization_id, user_id, created_at")
      .in("organization_id", ids)
      .eq("role", "owner")
      .order("created_at", { ascending: true }),
    supabase
      .from("payments")
      .select("organization_id, amount, raw, paid_at")
      .in("organization_id", ids)
      .eq("purpose", "plan_fee")
      .eq("status", "paid")
      .order("paid_at", { ascending: false }),
  ]);

  // The first owner of each workspace, then their profile (name, phone).
  const ownerOf = new Map<string, string>();
  for (const m of (owners ?? []) as Array<{ organization_id: string; user_id: string }>) {
    if (!ownerOf.has(m.organization_id)) ownerOf.set(m.organization_id, m.user_id);
  }
  const userIds = [...new Set(ownerOf.values())];
  const { data: people } = userIds.length
    ? await supabase.from("profiles").select("id, full_name, phone").in("id", userIds)
    : { data: [] };
  const profileOf = new Map<string, { full_name?: string | null; phone?: string | null }>();
  for (const p of (people ?? []) as Array<{
    id: string;
    full_name?: string | null;
    phone?: string | null;
  }>) {
    profileOf.set(p.id, p);
  }
  const ownerBy = new Map<string, { full_name?: string | null; phone?: string | null }>();
  for (const [org, user] of ownerOf) ownerBy.set(org, profileOf.get(user) ?? {});
  const lastBy = new Map<string, { amount: number; offer: string | null }>();
  for (const p of (payments ?? []) as Array<Record<string, unknown>>) {
    const org = String(p["organization_id"]);
    if (lastBy.has(org)) continue; // newest first
    const raw = (p["raw"] ?? {}) as Record<string, unknown>;
    lastBy.set(org, {
      amount: Number(p["amount"] ?? 0),
      offer: typeof raw["offer"] === "string" ? (raw["offer"] as string) : null,
    });
  }

  return sortRenewals(
    list.map((o) => {
      const owner = ownerBy.get(o.id) ?? {};
      const last = lastBy.get(o.id) ?? null;
      return {
        organization_id: o.id,
        name: o.name ?? "Workspace",
        owner_first_name: ownerFirstName(owner.full_name),
        phone_last4: phoneLast4(owner.phone),
        plan_period_ends_at: o.plan_period_ends_at,
        last_amount: last ? last.amount : null,
        offer: last ? last.offer : null,
      };
    }),
  );
}

/**
 * One workspace's access period for the app banner: its end, and whether its
 * latest paid plan fee is the /199 paid trial (only then the banner shows —
 * a monthly plan's invoices carry on as before).
 */
export async function accessPeriodOf(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ ends_at: string | null; paid_trial: boolean }> {
  const { data: org, error } = await supabase
    .from("organizations")
    .select("plan_period_ends_at")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) return { ends_at: null, paid_trial: false };
  const endsAt =
    (org as { plan_period_ends_at?: string | null } | null)?.plan_period_ends_at ?? null;
  if (!endsAt) return { ends_at: null, paid_trial: false };
  const { onPaidTrial } = await import("@/lib/plan-billing.server");
  return { ends_at: endsAt, paid_trial: await onPaidTrial(supabase, organizationId) };
}
