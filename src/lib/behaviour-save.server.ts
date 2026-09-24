import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The one save path for "How I behave" (ai_instructions versions). The
 * merchant screen (/api/ai/employee, user client, RLS) and the admin control
 * centre (/api/admin/ai, service client after the super-admin check) both
 * call this, so versioning, conflict checks and audit rows never drift.
 */

export const DEFAULT_HANDOVER =
  "Let me get someone from the team to help — they'll reply here shortly.";

export type BehaviourFields = {
  persona_name: string;
  tone: string;
  instructions: string;
  escalation_rules: string;
  handover_message: string;
  languages: string[];
  working_hours_behaviour: string;
};

export type Conflict = { by: string; at: string; version: number };

export type SaveResult =
  | { ok: true; version: number; previous: number }
  | { ok: false; conflict: Conflict }
  | { ok: false; error: string };

export function fieldsFromPayload(payload: Record<string, unknown>, fallbackName: string): BehaviourFields {
  return {
    persona_name: String(payload["persona_name"] ?? fallbackName),
    tone: String(payload["tone"] ?? "friendly"),
    instructions: String(payload["instructions"] ?? ""),
    escalation_rules: String(payload["escalation_rules"] ?? ""),
    handover_message: String(payload["handover_message"] ?? "").trim() || DEFAULT_HANDOVER,
    languages:
      Array.isArray(payload["languages"]) && payload["languages"].length
        ? (payload["languages"] as unknown[]).map(String)
        : ["en", "hi"],
    working_hours_behaviour: String(payload["working_hours_behaviour"] ?? "always"),
  };
}

/** Display names for version authors. Super admins read as "AiDwar support" to merchants. */
export async function authorNames(
  ids: string[],
  audience: "merchant" | "admin",
): Promise<Record<string, { name: string; is_support: boolean }>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { data } = await getServiceClient()
    .from("profiles")
    .select("id, full_name, email, is_super_admin")
    .in("id", unique);
  const out: Record<string, { name: string; is_support: boolean }> = {};
  for (const row of (data ?? []) as Array<{
    id: string;
    full_name: string | null;
    email: string | null;
    is_super_admin: boolean | null;
  }>) {
    const own = row.full_name?.trim() || row.email?.split("@")[0] || "Someone";
    const support = Boolean(row.is_super_admin);
    out[row.id] = {
      name: support && audience === "merchant" ? "AiDwar support" : own,
      is_support: support,
    };
  }
  return out;
}

async function latest(supabase: SupabaseClient, agentId: string) {
  const { data } = await supabase
    .from("ai_instructions")
    .select("version, updated_by, updated_at")
    .eq("agent_id", agentId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data as { version: number; updated_by: string | null; updated_at: string } | null;
}

/**
 * Writes a new current version. When baseVersion is given and someone saved
 * a newer one since, nothing is written and the conflict is returned.
 */
export async function saveBehaviourVersion(
  supabase: SupabaseClient,
  input: {
    organizationId: string;
    agentId: string;
    userId: string | null;
    fields: BehaviourFields;
    /** Defaults from `via`: owner → "owner", super_admin → "admin". */
    origin?: "owner" | "admin" | "suggested";
    baseVersion?: number | null;
    audience: "merchant" | "admin";
    via: "owner" | "super_admin" | "system";
    reverted_from?: number;
  },
): Promise<SaveResult> {
  const top = await latest(supabase, input.agentId);
  const previous = Number(top?.version ?? 0);
  if (input.baseVersion != null && Number.isFinite(input.baseVersion) && previous !== input.baseVersion) {
    const names = await authorNames(top?.updated_by ? [top.updated_by] : [], input.audience);
    return {
      ok: false,
      conflict: {
        by: (top?.updated_by && names[top.updated_by]?.name) || "someone else",
        at: top?.updated_at ?? new Date().toISOString(),
        version: previous,
      },
    };
  }
  const nextVersion = previous + 1;
  await supabase.from("ai_instructions").update({ is_current: false }).eq("agent_id", input.agentId);
  const { error } = await supabase.from("ai_instructions").insert({
    organization_id: input.organizationId,
    agent_id: input.agentId,
    ...input.fields,
    version: nextVersion,
    is_current: true,
    updated_by: input.userId,
    origin: input.origin ?? (input.via === "owner" ? "owner" : input.via === "super_admin" ? "admin" : "suggested"),
  });
  if (error) return { ok: false, error: "We couldn't save that." };
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(supabase, input.organizationId, input.userId, "ai_instructions_updated", {
    version: nextVersion,
    old_version: previous,
    by: input.via,
    origin: input.origin ?? null,
    ...(input.reverted_from != null ? { reverted_from: input.reverted_from } : {}),
  });
  return { ok: true, version: nextVersion, previous };
}

export function conflictMessage(c: Conflict): string {
  const when = new Date(c.at).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
  return `Updated by ${c.by} ${when} — reload to see their change.`;
}
