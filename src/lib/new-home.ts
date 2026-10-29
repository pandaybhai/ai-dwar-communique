/**
 * Batch 45: what the new Home (docs/design/preview.html #home) shows, worked
 * out from rows already read. Pure and browser-safe: every function here takes
 * the rows and the clock, so each rule is tested on its own
 * (src/lib/batch45-home.test.ts). Nothing here reads, writes or sends.
 */

import { aiRunFor, type AiRunRow } from "@/lib/inbox-ai-runs";
import { SERVICE_WINDOW_MS } from "@/lib/service-window";

export type HomeMode = "replying" | "draft" | "off";

/**
 * Which of the three Homes a workspace sees: the mode Aiden really runs in,
 * read the way the webhook reads it (runAgentOnInbound): nothing without the
 * plan's AI (ai_features), nothing while AI is switched off for the workspace,
 * otherwise ai_agents.mode of the default agent. No agent row is Off.
 */
export function homeModeFor(input: {
  /** The plan includes AI (the ai_features flag). */
  aiPlan: boolean;
  /** organization_ai_settings.ai_enabled; null when there is no row. */
  aiEnabled: boolean | null;
  /** ai_agents.mode of the default agent; null when there is none. */
  agentMode: string | null;
}): HomeMode {
  if (!input.aiPlan) return "off";
  if (input.aiEnabled === false) return "off";
  if (input.agentMode === "replying") return "replying";
  if (input.agentMode === "draft") return "draft";
  return "off";
}

/** How long a customer counts as "with Aiden right now" after their last text. */
export const ACTIVE_CHAT_MS = 30 * 60_000;

/** A free 24-hour window closing within this long goes on the gold card. */
export const CLOSING_SOON_MS = 2 * 60 * 60_000;

export type ClosingWindow = {
  conversationId: string;
  /** The customer's last message (the window's start). */
  lastInboundAt: string;
  /** When WhatsApp stops allowing free-form replies. */
  closesAt: string;
  /** Whole minutes left, never below 0. */
  minutesLeft: number;
};

/**
 * Chats whose free 24-hour customer-service window closes within two hours,
 * soonest first. The window runs from each conversation's last inbound
 * customer message and is open while less than or exactly 24 hours have
 * passed (isServiceWindowOpen): one closing in exactly 2 hours is in, one
 * already closed is out.
 */
export function closingWindows(
  rows: Array<{ conversationId: string; lastInboundAt: string | null }>,
  now: number,
  within: number = CLOSING_SOON_MS,
): ClosingWindow[] {
  const out: ClosingWindow[] = [];
  for (const row of rows) {
    if (!row.lastInboundAt) continue;
    const start = new Date(row.lastInboundAt).getTime();
    if (Number.isNaN(start)) continue;
    const left = start + SERVICE_WINDOW_MS - now;
    if (left < 0 || left > within) continue;
    out.push({
      conversationId: row.conversationId,
      lastInboundAt: row.lastInboundAt,
      closesAt: new Date(start + SERVICE_WINDOW_MS).toISOString(),
      minutesLeft: Math.floor(left / 60_000),
    });
  }
  return out.sort((a, b) => a.closesAt.localeCompare(b.closesAt));
}

/** "1 hour 40 minutes left", for the countdown ring's label. */
export function timeLeftLabel(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  const hours = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  const mins = r || !h ? `${r} minute${r === 1 ? "" : "s"}` : "";
  return `${[hours, mins].filter(Boolean).join(" ")} left`;
}

/** "26 min", "3 hours", "2 days": how long someone has waited. */
export function waitedFor(iso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"}`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/** "now", "4 min ago", "2 hours ago": when Aiden replied or drafted. */
export function agoLabel(iso: string, now: number): string {
  const mins = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "now";
  return `${waitedFor(iso, now)} ago`;
}

/** One conversation as the Home lists read it (a slice of the Inbox's own row). */
export type HomeConversation = {
  id: string;
  status: string;
  assigned_to: string | null;
  needs_human: boolean | null;
  needs_human_question?: string | null;
  needs_human_at?: string | null;
  last_message_at: string | null;
  contact: { id: string; name: string | null; phone: string } | null;
  /** The newest message, any direction. */
  preview: { body: string | null; type: string; direction: string; created_at: string } | null;
};

/** How far back an unanswered chat still counts as waiting on Home. */
export const WAITING_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

export type WaitingChat = {
  conversation: HomeConversation;
  /** Since when: the customer's unanswered message, or when it was handed to a person. */
  since: string;
  /** What they said, in words a row can show. */
  said: string;
};

/** A message without words, said the way the Inbox list says it. */
export function messageGist(m: { body: string | null; type: string } | null): string {
  const body = m?.body?.trim();
  if (body) return body;
  switch (m?.type) {
    case "image":
      return "A photo";
    case "video":
      return "A video";
    case "audio":
      return "A voice note";
    case "document":
      return "A document";
    case "location":
      return "A location";
    case "sticker":
      return "A sticker";
    default:
      return "A message";
  }
}

/**
 * With Aiden off, who is waiting on the team, oldest first: open chats whose
 * newest message is the customer's (nobody has answered it yet) or that were
 * handed to a person, from the last 7 days.
 */
export function waitingQueue(conversations: HomeConversation[], now: number): WaitingChat[] {
  const out: WaitingChat[] = [];
  for (const c of conversations) {
    if (c.status !== "open") continue;
    const p = c.preview;
    const customerLast = p?.direction === "inbound";
    if (!customerLast && !c.needs_human) continue;
    const since = customerLast ? p!.created_at : (c.needs_human_at ?? c.last_message_at);
    if (!since || now - new Date(since).getTime() > WAITING_LOOKBACK_MS) continue;
    const said = customerLast ? messageGist(p) : c.needs_human_question?.trim() || messageGist(p);
    out.push({ conversation: c, since, said });
  }
  return out.sort((a, b) => a.since.localeCompare(b.since));
}

export type FeedReply = {
  conversationId: string;
  question: string;
  reply: string;
  at: string;
};

type FeedMessage = {
  conversation_id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  sent_by?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at: string;
};

/**
 * Aiden's latest replies that really reached a customer, one per chat,
 * newest first. A run counts only when an outbound message in its chat is
 * that run's answer (the Inbox's own match, aiRunFor) — so background work
 * Aiden does inside a chat (describing a photo) never shows as a reply.
 */
export function sentAidenReplies(
  runs: Array<AiRunRow & { conversation_id: string | null }>,
  messages: FeedMessage[],
  limit = 3,
): FeedReply[] {
  const byChat = new Map<string, AiRunRow[]>();
  for (const r of runs) {
    if (!r.conversation_id || !(r.output ?? "").trim()) continue;
    const list = byChat.get(r.conversation_id) ?? [];
    list.push(r);
    byChat.set(r.conversation_id, list);
  }
  for (const list of byChat.values()) list.sort((a, b) => b.created_at.localeCompare(a.created_at));

  const latest = new Map<string, FeedReply>();
  for (const m of messages) {
    const list = byChat.get(m.conversation_id);
    if (!list) continue;
    const note = aiRunFor(m, list);
    if (!note) continue;
    const run = list.find((r) => (r.output ?? "").trim() === note.reply);
    if (!run) continue;
    const prev = latest.get(m.conversation_id);
    if (prev && prev.at >= run.created_at) continue;
    latest.set(m.conversation_id, {
      conversationId: m.conversation_id,
      question: note.question,
      reply: note.reply,
      at: run.created_at,
    });
  }
  return Array.from(latest.values())
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

export type DraftRun = {
  id: string;
  conversation_id: string | null;
  input_summary: string | null;
  output: string | null;
  created_at: string;
};

export type ReadyDraft = {
  runId: string;
  conversationId: string;
  question: string;
  draft: string;
  at: string;
};

/**
 * Draft mode's drafts still waiting for the owner, newest first: per chat
 * the latest draft Aiden wrote, kept only while nothing has been sent in that
 * chat since (once a reply goes out, by anyone, the draft is done).
 * `lastOutboundAt` maps a conversation to its newest outbound message.
 */
export function readyDrafts(runs: DraftRun[], lastOutboundAt: Map<string, string>): ReadyDraft[] {
  const latest = new Map<string, DraftRun>();
  for (const r of runs) {
    if (!r.conversation_id || !(r.output ?? "").trim()) continue;
    const prev = latest.get(r.conversation_id);
    if (!prev || r.created_at > prev.created_at) latest.set(r.conversation_id, r);
  }
  const out: ReadyDraft[] = [];
  for (const [conversationId, r] of latest) {
    const sent = lastOutboundAt.get(conversationId);
    if (sent && sent >= r.created_at) continue;
    out.push({
      runId: r.id,
      conversationId,
      question: (r.input_summary ?? "").trim(),
      draft: (r.output ?? "").trim(),
      at: r.created_at,
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

export type FlowToday = { flowId: string; name: string; runs: number };

/** Today's flow runs counted per flow, busiest first (ties by name). */
export function flowsToday(
  runs: Array<{ flow_id: string }>,
  names: Map<string, string>,
): FlowToday[] {
  const counts = new Map<string, number>();
  for (const r of runs) counts.set(r.flow_id, (counts.get(r.flow_id) ?? 0) + 1);
  return Array.from(counts, ([flowId, n]) => ({
    flowId,
    name: names.get(flowId)?.trim() || "A flow",
    runs: n,
  })).sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

/** The headline of each Home, in the preview's words. */
export function replyingHeadline(active: number): string {
  if (active <= 0) return "Aiden is on, no one is waiting";
  return `Aiden is replying to ${active} customer${active === 1 ? "" : "s"}`;
}

export function draftsHeadline(ready: number): string {
  if (ready <= 0) return "All caught up";
  return ready === 1 ? "1 reply is ready for you" : `${ready} replies are ready for you`;
}

export function waitingHeadline(waiting: number): string {
  if (waiting <= 0) return "No customers are waiting";
  return waiting === 1 ? "1 customer is waiting" : `${waiting} customers are waiting`;
}
