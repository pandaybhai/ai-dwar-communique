/**
 * Batch 53: what the AI assistants page shows (GET /api/ai-assistants),
 * shared by the page and the server. Pure types and words.
 */

/** The activity actions AiDwar MCP writes (source "mcp"), in timeline words. */
export const MCP_ACTIONS = [
  "mcp_segment_created",
  "mcp_campaign_drafted",
  "mcp_campaign_sent",
  "mcp_flow_drafted",
  "mcp_flow_activated",
] as const;

export const ACTION_WORDS: Record<string, string> = {
  mcp_segment_created: "created a segment",
  mcp_campaign_drafted: "drafted a campaign",
  mcp_campaign_sent: "sent a campaign (you confirmed)",
  mcp_flow_drafted: "drafted a flow",
  mcp_flow_activated: "switched a flow on (you confirmed)",
};

export type AssistantApp = {
  userId: string;
  /** "You" for the caller's own. */
  member: string;
  mine: boolean;
  clientId: string;
  name: string;
  site: string | null;
  grantedAt: string | null;
  lastUsedAt: string | null;
};

export type AssistantEvent = {
  id: string;
  action: string;
  at: string;
  userId: string | null;
  member: string;
  app: string;
  appId: string | null;
  name: string | null;
  link: string | null;
};

export type AssistantsOverview = {
  /** mcp_access for this workspace. */
  mcpOn: boolean;
  /** AiDwar support switched it off by hand: the owner can't switch it back on. */
  supportLocked: boolean;
  /** settings.manage: the On/Off switch shows. */
  canManage: boolean;
  /** Owners and admins see everyone's apps and activity; others their own. */
  seesEveryone: boolean;
  /** null before 20261270 is applied (the page then lists the person's own grants). */
  apps: AssistantApp[] | null;
  timeline: AssistantEvent[];
  usage: { callsThisMinute: number; callsPerMinute: number; sendsThisHour: number; sendsPerHour: number };
};
