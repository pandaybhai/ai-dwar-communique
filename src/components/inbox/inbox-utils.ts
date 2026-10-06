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
  /** True when the AI stepped back and a person has to pick this up. */
  needs_human?: boolean | null;
  needs_human_reason?: string | null;
  needs_human_question?: string | null;
  needs_human_at?: string | null;
  /** Whether the customer actually received the handover message. */
  handover_state?: string | null;
  contact: {
    id: string;
    name: string | null;
    phone: string;
    opt_in_status?: string | null;
  } | null;
  preview: {
    body: string | null;
    type: string;
    direction: string;
    template_name?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
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
  /** Structured extras, e.g. a filled-in form's answers. */
  metadata?: Record<string, unknown> | null;
  /** Display only: a template message's text, filled in (its body is empty). */
  template_text?: string | null;
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

/**
 * A template's text with the values it was sent with ({{1}} → "Priya").
 * Template sends store them as metadata.template_params; a placeholder with
 * no stored value is left as it is.
 */
export function fillTemplateText(
  text: string,
  metadata: Record<string, unknown> | null | undefined,
  /** The template's own sample values, for a message sent before params were stored. */
  samples?: Record<string, string> | null,
): string {
  const params = metadata?.["template_params"];
  if (!params || typeof params !== "object") {
    // Sent before Batch 5 stored the values: never show a raw {{1}}. The
    // template's sample value stands in, or a neutral "...".
    return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_whole, key: string) => {
      const sample = samples?.[key]?.trim();
      return sample ? sample : "...";
    });
  }
  const values = params as Record<string, unknown>;
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, key: string) => {
    const value = values[key];
    return typeof value === "string" || typeof value === "number" ? String(value) : whole;
  });
}

/**
 * A template's BODY text and its sample values ({{1}} → "Priya"), read from
 * the stored Meta components: positional examples (body_text) or named ones
 * (body_text_named_params).
 */
export function templateBodyOf(
  components: Array<Record<string, unknown>> | null | undefined,
): { text: string; samples: Record<string, string> } | null {
  const body = (components ?? []).find((c) => String(c["type"] ?? "").toUpperCase() === "BODY");
  const text = typeof body?.["text"] === "string" ? (body["text"] as string).trim() : "";
  if (!text) return null;
  const samples: Record<string, string> = {};
  const example = (body?.["example"] ?? {}) as Record<string, unknown>;
  const positional = Array.isArray(example["body_text"]) ? (example["body_text"] as unknown[])[0] : null;
  if (Array.isArray(positional)) {
    positional.forEach((v, i) => {
      if (typeof v === "string" || typeof v === "number") samples[String(i + 1)] = String(v);
    });
  }
  const named = example["body_text_named_params"];
  if (Array.isArray(named)) {
    for (const p of named as Array<Record<string, unknown>>) {
      const name = p["param_name"];
      const value = p["example"];
      if (typeof name === "string" && (typeof value === "string" || typeof value === "number")) samples[name] = String(value);
    }
  }
  return { text, samples };
}

export function previewText(row: ConversationRow): string {
  const p = row.preview;
  if (!p) return "No messages yet";
  if (p.body?.trim()) return p.body.trim();
  if (p.type === "template") {
    const name = p.template_name?.trim();
    return name ? `Template: ${name.replace(/_/g, " ")}` : "Template message";
  }
  return p.type.charAt(0).toUpperCase() + p.type.slice(1);
}

export function withinWindow(lastCustomerMessageAt: string | null): boolean {
  if (!lastCustomerMessageAt) return false;
  return Date.now() - new Date(lastCustomerMessageAt).getTime() <= DAY_MS;
}
