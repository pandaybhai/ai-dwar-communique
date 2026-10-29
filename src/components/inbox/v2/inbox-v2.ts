import { SERVICE_WINDOW_MS, isServiceWindowOpen } from "@/lib/service-window";
import type { ConversationRow } from "../inbox-utils";

/**
 * Batch 46: the new Inbox's rules, browser-safe and pure so they are tested
 * on their own. Nothing here reads or writes; the view and useInbox do.
 */

/**
 * What the list shows. The three tabs of the design map onto the Inbox's
 * existing filters; "all", "open" and "mine" are the classic filters, kept
 * under the "Show" menu so nothing the Batch 39 Inbox could do is lost.
 */
export type InboxView = "waiting" | "aiden" | "done" | "all" | "open" | "mine";
export type InboxTab = "waiting" | "aiden" | "done";
export type QuickFilter = "unread" | "unassigned";

export const TABS: InboxTab[] = ["waiting", "aiden", "done"];

/** The other classic filters, in the "Show" menu. */
export const MORE_VIEWS: Array<{ key: Exclude<InboxView, InboxTab>; label: string }> = [
  { key: "all", label: "All chats" },
  { key: "open", label: "Open" },
  { key: "mine", label: "Assigned to me" },
];

/** Aiden's workspace mode (ai_agents.mode); null while unknown or unreadable. */
export type AidenMode = "off" | "draft" | "replying" | null;

export function tabLabel(tab: InboxTab, mode: AidenMode): string {
  if (tab === "waiting") return "Waiting for you";
  if (tab === "done") return "Done";
  // Only say Aiden is on it when Aiden actually replies in this workspace.
  return mode === "off" || mode === "draft" ? "Nobody on it" : "Aiden on it";
}

/**
 * Open, nobody waiting on a person, nobody holding it: the chats Aiden
 * answers (ai-agent.server.ts skips an assigned or needs_human chat).
 */
export function isAidenChat(c: Pick<ConversationRow, "status" | "needs_human" | "assigned_to">): boolean {
  return c.status === "open" && c.needs_human !== true && !c.assigned_to;
}

/** Does a chat belong in a view? "waiting", "done", "all", "open", "mine" are the classic filters exactly. */
export function inView(
  c: Pick<ConversationRow, "status" | "needs_human" | "assigned_to">,
  view: InboxView,
  userId: string | null,
): boolean {
  switch (view) {
    case "waiting":
      return Boolean(c.needs_human);
    case "aiden":
      return isAidenChat(c);
    case "done":
      return c.status === "closed";
    case "open":
      return c.status === "open";
    case "mine":
      return c.assigned_to === userId;
    default:
      return true;
  }
}

/** The list for a view, search and quick filters (classic rules; nothing new is read). */
export function filterChats<C extends ConversationRow>(
  rows: C[],
  opts: {
    view: InboxView;
    userId: string | null;
    numberId: string;
    quick: ReadonlySet<QuickFilter>;
    search: string;
  },
): C[] {
  const q = opts.search.trim().toLowerCase();
  return rows.filter((c) => {
    if (!inView(c, opts.view, opts.userId)) return false;
    if (opts.numberId !== "all" && c.whatsapp_account_id !== opts.numberId) return false;
    if (opts.quick.has("unread") && !((c.unread_count ?? 0) > 0)) return false;
    if (opts.quick.has("unassigned") && c.assigned_to) return false;
    if (!q) return true;
    const name = (c.contact?.name ?? "").toLowerCase();
    const phone = (c.contact?.phone ?? "").toLowerCase();
    return name.includes(q) || phone.includes(q);
  });
}

/** The view the Inbox opens on: the waiting chats when there are any, else every chat. */
export function initialView(rows: Array<Pick<ConversationRow, "needs_human">>): InboxView {
  return rows.some((c) => c.needs_human) ? "waiting" : "all";
}

/**
 * The 24-hour window chip in the chat header, from the customer's last
 * message. Open and closed follow isServiceWindowOpen (every send path's
 * rule), so exactly 24 hours is still open, with under a minute left.
 */
export function windowChip(
  lastCustomerMessageAt: string | null | undefined,
  now: number = Date.now(),
): { open: boolean; closing: boolean; text: string; minutesLeft: number } {
  if (!isServiceWindowOpen({ last_customer_message_at: lastCustomerMessageAt ?? null }, now)) {
    return { open: false, closing: false, text: "Window closed: send a template", minutesLeft: 0 };
  }
  const left = new Date(lastCustomerMessageAt!).getTime() + SERVICE_WINDOW_MS - now;
  const minutes = Math.floor(left / 60_000);
  const hours = Math.floor(minutes / 60);
  const text =
    hours >= 1
      ? `Free replies for ${hours} more ${hours === 1 ? "hour" : "hours"}`
      : minutes >= 1
        ? `Free replies for ${minutes} more ${minutes === 1 ? "minute" : "minutes"}`
        : "Free replies for less than a minute";
  return { open: true, closing: minutes < 120, text, minutesLeft: Math.max(0, minutes) };
}

/**
 * Take over / hand back, on the Inbox's existing per-chat switch: Aiden never
 * answers a chat a person holds (assigned_to) or one waiting on a person
 * (needs_human). Taking over assigns it to you; handing back clears both,
 * through the same two writes the classic Inbox makes (assign, Mark as handled).
 */
export type TakeoverPlan =
  | { action: "take_over"; label: "Take over from Aiden"; writes: Array<{ assigned_to: string }> }
  | {
      action: "hand_back";
      label: "Hand back to Aiden";
      writes: Array<{ assigned_to: null } | { needs_human: false; needs_human_reason: null; handover_state: null }>;
    };

export function takeoverPlan(
  c: Pick<ConversationRow, "assigned_to" | "needs_human">,
  userId: string | null,
): TakeoverPlan | null {
  if (c.assigned_to || c.needs_human) {
    const writes: Array<{ assigned_to: null } | { needs_human: false; needs_human_reason: null; handover_state: null }> = [];
    if (c.assigned_to) writes.push({ assigned_to: null });
    if (c.needs_human) writes.push({ needs_human: false, needs_human_reason: null, handover_state: null });
    return { action: "hand_back", label: "Hand back to Aiden", writes };
  }
  if (!userId) return null;
  return { action: "take_over", label: "Take over from Aiden", writes: [{ assigned_to: userId }] };
}

/** One of the five avatar tones (av1…av5), stable per contact. */
export function avatarTone(seed: string): 1 | 2 | 3 | 4 | 5 {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return ((h % 5) + 1) as 1 | 2 | 3 | 4 | 5;
}

/** Tailwind classes per tone (kept literal so Tailwind sees them). */
export const TONE_CLASS: Record<1 | 2 | 3 | 4 | 5, string> = {
  1: "bg-av1 text-av1-ink",
  2: "bg-av2 text-av2-ink",
  3: "bg-av3 text-av3-ink",
  4: "bg-av4 text-av4-ink",
  5: "bg-av5 text-av5-ink",
};

/** The phone layout's one pane: the list until a chat is open, then the chat (back goes to the list). */
export function phonePane(activeId: string | null): "list" | "chat" {
  return activeId ? "chat" : "list";
}

/** A product picture Aiden sent, split into its name and the rest of its caption. */
export function productCaption(body: string | null | undefined): { title: string; detail: string | null } {
  const text = (body ?? "").trim();
  const lines = text.split("\n");
  const first = lines[0] ?? "";
  const dash = first.indexOf(" — ");
  if (dash > 0) {
    const rest = [first.slice(dash + 3), ...lines.slice(1)].join("\n").trim();
    return { title: first.slice(0, dash).trim(), detail: rest || null };
  }
  const rest = lines.slice(1).join("\n").trim();
  return { title: first.trim(), detail: rest || null };
}
