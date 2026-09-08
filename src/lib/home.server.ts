/**
 * The workspace's front page: what happened today, who is waiting on the
 * owner, and what the AI employee picked up this week. Read-only.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type HomeSummary = {
  today: {
    conversations: number;
    ai_answers: number;
    escalations: number;
  };
  credits: { balance: number; currency: string } | null;
  plan: {
    name: string | null;
    status: string | null;
    trial_days_left: number | null;
  };
  waiting: Array<{
    id: string;
    question: string;
    asked_at: string;
    conversation_id: string | null;
    contact_name: string | null;
    source: string;
  }>;
  learned: Array<{
    source_id: string | null;
    source_name: string;
    source_type: string;
    items: number;
    latest_at: string;
  }>;
  generated_at: string;
};

function startOfTodayIso(timezone: string): string {
  // Midnight in the workspace's own timezone, expressed as an instant.
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const localMidnightAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0);
  const localNowAsUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  const offsetMs = now.getTime() - localNowAsUtc;
  return new Date(localMidnightAsUtc + offsetMs).toISOString();
}

export async function getHomeSummary(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<HomeSummary> {
  const { data: orgRow } = await supabase
    .from("organizations")
    .select("timezone, plan_status, trial_ends_at, plan_version_id")
    .eq("id", organizationId)
    .maybeSingle();
  const org = (orgRow ?? {}) as {
    timezone?: string | null;
    plan_status?: string | null;
    trial_ends_at?: string | null;
    plan_version_id?: string | null;
  };
  const timezone = org.timezone || "Asia/Kolkata";
  const since = startOfTodayIso(timezone);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [
    convs,
    answers,
    escalations,
    wallet,
    planVersion,
    pending,
    learnedRows,
  ] = await Promise.all([
    supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .gte("last_customer_message_at", since),
    supabase
      .from("ai_runs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("task", "agent_reply")
      .eq("status", "ok")
      .gte("created_at", since),
    supabase
      .from("ai_runs")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "escalated")
      .gte("created_at", since),
    supabase
      .from("wallet_balances")
      .select("balance, currency")
      .eq("organization_id", organizationId)
      .maybeSingle(),
    org.plan_version_id
      ? supabase
          .from("plan_versions")
          .select("plan_id, plans(name)")
          .eq("id", org.plan_version_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("pending_owner_replies")
      .select("id, question, created_at, conversation_id, contact_id, source")
      .eq("organization_id", organizationId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(3),
    supabase
      .from("knowledge_documents")
      .select("source_id, created_at")
      .eq("organization_id", organizationId)
      .gte("created_at", weekAgo)
      .order("created_at", { ascending: false })
      .limit(2000),
  ]);

  // Names for the people waiting.
  const contactIds = Array.from(
    new Set(
      ((pending.data ?? []) as Array<{ contact_id: string | null }>)
        .map((p) => p.contact_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const contactNames = new Map<string, string | null>();
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, name, phone")
      .in("id", contactIds);
    for (const c of (contacts ?? []) as Array<{ id: string; name: string | null; phone: string }>) {
      contactNames.set(c.id, c.name || c.phone);
    }
  }

  // Group the week's new items by the source they came from.
  const bySource = new Map<string, { items: number; latest_at: string }>();
  for (const row of (learnedRows.data ?? []) as Array<{ source_id: string | null; created_at: string }>) {
    const key = row.source_id ?? "none";
    const entry = bySource.get(key) ?? { items: 0, latest_at: row.created_at };
    entry.items += 1;
    if (row.created_at > entry.latest_at) entry.latest_at = row.created_at;
    bySource.set(key, entry);
  }
  const sourceIds = Array.from(bySource.keys()).filter((k) => k !== "none");
  const sourceMeta = new Map<string, { name: string; type: string }>();
  if (sourceIds.length > 0) {
    const { data: sources } = await supabase
      .from("knowledge_sources")
      .select("id, name, type")
      .in("id", sourceIds);
    for (const s of (sources ?? []) as Array<{ id: string; name: string; type: string }>) {
      sourceMeta.set(s.id, { name: s.name, type: s.type });
    }
  }

  const trialEnds = org.trial_ends_at ? new Date(org.trial_ends_at).getTime() : null;
  const trialDaysLeft =
    trialEnds !== null && !org.plan_version_id
      ? Math.max(0, Math.ceil((trialEnds - Date.now()) / (24 * 60 * 60 * 1000)))
      : null;

  const planName =
    ((planVersion.data as { plans?: { name?: string } | { name?: string }[] | null } | null)?.plans
      ? (() => {
          const p = (planVersion.data as { plans: { name?: string } | { name?: string }[] }).plans;
          return Array.isArray(p) ? (p[0]?.name ?? null) : (p.name ?? null);
        })()
      : null);

  return {
    today: {
      conversations: convs.count ?? 0,
      ai_answers: answers.count ?? 0,
      escalations: escalations.count ?? 0,
    },
    credits: wallet.data
      ? {
          balance: Number((wallet.data as { balance?: number }).balance ?? 0),
          currency: String((wallet.data as { currency?: string }).currency ?? "INR"),
        }
      : null,
    plan: { name: planName, status: org.plan_status ?? null, trial_days_left: trialDaysLeft },
    waiting: ((pending.data ?? []) as Array<{
      id: string;
      question: string;
      created_at: string;
      conversation_id: string | null;
      contact_id: string | null;
      source: string;
    }>).map((p) => ({
      id: p.id,
      question: p.question,
      asked_at: p.created_at,
      conversation_id: p.conversation_id,
      contact_name: p.contact_id ? (contactNames.get(p.contact_id) ?? null) : null,
      source: p.source,
    })),
    learned: Array.from(bySource.entries())
      .map(([key, v]) => ({
        source_id: key === "none" ? null : key,
        source_name: sourceMeta.get(key)?.name ?? "Notes",
        source_type: sourceMeta.get(key)?.type ?? "manual_qa",
        items: v.items,
        latest_at: v.latest_at,
      }))
      .sort((a, b) => b.items - a.items),
    generated_at: new Date().toISOString(),
  };
}
