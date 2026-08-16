import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/lib/whatsapp-webhook.server";

export const GRAPH_VERSION = "v25.0";

export type AuthContext = {
  supabase: SupabaseClient;
  userId: string;
  organizationId: string;
  role: "owner" | "admin" | "marketer" | "agent";
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

/**
 * Permission gate for server routes. Mirrors public.has_permission — never a
 * role-name comparison, so per-member overrides are honoured everywhere.
 * Returns null when allowed, or the 403 Response to send back.
 */
export async function requirePermission(
  auth: AuthContext,
  permission: string,
  friendlyAction = "do this",
): Promise<Response | null> {
  const { hasPermission } = await import("@/lib/permissions.server");
  const allowed = await hasPermission(auth.supabase, auth.organizationId, auth.userId, permission);
  if (allowed) return null;
  return jsonError(`You don't have permission to ${friendlyAction} in this workspace.`, 403);
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

/** True only for platform super admins (profiles.is_super_admin). */
export async function isSuperAdmin(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("profiles")
    .select("is_super_admin")
    .eq("id", userId)
    .maybeSingle();
  return (data as { is_super_admin?: boolean } | null)?.is_super_admin === true;
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
  const code = Number(err?.["code"] ?? 0);
  // 131005 with a valid token almost always means the Meta app restricts which
  // server IPs may call the API — our senders run on shared cloud IPs.
  if (code === 131005) {
    return "Meta refused this send with “Access denied”. The connected Meta app is restricting which server IP addresses can call the API — remove the server IP allowlist in the Meta app settings (App settings → Advanced → Allowed server IPs) and try again.";
  }
  const msg = (err?.["error_user_msg"] ?? err?.["message"]) as string | undefined;
  return msg ?? "The messaging provider rejected the request.";
}


/** Re-exported from the shared helper so every write path agrees. */
export { normalizePhone, toWaId } from "@/lib/phone";


export type TokenInfo = {
  expires_at: string | null;
  granted_scopes: string[] | null;
  error: string | null;
};

/**
 * Introspects a business token with Meta's /debug_token endpoint using the app
 * access token, so we can persist the real expiry instead of guessing. A token
 * that silently expires takes campaigns down, so callers log a null expiry.
 */
export async function debugToken(inputToken: string): Promise<TokenInfo> {
  const appId = process.env["META_APP_ID"];
  const appSecret = process.env["META_APP_SECRET"];
  if (!appId || !appSecret) {
    return { expires_at: null, granted_scopes: null, error: "meta_app_credentials_missing" };
  }

  try {
    const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token`);
    url.searchParams.set("input_token", inputToken);
    url.searchParams.set("access_token", `${appId}|${appSecret}`);
    const res = await fetch(url.toString());
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) return { expires_at: null, granted_scopes: null, error: graphErrorMessage(body) };

    const data = (body["data"] ?? {}) as Record<string, unknown>;
    const expiresAtSeconds = Number(data["expires_at"] ?? 0);
    const scopes = Array.isArray(data["scopes"]) ? (data["scopes"] as string[]) : null;
    // 0 means "never expires" for system-user tokens — still not a real date.
    const expiresAt =
      Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0
        ? new Date(expiresAtSeconds * 1000).toISOString()
        : null;
    return { expires_at: expiresAt, granted_scopes: scopes, error: null };
  } catch {
    return { expires_at: null, granted_scopes: null, error: "debug_token_unreachable" };
  }
}

export const TOKEN_EXPIRY_WARNING_DAYS = 7;

/** Shared expiry classification used by the status route and the UI banner. */
export function classifyTokenExpiry(expiresAt: string | null | undefined): {
  expires_at: string | null;
  days_left: number | null;
  token_expiring: boolean;
  token_expired: boolean;
  expiry_unknown: boolean;
} {
  if (!expiresAt) {
    return {
      expires_at: null,
      days_left: null,
      token_expiring: false,
      token_expired: false,
      expiry_unknown: true,
    };
  }
  const ms = new Date(expiresAt).getTime() - Date.now();
  const days = ms / 86_400_000;
  return {
    expires_at: expiresAt,
    days_left: Math.floor(days),
    token_expiring: days > 0 && days < TOKEN_EXPIRY_WARNING_DAYS,
    token_expired: ms <= 0,
    expiry_unknown: false,
  };
}
