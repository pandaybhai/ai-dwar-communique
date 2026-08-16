import { aidwar } from "@/integrations/aidwar/client";

/**
 * Analytics query layer. Every read goes through a SECURITY DEFINER RPC that
 * checks has_permission(org, 'analytics.view') and buckets dates in the
 * organization's own timezone. Nothing is aggregated in the browser — a
 * nightly rollup can later sit behind the same function signatures.
 */

export type Period = { from: string; to: string; label: string; days: number };

export type OverviewTotals = {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replies: number;
  new_contacts: number;
  opt_outs: number;
};

export type Overview = {
  timezone: string;
  from: string;
  to: string;
  days: number;
  current: OverviewTotals;
  previous: OverviewTotals;
  open_conversations: number;
};

export type SeriesPoint = {
  day: string;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replies: number;
  new_contacts: number;
  opt_outs: number;
  conversations_opened: number;
  conversations_closed: number;
};

export type CampaignPerformance = {
  campaign_id: string;
  name: string;
  status: string;
  started_at: string | null;
  created_at: string;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  skipped: number;
};

export type FailureReason = { reason: string; recipients: number };

export type RecipientRow = {
  recipient_id: string;
  phone: string;
  contact_name: string | null;
  status: string;
  error: string | null;
  replied_at: string | null;
  updated_at: string;
  total_count: number;
};

export type ContactsSummary = {
  total: number;
  opted_in: number;
  opted_out: number;
  unknown: number;
};

export type SourceRow = { source: string; contacts: number };

export type ResponseTimes = {
  inbound_bursts: number;
  answered: number;
  median_seconds: number | null;
  p90_seconds: number | null;
};

export type TeamRow = {
  user_id: string;
  full_name: string | null;
  email: string | null;
  conversations_handled: number;
  replies_sent: number;
  conversations_closed: number;
};

export type AutomationRow = {
  automation_id: string;
  name: string;
  trigger_type: string;
  is_active: boolean;
  runs: number;
  sent: number;
  skipped: number;
  failed: number;
  skip_reasons: Record<string, number>;
};

export type QualityPoint = {
  recorded_at: string;
  quality_rating: string;
  phone_number_id: string | null;
};

type RpcArgs = Record<string, unknown>;

async function rpc<T>(fn: string, args: RpcArgs): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await aidwar.rpc(fn, args);
  if (error) {
    const message = /permission/i.test(error.message)
      ? "You don't have permission to view analytics for this workspace."
      : "We couldn't load this report. Please try again.";
    return { data: null, error: message };
  }
  return { data: data as T, error: null };
}

const range = (organizationId: string, period: Period) => ({
  p_organization_id: organizationId,
  p_from: period.from,
  p_to: period.to,
});

export const fetchOverview = (organizationId: string, period: Period) =>
  rpc<Overview>("analytics_overview", range(organizationId, period));

export const fetchTimeseries = (organizationId: string, period: Period) =>
  rpc<SeriesPoint[]>("analytics_timeseries", range(organizationId, period));

export const fetchCampaignPerformance = (organizationId: string, period: Period) =>
  rpc<CampaignPerformance[]>("analytics_campaign_performance", range(organizationId, period));

export const fetchCampaignFailures = (organizationId: string, campaignId: string) =>
  rpc<FailureReason[]>("analytics_campaign_failures", {
    p_organization_id: organizationId,
    p_campaign_id: campaignId,
  });

export const fetchCampaignRecipients = (
  organizationId: string,
  campaignId: string,
  status: string | null,
  limit: number,
  offset: number,
) =>
  rpc<RecipientRow[]>("analytics_campaign_recipients", {
    p_organization_id: organizationId,
    p_campaign_id: campaignId,
    p_status: status,
    p_limit: limit,
    p_offset: offset,
  });

export const fetchContactsSummary = (organizationId: string) =>
  rpc<ContactsSummary>("analytics_contacts_summary", { p_organization_id: organizationId });

export const fetchSourceBreakdown = (organizationId: string) =>
  rpc<SourceRow[]>("contacts_source_breakdown", { p_organization_id: organizationId });

export const fetchResponseTimes = (organizationId: string, period: Period) =>
  rpc<ResponseTimes>("analytics_response_times", range(organizationId, period));

export const fetchTeamPerformance = (organizationId: string, period: Period) =>
  rpc<TeamRow[]>("analytics_team_performance", range(organizationId, period));

export const fetchAutomationPerformance = (organizationId: string, period: Period) =>
  rpc<AutomationRow[]>("analytics_automation_performance", range(organizationId, period));

export const fetchQualityHistory = (organizationId: string, period: Period) =>
  rpc<QualityPoint[]>("analytics_quality_history", range(organizationId, period));

// ------------------------------------------------------------------ presentation

/** Local (organization timezone) calendar date, formatted as YYYY-MM-DD. */
export function localDate(timezone: string, offsetDays = 0): string {
  const now = new Date(Date.now() + offsetDays * 86_400_000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}

export function periodForDays(timezone: string, days: number, label: string): Period {
  return {
    from: localDate(timezone, -(days - 1)),
    to: localDate(timezone, 0),
    days,
    label,
  };
}

/**
 * Rates on tiny denominators lie — "100% delivered" off one message is noise.
 * Below the threshold we surface the raw counts instead.
 */
export const THIN_DENOMINATOR = 20;

export function rate(
  numerator: number,
  denominator: number,
): { thin: boolean; text: string; value: number | null } {
  if (denominator <= 0) return { thin: true, text: "—", value: null };
  const value = (numerator / denominator) * 100;
  if (denominator < THIN_DENOMINATOR) {
    return { thin: true, text: `${numerator} of ${denominator}`, value };
  }
  return { thin: false, text: `${value.toFixed(value >= 10 ? 0 : 1)}%`, value };
}

export function delta(current: number, previous: number): { text: string; direction: 0 | 1 | -1 } {
  if (previous === 0) {
    if (current === 0) return { text: "No change", direction: 0 };
    return { text: "New this period", direction: 1 };
  }
  const change = ((current - previous) / previous) * 100;
  const rounded = Math.round(change);
  if (rounded === 0) return { text: "No change", direction: 0 };
  return {
    text: `${rounded > 0 ? "+" : ""}${rounded}% vs previous ${previous.toLocaleString()}`,
    direction: rounded > 0 ? 1 : -1,
  };
}

export function duration(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86_400).toFixed(1)}d`;
}

export function shortDay(day: string): string {
  const [, month, date] = day.split("-");
  return `${date}/${month}`;
}

export const QUALITY_COLORS: Record<string, string> = {
  GREEN: "var(--primary)",
  YELLOW: "#f59e0b",
  RED: "var(--destructive)",
  UNKNOWN: "var(--muted-foreground)",
};

export const QUALITY_SCORE: Record<string, number> = {
  RED: 1,
  YELLOW: 2,
  GREEN: 3,
  UNKNOWN: 0,
};
