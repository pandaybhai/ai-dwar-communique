import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/lib/whatsapp-webhook.server";

export const GRAPH_VERSION = "v25.0";

export type AuthContext = {
  supabase: SupabaseClient;
  userId: string;
  organizationId: string;
  role: "owner" | "admin" | "agent";
};

export function jsonError(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Resolves the caller from the Authorization bearer token and their membership
 * in the requested organization. The organization is never taken from the body
 * unless it is confirmed against the caller's memberships.
 */
export async function requireOrgMember(
  request: Request,
  requestedOrgId?: string | null,
): Promise<AuthContext | Response> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  if (!token) return jsonError("Not authenticated.", 401);

  const supabase = getServiceClient();
  const { data: userData, error: userErr } = await supabase.auth.getUser(token);
  const user = userData?.user;
  if (userErr || !user) return jsonError("Not authenticated.", 401);

  let query = supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", user.id);
  if (requestedOrgId) query = query.eq("organization_id", requestedOrgId);

  const { data: memberships } = await query.order("created_at", { ascending: true }).limit(1);
  const membership = memberships?.[0];
  if (!membership) return jsonError("You don't have access to this workspace.", 403);

  return {
    supabase,
    userId: user.id,
    organizationId: membership.organization_id as string,
    role: membership.role as AuthContext["role"],
  };
}

export function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

/** Append-only activity logging from the server (never message contents). */
export async function logServerActivity(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
  action: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await supabase
      .from("activity_log")
      .insert({ organization_id: organizationId, user_id: userId, action, details });
  } catch {
    // logging must never break the action
  }
}

export type GraphResult = { ok: boolean; status: number; body: Record<string, unknown> };

export async function graphFetch(
  path: string,
  accessToken: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<GraphResult> {
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

  const res = await fetch(url.toString(), {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { ok: res.ok, status: res.status, body };
}

export function graphErrorMessage(body: Record<string, unknown>): string {
  const err = body["error"] as Record<string, unknown> | undefined;
  const msg = (err?.["error_user_msg"] ?? err?.["message"]) as string | undefined;
  return msg ?? "The messaging provider rejected the request.";
}

/** Re-exported from the shared helper so every write path agrees. */
export { normalizePhone, toWaId } from "@/lib/phone";

