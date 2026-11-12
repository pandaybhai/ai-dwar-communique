import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch 76: who may use the admin area, server side.
 *
 * - "super_admin" (profiles.is_super_admin): everything, exactly as before.
 * - "sales" (profiles.is_sales): Leads & Demos only — /admin/leads and
 *   /api/admin/leads (and /api/admin/access to learn their own role). Every
 *   other /api/admin/* route keeps its own super-admin check, unchanged, so a
 *   sales member gets 403 there.
 * Both flags are only set by the server or a super admin (the profiles guard
 * keeps a user from raising their own).
 */

export type AdminRole = "super_admin" | "sales";

export async function adminRole(
  supabase: SupabaseClient,
  userId: string,
): Promise<AdminRole | null> {
  const { data } = await supabase
    .from("profiles")
    .select("is_super_admin, is_sales")
    .eq("id", userId)
    .maybeSingle();
  const row = data as { is_super_admin?: boolean; is_sales?: boolean } | null;
  if (row?.is_super_admin === true) return "super_admin";
  if (row?.is_sales === true) return "sales";
  return null;
}

/** The signed-in user (bearer token) and their admin role, or the refusal to send back. */
export async function requireAdminRole(
  request: Request,
  allowed: readonly AdminRole[],
): Promise<{ supabase: SupabaseClient; userId: string; role: AdminRole } | Response> {
  const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
  const { jsonError } = await import("@/lib/whatsapp-api.server");
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return jsonError("Not authenticated.", 401);
  // Batch 52: an AI app's OAuth token works only through /mcp.
  const refusedClient = (await import("@/lib/mcp-auth.server")).refuseOAuthClientToken(token);
  if (refusedClient) return refusedClient;
  const supabase = getServiceClient();
  const { data } = await supabase.auth.getUser(token);
  const user = data.user;
  if (!user) return jsonError("Not authenticated.", 401);
  const role = await adminRole(supabase, user.id);
  if (!role || !allowed.includes(role)) {
    return jsonError(
      allowed.includes("sales") ? "Leads access required." : "Super Admin access required.",
      403,
    );
  }
  return { supabase, userId: user.id, role };
}

/** True when this user belongs to at least one workspace (a sales-only user has none). */
export async function hasWorkspace(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { count } = await supabase
    .from("organization_members")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", userId);
  return (count ?? 0) > 0;
}
