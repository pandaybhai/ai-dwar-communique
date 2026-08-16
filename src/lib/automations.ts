import { normalizeKeyword } from "@/lib/opt-out";

export type TriggerType = "welcome" | "keyword" | "away";

export type KeywordConfig = { keywords: string[]; match: "exact" | "contains" };
export type AwayConfig = { days: number[]; start: string; end: string };
export type AutomationConfig = Partial<KeywordConfig> & Partial<AwayConfig>;

export type AutomationRow = {
  id: string;
  organization_id: string;
  name: string;
  trigger_type: TriggerType;
  is_active: boolean;
  priority: number;
  config: AutomationConfig;
  message_body: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AutomationRunRow = {
  id: string;
  automation_id: string;
  contact_id: string | null;
  inbound_message_id: string | null;
  status: "sent" | "skipped" | "failed";
  skip_reason: string | null;
  error: string | null;
  created_at: string;
};

export const TRIGGER_LABELS: Record<TriggerType, string> = {
  welcome: "Welcome message",
  keyword: "Keyword auto-reply",
  away: "Away / off-hours",
};

export const TRIGGER_DESCRIPTIONS: Record<TriggerType, string> = {
  welcome: "Sent once, ever, the first time a contact messages you.",
  keyword: "Replies when the incoming message matches one of your keywords.",
  away: "Replies outside your working hours, at most once per contact every 4 hours.",
};

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const MESSAGE_MAX = 1024;

/** Keywords are stored exactly as the opt-out matcher will see them. */
export function normalizeKeywordList(values: string[]): string[] {
  const out: string[] = [];
  for (const v of values) {
    const k = normalizeKeyword(v);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

export function normalizeConfig(
  triggerType: TriggerType,
  raw: unknown,
): AutomationConfig {
  const c = (raw ?? {}) as AutomationConfig;
  if (triggerType === "keyword") {
    return {
      keywords: normalizeKeywordList(Array.isArray(c.keywords) ? c.keywords : []),
      match: c.match === "contains" ? "contains" : "exact",
    };
  }
  if (triggerType === "away") {
    return {
      days: Array.isArray(c.days) ? c.days.filter((d) => d >= 0 && d <= 6) : [],
      start: typeof c.start === "string" ? c.start : "18:00",
      end: typeof c.end === "string" ? c.end : "09:00",
    };
  }
  return {};
}

export function describeConfig(row: {
  trigger_type: TriggerType;
  config: AutomationConfig;
}): string {
  if (row.trigger_type === "keyword") {
    const kws = row.config.keywords ?? [];
    if (!kws.length) return "No keywords set";
    const mode = row.config.match === "contains" ? "contains" : "exact match";
    return `${kws.slice(0, 4).join(", ")}${kws.length > 4 ? ` +${kws.length - 4}` : ""} · ${mode}`;
  }
  if (row.trigger_type === "away") {
    const days = (row.config.days ?? []).map((d) => DAY_LABELS[d]).filter(Boolean);
    if (!days.length) return "No away days set";
    return `${days.join(", ")} · ${row.config.start ?? "--:--"}–${row.config.end ?? "--:--"}`;
  }
  return "First message from a new contact";
}

export const SKIP_LABELS: Record<string, string> = {
  opt_keyword: "Opt-out/opt-in keyword handled this message",
  contact_opted_out: "Contact is opted out",
  no_match: "No automation matched",
  welcome_already_sent: "Welcome already sent to this contact",
  away_rate_limited: "Away reply already sent in the last 4 hours",
  duplicate_delivery: "Duplicate webhook delivery",
  no_credentials: "No connected number available",
  empty_message: "Automation has no message body",
  in_progress: "Send did not complete",
  system_echo: "Message was sent by our own system",
};

export function skipLabel(reason: string | null): string {
  if (!reason) return "—";
  return SKIP_LABELS[reason] ?? reason;
}
