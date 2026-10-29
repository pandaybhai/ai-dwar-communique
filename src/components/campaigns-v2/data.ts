import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import {
  CAMPAIGN_STATUS_LABELS,
  percent,
  type CampaignRecipientRow,
  type CampaignRow,
  type RecipientStatus,
  type VariableMappings,
} from "@/lib/campaigns";
import type { TemplateRow } from "@/lib/templates";
import { componentsToPreview, type PreviewModel } from "@/components/templates/template-preview";
import { money, type CampaignCostEstimate } from "@/lib/billing";

/**
 * Batch 47: the new Campaigns screen's reads (docs/design/preview.html
 * #campaigns). Read only, through the member's RLS-scoped client, with the
 * same selects the Batch 41 list and results page make; the one write the
 * screen offers (pause, resume, cancel, approve) is the results page's own
 * /api/campaigns/control request.
 */

export const count = new Intl.NumberFormat("en-IN");

export const RECIPIENT_PAGE_SIZE = 20;

/** Batch 41's recipient filters, in the same order. */
export const RECIPIENT_FILTERS: Array<RecipientStatus | "all"> = [
  "all",
  "read",
  "delivered",
  "sent",
  "sending",
  "queued",
  "failed",
  "skipped",
];

/** Every campaign of the workspace, newest first (campaigns-view's read). */
export async function loadCampaignList(organizationId: string) {
  const { data, error } = await aidwar
    .from("campaigns")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  return {
    rows: (data ?? []) as CampaignRow[],
    error: error ? "We couldn't load your campaigns. Please try again." : null,
  };
}

export type ResultsQuery = {
  organizationId: string;
  campaignId: string;
  page: number;
  status: RecipientStatus | "all";
  phoneDigits: string;
};

/** One campaign and a page of its recipients (campaign-detail's read). */
export async function loadCampaignResults(q: ResultsQuery) {
  let recipientsQuery = aidwar
    .from("campaign_recipients")
    .select("id, contact_id, phone, resolved_variables, status, error, updated_at", {
      count: "exact",
    })
    .eq("campaign_id", q.campaignId);
  if (q.status !== "all") recipientsQuery = recipientsQuery.eq("status", q.status);
  if (q.phoneDigits) recipientsQuery = recipientsQuery.ilike("phone", `%${q.phoneDigits}%`);
  const from = q.page * RECIPIENT_PAGE_SIZE;
  const [{ data: c, error: cErr }, { data: r, count: total }] = await Promise.all([
    aidwar
      .from("campaigns")
      .select("*")
      .eq("id", q.campaignId)
      .eq("organization_id", q.organizationId)
      .maybeSingle(),
    recipientsQuery
      .order("updated_at", { ascending: false })
      .range(from, from + RECIPIENT_PAGE_SIZE - 1),
  ]);
  return {
    campaign: cErr || !c ? null : (c as CampaignRow),
    error: cErr || !c ? "We couldn't find this campaign." : null,
    recipients: (r ?? []) as CampaignRecipientRow[],
    total: total ?? 0,
  };
}

export type OfferNumbers = { received: number; tapped: number; redeemed: number };

/** The coupon's three counts, only for a campaign that carried a code (campaign-detail's read). */
export async function loadOfferNumbers(campaign: CampaignRow): Promise<OfferNumbers | null> {
  const settings = (campaign.send_settings ?? {}) as Record<string, unknown>;
  if (!String(settings["coupon_code"] ?? "").trim()) return null;
  const [received, tapped, redeemed] = await Promise.all([
    aidwar
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .in("status", ["sent", "delivered", "read", "replied"]),
    aidwar
      .from("campaign_offer_events")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .eq("event", "tapped"),
    aidwar
      .from("campaign_offer_events")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaign.id)
      .eq("event", "redeemed"),
  ]);
  return {
    received: received.count ?? 0,
    tapped: tapped.count ?? 0,
    redeemed: redeemed.count ?? 0,
  };
}

export type CampaignSales = { orders: number; revenue: number; currency: string };

const SALES_ROW_CAP = 1000;

/**
 * Sales linked to a campaign: the orders revenue attribution (last touch,
 * revenue_attributions) put on it, the same rows Receipts and Analytics
 * count. Summed here from one read; a campaign with more rows than PostgREST
 * returns at once, or with orders in more than one currency, shows nothing
 * rather than a short or mixed total. Null means there is nothing true to show.
 */
export async function loadCampaignSales(
  organizationId: string,
  campaignId: string,
): Promise<CampaignSales | null> {
  const {
    data,
    count: total,
    error,
  } = await aidwar
    .from("revenue_attributions")
    .select("order_total, currency", { count: "exact" })
    .eq("organization_id", organizationId)
    .eq("source_type", "campaign")
    .eq("source_id", campaignId)
    .range(0, SALES_ROW_CAP - 1);
  if (error) return null;
  const rows = (data ?? []) as Array<{
    order_total: number | string | null;
    currency: string | null;
  }>;
  if (rows.length === 0 || (total ?? rows.length) > rows.length) return null;
  const currencies = new Set(rows.map((r) => r.currency || "INR"));
  if (currencies.size > 1) return null;
  return {
    orders: rows.length,
    revenue: rows.reduce((s, r) => s + Number(r.order_total ?? 0), 0),
    currency: [...currencies][0] ?? "INR",
  };
}

/** The approved-or-not template a campaign sends, from the workspace's library. */
export async function loadCampaignTemplate(
  organizationId: string,
  campaign: Pick<CampaignRow, "template_name" | "template_language">,
  wabaId: string | null,
): Promise<TemplateRow | null> {
  if (!campaign.template_name) return null;
  const { data } = await aidwar
    .from("message_templates")
    .select(
      "id, organization_id, waba_id, meta_template_id, name, language, category, status, components, rejection_reason, created_at, updated_at",
    )
    .eq("organization_id", organizationId)
    .eq("name", campaign.template_name)
    .eq("language", campaign.template_language);
  const rows = (data ?? []) as TemplateRow[];
  return rows.find((t) => wabaId && t.waba_id === wabaId) ?? rows[0] ?? null;
}

/** Pause, resume, cancel or approve: the results page's own request, nothing else. */
export function controlCampaign(
  organizationId: string,
  campaignId: string,
  action: "pause" | "resume" | "cancel" | "approve",
) {
  return callApi("/api/campaigns/control", {
    body: { organization_id: organizationId, campaign_id: campaignId, action },
  });
}

// ------------------------------------------------------------------ presentation

export const FUNNEL_STEPS = [
  { key: "sent_count", label: "Sent" },
  { key: "delivered_count", label: "Delivered" },
  { key: "read_count", label: "Read" },
  { key: "replied_count", label: "Replied" },
] as const;

export type FunnelStep = { key: string; label: string; value: number; share: number };

/**
 * Sent, delivered, read, replied: the campaign row's own counters, each bar a
 * share of the whole audience (as on the Batch 41 results page).
 */
export function funnelSteps(c: CampaignRow): FunnelStep[] {
  return FUNNEL_STEPS.map((s) => ({
    key: s.key,
    label: s.label,
    value: c[s.key],
    share: percent(c[s.key], c.total_recipients),
  }));
}

/** The list's tiny bars: delivered, read, replied as a share of the audience; none before a send. */
export function miniBars(
  c: CampaignRow,
): { delivered: number; read: number; replied: number } | null {
  if (c.sent_count <= 0) return null;
  return {
    delivered: percent(c.delivered_count, c.total_recipients),
    read: percent(c.read_count, c.total_recipients),
    replied: percent(c.replied_count, c.total_recipients),
  };
}

/** The local calendar day of a moment, as YYYY-MM-DD in the workspace's timezone. */
function dayIn(iso: string | number, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** "today", "yesterday", "3 days ago" (up to a week), else "12 Oct". */
export function relativeDay(iso: string, timezone: string, now: number = Date.now()): string {
  const days = Math.round(
    (Date.parse(`${dayIn(now, timezone)}T00:00:00Z`) -
      Date.parse(`${dayIn(iso, timezone)}T00:00:00Z`)) /
      86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone || "UTC",
    day: "numeric",
    month: "short",
  }).format(new Date(iso));
}

/** "Fri 30 Oct, 9:00 am" in the workspace's timezone. */
export function shortWhen(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone || "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** money() without a trailing ".00": ₹2,709 but ₹1,019.96. */
export function wholeMoney(amount: number, currency = "INR"): string {
  return money(amount, currency).replace(/\.00$/, "");
}

/** The list row's second line, from the campaign's own status and timestamps. */
export function campaignSubtitle(
  c: CampaignRow,
  timezone: string,
  now: number = Date.now(),
): string {
  const total = count.format(c.total_recipients);
  switch (c.status) {
    case "completed": {
      const at = c.completed_at ?? c.started_at ?? c.created_at;
      return `Sent ${relativeDay(at, timezone, now)} to ${total}`;
    }
    case "sending":
      return `Sending now, ${count.format(c.sent_count)} of ${total}`;
    case "scheduled":
      return c.scheduled_at ? `Sends ${shortWhen(c.scheduled_at, timezone)}` : "Scheduled";
    case "awaiting_approval":
      return `To ${total} people`;
    case "paused":
      return `Paused at ${count.format(c.sent_count)} of ${total}`;
    case "cancelled":
      return c.sent_count > 0
        ? `Stopped after ${count.format(c.sent_count)} of ${total}`
        : "Cancelled";
    case "failed":
      return "Could not send";
    default:
      return CAMPAIGN_STATUS_LABELS[c.status] ?? "Draft";
  }
}

/** The preview's list: a campaign that has sent shows its bars, any other a status tag. */
export function campaignTag(c: CampaignRow): string | null {
  return miniBars(c) ? null : CAMPAIGN_STATUS_LABELS[c.status];
}

/** What this campaign cost: the charged total once it is known, else the estimate. */
export function campaignCost(c: CampaignRow): { label: string; amount: number } | null {
  const charged = Number(c.charged_amount ?? 0);
  const estimated = Number(c.estimated_cost ?? 0);
  if (charged > 0) return { label: "Cost", amount: charged };
  if (estimated > 0) return { label: "Estimated cost", amount: estimated };
  return null;
}

/**
 * The words in the phone: each {{n}} shown as what fills it, so the merchant
 * reads the message the way it was set up ({{name}}, {{city}}, or the fixed
 * text everyone gets).
 */
export function mappingLabels(
  mappings: VariableMappings | null | undefined,
): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [n, m] of Object.entries(mappings ?? {})) {
    if (!m) continue;
    const label =
      m.source === "name"
        ? "{{name}}"
        : m.source === "phone"
          ? "{{phone}}"
          : m.source === "attribute"
            ? `{{${m.key || "attribute"}}}`
            : (m.value ?? "").trim() || `{{${n}}}`;
    out[Number(n)] = label;
  }
  return out;
}

export type TimelineEvent = {
  label: string;
  at: string | null;
  detail?: string | undefined;
  live?: boolean;
};

/** What happened to this campaign, oldest first, from its own timestamps (Batch 41's timeline). */
export function campaignTimeline(c: CampaignRow): TimelineEvent[] {
  const events: TimelineEvent[] = [{ label: "Created", at: c.created_at }];
  if (c.approved_at) events.push({ label: "Approved", at: c.approved_at });
  if (c.scheduled_at)
    events.push({ label: c.started_at ? "Scheduled for" : "Sends at", at: c.scheduled_at });
  if (c.status === "awaiting_approval")
    events.push({ label: "Waiting for approval", at: null, live: true });
  if (c.started_at) events.push({ label: "Started sending", at: c.started_at });
  if (c.status === "sending")
    events.push({
      label: "Sending now",
      at: null,
      detail: `${percent(c.sent_count + c.failed_count, c.total_recipients)}% done`,
      live: true,
    });
  if (c.status === "paused")
    events.push({
      label: "Paused",
      at: null,
      detail: c.pause_reason === "insufficient_credits" ? "Not enough credits" : undefined,
      live: true,
    });
  if (c.status === "completed") events.push({ label: "Finished", at: c.completed_at });
  if (c.status === "cancelled") events.push({ label: "Cancelled", at: c.completed_at });
  if (c.status === "failed") events.push({ label: "Failed", at: c.completed_at });
  return events;
}

/** The phone: the campaign's template from its stored components, with this campaign's own file. */
export function campaignPreviewModel(
  campaign: CampaignRow,
  template: TemplateRow | null,
): PreviewModel {
  const model = componentsToPreview(
    template?.components,
    mappingLabels(campaign.variable_mappings),
  );
  const settings = (campaign.send_settings ?? {}) as Record<string, unknown>;
  const headerUrl =
    typeof settings["header_media_url"] === "string" ? settings["header_media_url"] : "";
  const cards = Array.isArray(settings["cards"])
    ? (settings["cards"] as Array<{ media_url?: string | null; coupon_code?: string | null }>)
    : [];
  const coupon = typeof settings["coupon_code"] === "string" ? settings["coupon_code"] : null;
  return {
    ...model,
    header: model.header ? { ...model.header, mediaUrl: headerUrl || model.header.mediaUrl } : null,
    cards: model.cards.map((c, i) => ({
      ...c,
      mediaUrl: cards[i]?.media_url || c.mediaUrl,
      couponCode: cards[i]?.coupon_code ?? coupon,
    })),
    couponCode: coupon,
  };
}

/** The footer's one line: who, and roughly what it costs. */
export function ndCostLine(
  audience: { eligible: number } | null,
  audienceLoading: boolean,
  estimate: CampaignCostEstimate | null,
): string {
  if (audienceLoading && !audience) return "Counting who gets it";
  if (!audience) return "Pick who gets it to see the cost";
  const people = `${count.format(audience.eligible)} people`;
  return estimate ? `${people}, about ${money(estimate.estimate, estimate.currency)}` : people;
}
