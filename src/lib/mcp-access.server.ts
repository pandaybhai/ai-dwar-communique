import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch 52: may this person use AiDwar MCP in this workspace, right now?
 *
 * - The kill switch: flag mcp_access, ON by default for every plan (incl.
 *   trial); a workspace override (Super Admin -> Flags) turns it off. A flag
 *   row that doesn't exist yet (20261260 not applied) counts as on.
 * - The person: a member of the workspace (never a super admin who isn't —
 *   MCP never broadens access) holding mcp.use. A database that doesn't know
 *   mcp.use yet allows it, so the code works before 20261260.
 * - Rate limits on Batch 34's api_rate_take: 60 tool calls a minute per
 *   person, 5 campaign sends an hour per workspace. A limiter that can't
 *   answer refuses (never an unlimited path).
 */

export const MCP_FLAG = "mcp_access";
export const CALLS_PER_MINUTE = 60;
export const SENDS_PER_HOUR = 5;

export type Workspace = { id: string; name: string; role: string };

export async function mcpAccessOn(db: SupabaseClient, organizationId: string): Promise<boolean> {
  const [{ data: flag, error: flagError }, { data: override, error: overrideError }] = await Promise.all([
    db.from("feature_flags").select("default_enabled").eq("key", MCP_FLAG).maybeSingle(),
    db
      .from("organization_feature_overrides")
      .select("enabled")
      .eq("organization_id", organizationId)
      .eq("flag_key", MCP_FLAG)
      .maybeSingle(),
  ]);
  // A read that failed is not "switched on": the kill switch must hold.
  if (flagError || overrideError) return false;
  const o = override as { enabled?: boolean } | null;
  if (o && typeof o.enabled === "boolean") return o.enabled;
  const f = flag as { default_enabled?: boolean } | null;
  return f ? f.default_enabled === true : true;
}

/** mcp.use for this member, or true while the permission row doesn't exist yet. */
export async function mcpUseAllowed(db: SupabaseClient, keys: string[]): Promise<boolean> {
  if (keys.includes("mcp.use")) return true;
  const { data, error } = await db.from("permissions").select("key").eq("key", "mcp.use").maybeSingle();
  if (error) return false;
  return !data;
}

/** The workspaces this person is a member of, oldest membership first. */
export async function memberWorkspaces(db: SupabaseClient, userId: string): Promise<Workspace[]> {
  const { data } = await db
    .from("organization_members")
    .select("organization_id, role, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  const rows = (data ?? []) as Array<{ organization_id: string; role: string }>;
  if (!rows.length) return [];
  const { data: orgs } = await db
    .from("organizations")
    .select("id, name")
    .in(
      "id",
      rows.map((r) => r.organization_id),
    );
  const names = new Map(((orgs ?? []) as Array<{ id: string; name: string }>).map((o) => [o.id, o.name]));
  return rows.map((r) => ({ id: r.organization_id, name: names.get(r.organization_id) ?? "Workspace", role: r.role }));
}

export type WorkspacePick =
  | { ok: true; workspace: Workspace }
  | { ok: false; reason: "none" | "pick" | "not_member"; workspaces: Workspace[] };

/** One workspace: the one named (a membership), the only one, or ask. */
export function pickWorkspace(workspaces: Workspace[], requested?: string | null): WorkspacePick {
  if (requested) {
    const found = workspaces.find((w) => w.id === requested);
    return found ? { ok: true, workspace: found } : { ok: false, reason: "not_member", workspaces };
  }
  if (workspaces.length === 1) return { ok: true, workspace: workspaces[0]! };
  return { ok: false, reason: workspaces.length ? "pick" : "none", workspaces };
}

export type RateAnswer = { allowed: true } | { allowed: false; retryAfter: number };

async function take(db: SupabaseClient, bucket: string, limit: number, windowSeconds: number): Promise<RateAnswer> {
  const { data, error } = await db.rpc("api_rate_take", {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  if (error) return { allowed: false, retryAfter: 60 };
  const row = (Array.isArray(data) ? data[0] : data) as { allowed?: boolean; retry_after?: number } | null;
  if (row?.allowed) return { allowed: true };
  return { allowed: false, retryAfter: Math.max(1, Number(row?.retry_after ?? windowSeconds)) };
}

export function takeCallRate(db: SupabaseClient, userId: string): Promise<RateAnswer> {
  return take(db, `mcp:user:${userId}`, CALLS_PER_MINUTE, 60);
}

export function takeSendRate(db: SupabaseClient, organizationId: string): Promise<RateAnswer> {
  return take(db, `mcp:send:${organizationId}`, SENDS_PER_HOUR, 3600);
}
