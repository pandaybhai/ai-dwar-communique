import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * One row per organisation for the super-admin customer list. Read-only;
 * every action from that page reuses the org billing sheet.
 */
export type CustomerRow = {
  organization_id: string;
  name: string;
  owner_phone: string | null;
  owner_email: string | null;
  signed_up_at: string;
  attribution_plan: string | null;
  onboarding_status: string | null;
  onboarding_step: string | null;
  trial_ends_at: string | null;
  plan_status: string;
  plan_name: string | null;
  wallet_balance: number;
  last_inbound_at: string | null;
  open_questions: number;
  queues: Array<"stuck" | "trial_ending" | "asked_human" | "locked">;
};

const DAY_MS = 864e5;

export async function listCustomers(supabase: SupabaseClient): Promise<CustomerRow[]> {
  const [{ data: orgs }, { data: sessions }, { data: wallets }, { data: pending }, { data: inbound }, { data: owners }] =
    await Promise.all([
      supabase
        .from("organizations")
        .select(
          "id, name, created_at, plan_status, plan_version_id, trial_ends_at, plan_versions:plan_version_id(plans(name))",
        )
        .order("created_at", { ascending: false }),
      supabase
        .from("onboarding_sessions")
        .select("organization_id, phone, status, step, attribution, last_inbound_at, created_at")
        .order("created_at", { ascending: false }),
      supabase.from("wallet_balances").select("organization_id, balance"),
      supabase.from("pending_owner_replies").select("organization_id").eq("status", "pending"),
      supabase
        .from("messages")
        .select("organization_id, created_at")
        .eq("direction", "inbound")
        .order("created_at", { ascending: false })
        .limit(5000),
      supabase
        .from("organization_members")
        .select("organization_id, role, profiles(phone, email)")
        .eq("role", "owner"),
    ]);

  const sessionByOrg = new Map<string, Record<string, unknown>>();
  for (const s of (sessions ?? []) as Record<string, unknown>[]) {
    const id = String(s["organization_id"]);
    if (!sessionByOrg.has(id)) sessionByOrg.set(id, s);
  }
  const walletByOrg = new Map<string, number>();
  for (const w of (wallets ?? []) as Record<string, unknown>[]) {
    walletByOrg.set(String(w["organization_id"]), Number(w["balance"] ?? 0));
  }
  const pendingByOrg = new Map<string, number>();
  for (const p of (pending ?? []) as Record<string, unknown>[]) {
    const id = String(p["organization_id"]);
    pendingByOrg.set(id, (pendingByOrg.get(id) ?? 0) + 1);
  }
  const inboundByOrg = new Map<string, string>();
  for (const m of (inbound ?? []) as Record<string, unknown>[]) {
    const id = String(m["organization_id"]);
    if (!inboundByOrg.has(id)) inboundByOrg.set(id, String(m["created_at"]));
  }
  const ownerByOrg = new Map<string, { phone: string | null; email: string | null }>();
  for (const o of (owners ?? []) as Record<string, unknown>[]) {
    const id = String(o["organization_id"]);
    const profile = (Array.isArray(o["profiles"]) ? o["profiles"][0] : o["profiles"]) as
      | Record<string, unknown>
      | null;
    if (!ownerByOrg.has(id)) {
      ownerByOrg.set(id, {
        phone: (profile?.["phone"] as string | null) ?? null,
        email: (profile?.["email"] as string | null) ?? null,
      });
    }
  }

  const now = Date.now();
  return ((orgs ?? []) as Record<string, unknown>[]).map((org) => {
    const id = String(org["id"]);
    const session = sessionByOrg.get(id) ?? null;
    const owner = ownerByOrg.get(id) ?? { phone: null, email: null };
    const version = (org["plan_versions"] ?? null) as Record<string, unknown> | null;
    const plan = (version?.["plans"] ?? null) as Record<string, unknown> | null;
    const attribution = (session?.["attribution"] ?? {}) as Record<string, unknown>;
    const planStatus = String(org["plan_status"] ?? "trial");
    const trialEndsAt = (org["trial_ends_at"] as string | null) ?? null;
    const onboardingStatus = (session?.["status"] as string | null) ?? null;
    const createdAt = String((session?.["created_at"] as string | null) ?? org["created_at"]);
    const openQuestions = pendingByOrg.get(id) ?? 0;

    const queues: CustomerRow["queues"] = [];
    if (
      onboardingStatus &&
      ["pending", "bound", "learning"].includes(onboardingStatus) &&
      now - new Date(createdAt).getTime() > DAY_MS
    ) {
      queues.push("stuck");
    }
    if (
      !org["plan_version_id"] &&
      trialEndsAt &&
      new Date(trialEndsAt).getTime() - now <= 3 * DAY_MS
    ) {
      queues.push("trial_ending");
    }
    if (openQuestions > 0) queues.push("asked_human");
    if (planStatus === "locked") queues.push("locked");

    return {
      organization_id: id,
      name: String(org["name"] ?? ""),
      owner_phone: (session?.["phone"] as string | null) ?? owner.phone,
      owner_email: owner.email,
      signed_up_at: String(org["created_at"]),
      attribution_plan: typeof attribution["plan"] === "string" ? (attribution["plan"] as string) : null,
      onboarding_status: onboardingStatus,
      onboarding_step: (session?.["step"] as string | null) ?? null,
      trial_ends_at: trialEndsAt,
      plan_status: planStatus,
      plan_name: (plan?.["name"] as string | null) ?? null,
      wallet_balance: walletByOrg.get(id) ?? 0,
      last_inbound_at:
        inboundByOrg.get(id) ?? ((session?.["last_inbound_at"] as string | null) ?? null),
      open_questions: openQuestions,
      queues,
    };
  });
}
