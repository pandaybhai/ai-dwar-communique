import type { SupabaseClient } from "@supabase/supabase-js";
import { CALLS_PER_MINUTE, MCP_FLAG, SENDS_PER_HOUR, mcpAccessOn } from "@/lib/mcp-access.server";
import type { AssistantsOverview, AssistantApp, AssistantEvent } from "@/lib/mcp-workspace";
import { MCP_ACTIONS } from "@/lib/mcp-workspace";

/**
 * Batch 53: the AI assistants page's reads and its one write.
 *
 * - Connected apps: Supabase Auth's OAuth consents for the workspace's
 *   members (mcp_workspace_apps, 20261270), owners and admins see everyone's,
 *   others their own. Before 20261270 `apps` is null and the page lists the
 *   person's own grants from Supabase Auth in the browser, as Batch 52 did.
 * - What your AI did: activity_log rows the MCP server wrote (source "mcp",
 *   the five mcp_* actions) for this workspace only.
 * - Usage: Batch 34's api_rate_windows, the buckets AiDwar MCP counts in
 *   (mcp:user:<id> per minute, mcp:send:<org> per hour). Read only.
 * - The switch: the workspace's mcp_access override, settings.manage only,
 *   audit-logged. A workspace AiDwar support switched off by hand
 *   (_manual_flags.mcp false) can't be switched back on here.
 * Nothing here changes how the MCP tools behave.
 */

type Caller = { organizationId: string; userId: string; role: string; permissions: Set<string> };

const seesEveryone = (role: string) => role === "owner" || role === "admin";

async function supportSwitchedOff(service: SupabaseClient, organizationId: string): Promise<boolean> {
  const { data } = await service
    .from("organization_billing_settings")
    .select("limits_override")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const limits = ((data as { limits_override?: Record<string, unknown> } | null)?.limits_override ?? {}) as Record<
    string,
    unknown
  >;
  const manual = (limits["_manual_flags"] ?? {}) as Record<string, unknown>;
  return manual["mcp"] === false;
}

async function names(service: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data } = await service.from("profiles").select("id, full_name, email").in("id", ids);
  for (const p of (data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) {
    out.set(p.id, p.full_name?.trim() || p.email || "A team member");
  }
  return out;
}

async function hitsIn(service: SupabaseClient, bucket: string, windowSeconds: number, now: number): Promise<number> {
  const start = new Date(Math.floor(now / 1000 / windowSeconds) * windowSeconds * 1000).toISOString();
  const { data, error } = await service
    .from("api_rate_windows")
    .select("hits")
    .eq("bucket", bucket)
    .eq("window_start", start)
    .maybeSingle();
  if (error) return 0;
  return Number((data as { hits?: number } | null)?.hits ?? 0);
}

export function objectLink(action: string, objectId: string | null): string | null {
  if (!objectId) return null;
  if (action === "mcp_segment_created") return "/app/contacts?tab=segments";
  if (action === "mcp_campaign_drafted" || action === "mcp_campaign_sent") return `/app/campaigns/${objectId}`;
  if (action === "mcp_flow_drafted" || action === "mcp_flow_activated") return `/app/flows/v2/${objectId}`;
  return null;
}

export async function assistantsOverview(
  service: SupabaseClient,
  caller: Caller,
  filters: { app?: string | null; member?: string | null } = {},
  now = Date.now(),
): Promise<AssistantsOverview> {
  const org = caller.organizationId;
  const everyone = seesEveryone(caller.role);

  const [mcpOn, locked, appsRes] = await Promise.all([
    mcpAccessOn(service, org),
    supportSwitchedOff(service, org),
    service.rpc("mcp_workspace_apps", { p_org: org, p_user: everyone ? null : caller.userId }),
  ]);

  let timelineQ = service
    .from("activity_log")
    .select("id, user_id, action, details, created_at")
    .eq("organization_id", org)
    .in("action", MCP_ACTIONS as unknown as string[])
    .eq("details->>source", "mcp")
    .order("created_at", { ascending: false })
    .limit(100);
  if (!everyone) timelineQ = timelineQ.eq("user_id", caller.userId);
  else if (filters.member) timelineQ = timelineQ.eq("user_id", filters.member);
  if (filters.app) timelineQ = timelineQ.eq("details->>client_id", filters.app);
  const { data: logRows } = await timelineQ;

  const rawApps = appsRes.error
    ? null
    : ((appsRes.data ?? []) as Array<{
        user_id: string;
        client_id: string;
        client_name: string | null;
        client_uri: string | null;
        granted_at: string | null;
        last_used_at: string | null;
      }>);
  const logs = (logRows ?? []) as Array<{
    id: string;
    user_id: string | null;
    action: string;
    details: Record<string, unknown> | null;
    created_at: string;
  }>;

  const who = await names(
    service,
    Array.from(new Set([...(rawApps ?? []).map((a) => a.user_id), ...logs.map((l) => l.user_id ?? "")].filter(Boolean))),
  );

  const apps: AssistantApp[] | null = rawApps
    ? rawApps.map((a) => {
        let site: string | null = null;
        try {
          site = a.client_uri ? new URL(a.client_uri).host : null;
        } catch {
          site = null;
        }
        return {
          userId: a.user_id,
          member: a.user_id === caller.userId ? "You" : (who.get(a.user_id) ?? "A team member"),
          mine: a.user_id === caller.userId,
          clientId: a.client_id,
          name: a.client_name?.trim() || "An AI app",
          site,
          grantedAt: a.granted_at,
          lastUsedAt: a.last_used_at,
        };
      })
    : null;

  const timeline: AssistantEvent[] = logs.map((l) => {
    const d = l.details ?? {};
    const objectId = typeof d["object_id"] === "string" ? (d["object_id"] as string) : null;
    return {
      id: l.id,
      action: l.action,
      at: l.created_at,
      userId: l.user_id,
      member: l.user_id === caller.userId ? "You" : (who.get(l.user_id ?? "") ?? "A team member"),
      app: (typeof d["client_name"] === "string" && d["client_name"]) || "An AI app",
      appId: typeof d["client_id"] === "string" ? (d["client_id"] as string) : null,
      name: typeof d["name"] === "string" ? (d["name"] as string) : null,
      link: objectLink(l.action, objectId),
    };
  });

  const [calls, sends] = await Promise.all([
    hitsIn(service, `mcp:user:${caller.userId}`, 60, now),
    hitsIn(service, `mcp:send:${org}`, 3600, now),
  ]);

  return {
    mcpOn,
    supportLocked: locked,
    canManage: caller.permissions.has("settings.manage"),
    seesEveryone: everyone,
    apps,
    timeline,
    usage: {
      callsThisMinute: calls,
      callsPerMinute: CALLS_PER_MINUTE,
      sendsThisHour: sends,
      sendsPerHour: SENDS_PER_HOUR,
    },
  };
}

export type SetAccessResult = { ok: true; enabled: boolean } | { ok: false; status: number; error: string };

/** The workspace's On/Off for AiDwar MCP. The route checks settings.manage first. */
export async function setMcpAccess(
  service: SupabaseClient,
  args: { organizationId: string; userId: string; enabled: boolean },
): Promise<SetAccessResult> {
  if (args.enabled && (await supportSwitchedOff(service, args.organizationId))) {
    return {
      ok: false,
      status: 403,
      error: "AiDwar support switched AI assistants off for this workspace. Write to support to switch it back on.",
    };
  }
  const { error } = await service
    .from("organization_feature_overrides")
    .upsert(
      { organization_id: args.organizationId, flag_key: MCP_FLAG, enabled: args.enabled },
      { onConflict: "organization_id,flag_key" },
    );
  if (error) return { ok: false, status: 400, error: "We couldn't change that. Please try again." };
  const { logServerActivity } = await import("@/lib/whatsapp-api.server");
  await logServerActivity(service, args.organizationId, args.userId, "mcp_access_changed", {
    enabled: args.enabled,
    via: "ai_assistants_page",
  });
  return { ok: true, enabled: args.enabled };
}
