/**
 * Batch 45: the new Home's reads. Every one goes through the signed-in
 * member's own client, so RLS scopes it to the workspace (and ai_runs' column
 * grants keep cost fields out); each also filters on organization_id. Read
 * only: nothing here writes, sends or changes Aiden. A read that fails
 * returns null and Home leaves its block out — nothing is guessed.
 */

import { aidwar } from "@/integrations/aidwar/client";
import { handoverReasonText } from "@/lib/ai-outcome";
import { localDayStartIso } from "@/lib/local-day";
import type { CampaignRow } from "@/lib/campaigns";
import {
  ACTIVE_CHAT_MS,
  WAITING_LOOKBACK_MS,
  readyDrafts,
  sentAidenReplies,
  flowsToday,
  type DraftRun,
  type FeedReply,
  type FlowToday,
  type HomeConversation,
  type ReadyDraft,
} from "@/lib/new-home";

const DAY_MS = 24 * 60 * 60_000;

type Contact = { id: string; name: string | null; phone: string } | null;

const one = <T>(v: T | T[] | null | undefined): T | null =>
  (Array.isArray(v) ? (v[0] ?? null) : (v ?? null)) as T | null;

/** The default agent's mode and the workspace AI switch, as the webhook reads them. */
export async function loadAidenMode(
  organizationId: string,
): Promise<{ agentMode: string | null; aiEnabled: boolean | null } | null> {
  const [agent, settings] = await Promise.all([
    aidwar
      .from("ai_agents")
      .select("mode")
      .eq("organization_id", organizationId)
      .eq("is_default", true)
      .maybeSingle(),
    aidwar
      .from("organization_ai_settings")
      .select("ai_enabled")
      .eq("organization_id", organizationId)
      .maybeSingle(),
  ]);
  if (agent.error) return null;
  return {
    agentMode: (agent.data as { mode?: string } | null)?.mode ?? null,
    aiEnabled: settings.error
      ? null
      : ((settings.data as { ai_enabled?: boolean } | null)?.ai_enabled ?? null),
  };
}

/**
 * Chats Aiden is handling right now: open, not assigned to a person, not
 * waiting for one, with a customer message in the last 30 minutes (counted
 * from the messages themselves, as Home's "chats today" is).
 */
export async function loadActiveChats(organizationId: string, now: number): Promise<number | null> {
  const { count, error } = await aidwar
    .from("conversations")
    .select("id, messages!inner(id)", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("status", "open")
    .is("assigned_to", null)
    .not("needs_human", "is", true)
    .eq("messages.direction", "inbound")
    .gte("messages.created_at", new Date(now - ACTIVE_CHAT_MS).toISOString());
  return error ? null : (count ?? 0);
}

async function contactsOf(ids: string[]): Promise<Map<string, Contact>> {
  const out = new Map<string, Contact>();
  if (ids.length === 0) return out;
  const { data } = await aidwar
    .from("conversations")
    .select("id, contact:contacts(id, name, phone)")
    .in("id", ids);
  for (const row of (data ?? []) as Array<{ id: string; contact: Contact | Contact[] }>) {
    out.set(row.id, one(row.contact));
  }
  return out;
}

export type FeedItem = FeedReply & { contact: Contact };

/** Aiden's latest replies that reached customers (last 7 days), one per chat. */
export async function loadAidenFeed(
  organizationId: string,
  now: number,
): Promise<FeedItem[] | null> {
  const { data: runs, error } = await aidwar
    .from("ai_runs")
    .select("conversation_id, output, input_summary, sources, created_at")
    .eq("organization_id", organizationId)
    .eq("task", "agent_reply")
    .eq("status", "ok")
    .not("conversation_id", "is", null)
    .gte("created_at", new Date(now - 7 * DAY_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) return null;
  const rows = (runs ?? []) as Array<{
    conversation_id: string | null;
    output: string | null;
    input_summary: string | null;
    sources: unknown;
    created_at: string;
  }>;
  if (rows.length === 0) return [];
  const ids = Array.from(new Set(rows.map((r) => r.conversation_id!).filter(Boolean)));
  const oldest = rows[rows.length - 1]!.created_at;
  const { data: msgs, error: msgError } = await aidwar
    .from("messages")
    .select("conversation_id, direction, body, sent_by, metadata, created_at")
    .in("conversation_id", ids)
    .eq("direction", "outbound")
    .gte("created_at", new Date(new Date(oldest).getTime() - 5_000).toISOString())
    .order("created_at", { ascending: false })
    .limit(300);
  if (msgError) return null;
  const replies = sentAidenReplies(rows, (msgs ?? []) as Parameters<typeof sentAidenReplies>[1], 3);
  const contacts = await contactsOf(replies.map((r) => r.conversationId));
  return replies.map((r) => ({ ...r, contact: contacts.get(r.conversationId) ?? null }));
}

export type NeedsYouItem = {
  key: string;
  conversationId: string | null;
  who: string;
  question: string;
  at: string;
};

/**
 * What only a person can answer: chats handed to a person (needs_human, the
 * Inbox's "Waiting for you"), then the questions Aiden is holding for the
 * owner (pending_owner_replies, from Home's own summary). At most 3, plus how
 * many chats wait in all.
 */
export async function loadNeedsYou(
  organizationId: string,
  held: Array<{
    id: string;
    question: string;
    asked_at: string;
    conversation_id: string | null;
    contact_name: string | null;
  }>,
): Promise<{ items: NeedsYouItem[]; total: number } | null> {
  const { data, error, count } = await aidwar
    .from("conversations")
    .select(
      "id, needs_human_question, needs_human_reason, needs_human_at, last_message_at, contact:contacts(id, name, phone)",
      {
        count: "exact",
      },
    )
    .eq("organization_id", organizationId)
    .eq("needs_human", true)
    .order("needs_human_at", { ascending: false, nullsFirst: false })
    .limit(3);
  if (error) return null;
  const items: NeedsYouItem[] = (
    (data ?? []) as Array<{
      id: string;
      needs_human_question: string | null;
      needs_human_reason: string | null;
      needs_human_at: string | null;
      last_message_at: string | null;
      contact: Contact | Contact[];
    }>
  ).map((c) => {
    const contact = one(c.contact);
    return {
      key: `c-${c.id}`,
      conversationId: c.id,
      who: contact?.name?.trim() || contact?.phone || "A customer",
      question:
        c.needs_human_question?.trim() ||
        handoverReasonText(c.needs_human_reason) ||
        "Waiting for a person.",
      at: c.needs_human_at ?? c.last_message_at ?? new Date().toISOString(),
    };
  });
  const shown = new Set(items.map((i) => i.conversationId));
  let extra = 0;
  for (const h of held) {
    if (h.conversation_id && shown.has(h.conversation_id)) continue;
    extra += 1;
    if (items.length < 3)
      items.push({
        key: `p-${h.id}`,
        conversationId: h.conversation_id,
        who: h.contact_name ?? "A customer",
        question: h.question,
        at: h.asked_at,
      });
  }
  return { items, total: (count ?? items.length) + extra };
}

export type DraftItem = ReadyDraft & { contact: Contact };

/**
 * Draft mode's drafts still waiting (last 24 hours, the free-reply window):
 * suggest_reply runs Aiden wrote on his own (no user_id — a teammate's
 * "Draft a reply" has one), latest per chat, with nothing sent since.
 */
export async function loadReadyDrafts(
  organizationId: string,
  now: number,
): Promise<DraftItem[] | null> {
  const { data, error } = await aidwar
    .from("ai_runs")
    .select("id, conversation_id, input_summary, output, created_at")
    .eq("organization_id", organizationId)
    .eq("task", "suggest_reply")
    .eq("status", "ok")
    .is("user_id", null)
    .not("conversation_id", "is", null)
    .gte("created_at", new Date(now - DAY_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return null;
  const runs = (data ?? []) as DraftRun[];
  if (runs.length === 0) return [];
  const ids = Array.from(new Set(runs.map((r) => r.conversation_id!).filter(Boolean)));
  const oldest = runs[runs.length - 1]!.created_at;
  const { data: sent, error: sentError } = await aidwar
    .from("messages")
    .select("conversation_id, created_at")
    .in("conversation_id", ids)
    .eq("direction", "outbound")
    .gte("created_at", oldest)
    .order("created_at", { ascending: false })
    .limit(500);
  if (sentError) return null;
  const lastOut = new Map<string, string>();
  for (const m of (sent ?? []) as Array<{ conversation_id: string; created_at: string }>) {
    if (!lastOut.has(m.conversation_id)) lastOut.set(m.conversation_id, m.created_at);
  }
  const drafts = readyDrafts(runs, lastOut);
  const contacts = await contactsOf(drafts.map((d) => d.conversationId));
  return drafts.map((d) => ({ ...d, contact: contacts.get(d.conversationId) ?? null }));
}

/** How many drafts Aiden wrote on his own today. */
export async function loadDraftsWrittenToday(
  organizationId: string,
  timezone: string,
): Promise<number | null> {
  const { count, error } = await aidwar
    .from("ai_runs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("task", "suggest_reply")
    .eq("status", "ok")
    .is("user_id", null)
    .not("conversation_id", "is", null)
    .gte("created_at", localDayStartIso(timezone));
  return error ? null : (count ?? 0);
}

export type OpenChat = HomeConversation & {
  whatsapp_account_id: string | null;
  /** The customer's newest message in this chat (its 24-hour window's start). */
  lastInboundAt: string | null;
};

/**
 * Open chats with any message in the last 7 days (newest 200, as the Inbox
 * loads), each with its newest message and its newest customer message.
 */
export async function loadOpenChats(
  organizationId: string,
  now: number,
): Promise<OpenChat[] | null> {
  const { data, error } = await aidwar
    .from("conversations")
    .select(
      "id, status, assigned_to, whatsapp_account_id, needs_human, needs_human_question, needs_human_at, last_message_at, contact:contacts(id, name, phone), preview:messages(body, type, direction, created_at), last_in:messages(created_at)",
    )
    .eq("organization_id", organizationId)
    .eq("status", "open")
    .gte("last_message_at", new Date(now - WAITING_LOOKBACK_MS).toISOString())
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { referencedTable: "preview", ascending: false })
    .limit(1, { referencedTable: "preview" })
    .eq("last_in.direction", "inbound")
    .order("created_at", { referencedTable: "last_in", ascending: false })
    .limit(1, { referencedTable: "last_in" })
    .limit(200);
  if (error) return null;
  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => {
    const lastIn = one(
      r["last_in"] as { created_at: string } | Array<{ created_at: string }> | null,
    );
    return {
      ...(r as unknown as HomeConversation),
      whatsapp_account_id: (r["whatsapp_account_id"] as string | null) ?? null,
      contact: one(r["contact"] as Contact | Contact[]),
      preview: one(
        r["preview"] as
          HomeConversation["preview"] | Array<NonNullable<HomeConversation["preview"]>>,
      ),
      lastInboundAt: lastIn?.created_at ?? null,
    };
  });
}

/** Today's flow runs (local day), counted per flow, and the day's total. */
export async function loadFlowsToday(
  organizationId: string,
  timezone: string,
): Promise<{ flows: FlowToday[]; total: number } | null> {
  const since = localDayStartIso(timezone);
  const { data, error, count } = await aidwar
    .from("flow_runs")
    .select("flow_id", { count: "exact" })
    .eq("organization_id", organizationId)
    .gte("started_at", since)
    .limit(1000);
  if (error) return null;
  const runs = (data ?? []) as Array<{ flow_id: string }>;
  const ids = Array.from(new Set(runs.map((r) => r.flow_id)));
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: flows } = await aidwar.from("flows").select("id, name").in("id", ids);
    for (const f of (flows ?? []) as Array<{ id: string; name: string | null }>)
      names.set(f.id, f.name ?? "");
  }
  return { flows: flowsToday(runs, names), total: count ?? runs.length };
}

/** The newest campaign that has sent anything. */
export async function loadLatestCampaign(
  organizationId: string,
): Promise<CampaignRow | null | undefined> {
  const { data, error } = await aidwar
    .from("campaigns")
    .select("*")
    .eq("organization_id", organizationId)
    .neq("status", "draft")
    .gt("sent_count", 0)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return undefined;
  return ((data ?? []) as CampaignRow[])[0] ?? null;
}

export type Teammate = { user_id: string; name: string };

/** The workspace's people, for Assign (the Inbox's own member read). */
export async function loadTeammates(organizationId: string): Promise<Teammate[]> {
  const { data } = await aidwar
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", organizationId);
  const ids = (data ?? []).map((r) => (r as { user_id: string }).user_id);
  if (ids.length === 0) return [];
  const { data: profiles } = await aidwar
    .from("profiles")
    .select("id, full_name, email")
    .in("id", ids);
  return (
    (profiles ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>
  ).map((p) => ({
    user_id: p.id,
    name: p.full_name?.trim() || p.email || "Teammate",
  }));
}
