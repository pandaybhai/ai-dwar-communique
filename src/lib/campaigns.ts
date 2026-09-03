export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "sending"
  | "paused"
  | "completed"
  | "cancelled"
  | "failed";

export type RecipientStatus =
  | "queued"
  | "sending"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "skipped";

export type VariableSource = "name" | "phone" | "attribute" | "static";

export type VariableMapping = {
  source: VariableSource;
  key?: string;
  value?: string;
};

/** Keys are the {{n}} numbers as strings. */
export type VariableMappings = Record<string, VariableMapping>;

export type CampaignRow = {
  id: string;
  organization_id: string;
  name: string;
  template_name: string | null;
  template_language: string;
  variable_mappings: VariableMappings | null;
  segment_id: string | null;
  status: CampaignStatus;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  failed_count: number;
  replied_count: number;
  created_by: string | null;
  created_at: string;
  /** Send-time extras: coupon_code, offer_expires_at, media handles. */
  send_settings?: Record<string, unknown> | null;
};


export type CampaignRecipientRow = {
  id: string;
  contact_id: string | null;
  phone: string;
  resolved_variables: Record<string, string> | null;
  status: RecipientStatus;
  error: string | null;
  updated_at: string;
};

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  sending: "Sending",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
};

export const CAMPAIGN_STATUS_CLASSES: Record<CampaignStatus, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  scheduled: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  sending: "border-primary/25 bg-primary/10 text-primary",
  paused: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  completed: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  cancelled: "border-border bg-muted text-muted-foreground",
  failed: "border-destructive/25 bg-destructive/10 text-destructive",
};

export const RECIPIENT_STATUS_CLASSES: Record<RecipientStatus, string> = {
  queued: "border-border bg-muted text-muted-foreground",
  sending: "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-400",
  sent: "border-primary/25 bg-primary/10 text-primary",
  delivered: "border-primary/25 bg-primary/10 text-primary",
  read: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  failed: "border-destructive/25 bg-destructive/10 text-destructive",
  skipped: "border-border bg-muted text-muted-foreground",
};

export const VARIABLE_SOURCE_LABELS: Record<VariableSource, string> = {
  name: "Contact name",
  phone: "Phone number",
  attribute: "Custom attribute",
  static: "Same text for everyone",
};

export type SampleContact = {
  name: string | null;
  phone: string;
  attributes: Record<string, unknown> | null;
};

/** Resolves one variable for a contact. Never returns an empty string. */
export function resolveVariable(
  mapping: VariableMapping | undefined,
  contact: SampleContact,
  fallback = "there",
): string {
  if (!mapping) return fallback;
  switch (mapping.source) {
    case "name":
      return contact.name?.trim() || fallback;
    case "phone":
      return contact.phone || fallback;
    case "attribute": {
      const raw = mapping.key ? contact.attributes?.[mapping.key] : undefined;
      const text = raw === undefined || raw === null ? "" : String(raw).trim();
      return text || fallback;
    }
    case "static":
      return mapping.value?.trim() || fallback;
    default:
      return fallback;
  }
}

export function resolveAllVariables(
  variables: number[],
  mappings: VariableMappings,
  contact: SampleContact,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of variables) out[String(n)] = resolveVariable(mappings[String(n)], contact);
  return out;
}

export function mappingIsComplete(m: VariableMapping | undefined): boolean {
  if (!m) return false;
  if (m.source === "attribute") return Boolean(m.key);
  if (m.source === "static") return Boolean(m.value?.trim());
  return true;
}

export function percent(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

export function formatDateTime(iso: string | null, timezone?: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      ...(timezone ? { timeZone: timezone } : {}),
    });
  } catch {
    return new Date(iso).toLocaleString();
  }
}
