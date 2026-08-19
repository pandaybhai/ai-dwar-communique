export const DAY_MS = 24 * 60 * 60 * 1000;

export type ConversationRow = {
  id: string;
  status: "open" | "closed" | "pending";
  assigned_to: string | null;
  /** Which connected number this thread belongs to — a workspace may run several. */
  whatsapp_account_id: string | null;
  last_message_at: string | null;
  last_customer_message_at: string | null;
  unread_count: number | null;
  contact: {
    id: string;
    name: string | null;
    phone: string;
    opt_in_status?: string | null;
  } | null;
  preview: { body: string | null; type: string; direction: string } | null;
};


export type MessageRow = {
  id: string;
  conversation_id: string | null;
  direction: "inbound" | "outbound";
  type: string;
  body: string | null;
  media_url: string | null;
  media_mime: string | null;
  template_name: string | null;
  status: string;
  error_detail: string | null;
  /** Which teammate sent it; empty when the AI or an automation did. */
  sent_by?: string | null;
  /** Best guess at the language the customer wrote in. */
  detected_language?: string | null;
  created_at: string;
};

export type MemberRow = { user_id: string; full_name: string | null; email: string | null };

export function contactLabel(c: ConversationRow["contact"]): string {
  return c?.name?.trim() || c?.phone || "Unknown contact";
}

export function initials(label: string): string {
  const parts = label.replace(/^\+/, "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d`;
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(Date.now() - DAY_MS);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yest)) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export function previewText(row: ConversationRow): string {
  const p = row.preview;
  if (!p) return "No messages yet";
  if (p.body?.trim()) return p.body.trim();
  if (p.type === "template") return "Template message";
  return p.type.charAt(0).toUpperCase() + p.type.slice(1);
}

export function withinWindow(lastCustomerMessageAt: string | null): boolean {
  if (!lastCustomerMessageAt) return false;
  return Date.now() - new Date(lastCustomerMessageAt).getTime() <= DAY_MS;
}
