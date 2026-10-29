import { normalizePhone } from "@/lib/phone";

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "awaiting_approval"
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
  /** Money, present only when billing is switched on for the workspace. */
  estimated_cost?: number | null;
  held_amount?: number | null;
  charged_amount?: number | null;
  returned_amount?: number | null;
  approved_by?: string | null;
  approved_at?: string | null;
  /** Why the sender paused it, e.g. "insufficient_credits" (Batch 26a). */
  pause_reason?: string | null;
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
  awaiting_approval: "Awaiting approval",
  sending: "Sending",
  paused: "Paused",
  completed: "Completed",
  cancelled: "Cancelled",
  failed: "Failed",
};

/** The order statuses are offered in the campaign list filter. */
export const CAMPAIGN_STATUS_ORDER: CampaignStatus[] = [
  "draft",
  "scheduled",
  "awaiting_approval",
  "sending",
  "paused",
  "completed",
  "cancelled",
  "failed",
];

/** Batch 41: the design system's status tokens (light and dark). */
export const CAMPAIGN_STATUS_CLASSES: Record<CampaignStatus, string> = {
  draft: "border-border bg-muted text-muted-foreground",
  scheduled: "border-info-border bg-info-soft text-info-soft-foreground",
  awaiting_approval: "border-warning-border bg-warning-soft text-warning-soft-foreground",
  sending: "border-success-border bg-success-soft text-success-soft-foreground",
  paused: "border-warning-border bg-warning-soft text-warning-soft-foreground",
  completed: "border-success-border bg-success-soft text-success-soft-foreground",
  cancelled: "border-border bg-muted text-muted-foreground",
  failed: "border-danger-border bg-danger-soft text-danger-soft-foreground",
};

export const RECIPIENT_STATUS_CLASSES: Record<RecipientStatus, string> = {
  queued: "border-border bg-muted text-muted-foreground",
  sending: "border-info-border bg-info-soft text-info-soft-foreground",
  sent: "border-border bg-subtle text-foreground",
  delivered: "border-info-border bg-info-soft text-info-soft-foreground",
  read: "border-success-border bg-success-soft text-success-soft-foreground",
  failed: "border-danger-border bg-danger-soft text-danger-soft-foreground",
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

/**
 * The media and offer details a campaign sends with, as launch stores them in
 * campaigns.send_settings: only https files, coupons cut to Meta's 15
 * characters, a valid offer end. Shared by launch and the test send (Batch 35),
 * so a test goes out with exactly what the campaign will.
 */
export function sanitizeSendSettings(raw: unknown): Record<string, unknown> {
  const rawSettings = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const httpsOrNull = (v: unknown): string | null => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.startsWith("https://") ? s : null;
  };
  const sendSettings: Record<string, unknown> = {};
  const headerMedia = httpsOrNull(rawSettings["header_media_url"]);
  if (headerMedia) sendSettings["header_media_url"] = headerMedia;
  const cardsRaw = Array.isArray(rawSettings["cards"]) ? rawSettings["cards"] : [];
  // Each carousel card keeps its own copy-code coupon; dropping it here
  // was why launched carousels went out with empty coupon buttons.
  const cards = cardsRaw.map((c) => {
    const card = (c as Record<string, unknown> | null) ?? {};
    const media_url = httpsOrNull(card["media_url"]);
    const coupon_code =
      typeof card["coupon_code"] === "string" ? (card["coupon_code"] as string).trim().slice(0, 15) : "";
    return { media_url, ...(coupon_code ? { coupon_code } : {}) };
  });
  if (cards.some((c) => c.media_url || c.coupon_code)) sendSettings["cards"] = cards;

  // Offer details: the coupon a copy-code button copies, and when a
  // limited-time offer's countdown runs out.
  const coupon =
    typeof rawSettings["coupon_code"] === "string" ? (rawSettings["coupon_code"] as string).trim().slice(0, 15) : "";
  if (coupon) sendSettings["coupon_code"] = coupon;
  const expiresRaw = typeof rawSettings["offer_expires_at"] === "string" ? (rawSettings["offer_expires_at"] as string) : "";
  if (expiresRaw && !Number.isNaN(new Date(expiresRaw).getTime())) {
    sendSettings["offer_expires_at"] = new Date(expiresRaw).toISOString();
  }
  return sendSettings;
}

/**
 * The send context a campaign's stored send_settings give each message (header
 * file, carousel cards, coupon, offer end). Shared by the campaign dispatcher
 * and the test send, so both build the same template.
 */
export function sendContextFromSettings(raw: unknown): {
  headerMediaUrl?: string;
  cards?: Array<{ mediaUrl: string | null; couponCode: string | null }>;
  couponCode?: string;
  offerExpiresAt?: string;
} {
  const settings = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const headerMediaUrl = (settings["header_media_url"] as string | null) ?? null;
  const settingCards = Array.isArray(settings["cards"])
    ? (settings["cards"] as Array<{ media_url?: string | null; coupon_code?: string | null }>).map((c) => ({
        mediaUrl: c?.media_url ?? null,
        couponCode: c?.coupon_code ?? null,
      }))
    : [];
  const couponCode = (settings["coupon_code"] as string | null) ?? null;
  const offerExpiresAt = (settings["offer_expires_at"] as string | null) ?? null;
  return {
    ...(headerMediaUrl ? { headerMediaUrl } : {}),
    ...(settingCards.length ? { cards: settingCards } : {}),
    ...(couponCode ? { couponCode } : {}),
    ...(offerExpiresAt ? { offerExpiresAt } : {}),
  };
}

/** Batch 35: "Send a test" takes 1 to 5 numbers, and 20 test sends per campaign. */
export const MAX_TEST_NUMBERS = 5;
export const MAX_TESTS_PER_CAMPAIGN = 20;

/**
 * The numbers a merchant typed for a test send (commas, spaces between groups,
 * new lines — any format), normalised with normalizePhone and de-duplicated.
 */
export function parseTestNumbers(input: string): { numbers: string[]; error: string | null } {
  const parts = String(input ?? "")
    .split(/[\n,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const numbers: string[] = [];
  for (const part of parts) {
    const phone = normalizePhone(part);
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) {
      return { numbers: [], error: `“${part.slice(0, 30)}” doesn't look like a phone number. Include the country code, e.g. +91 98765 43210.` };
    }
    if (!numbers.includes(phone)) numbers.push(phone);
  }
  if (numbers.length === 0) return { numbers: [], error: "Type at least one phone number." };
  if (numbers.length > MAX_TEST_NUMBERS) {
    return { numbers: [], error: `A test goes to at most ${MAX_TEST_NUMBERS} numbers.` };
  }
  return { numbers, error: null };
}
