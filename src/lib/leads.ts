/**
 * Demo enquiries — shared vocabulary between the public landing form and the
 * Super Admin inbox. Pure data: safe to import from the browser.
 */
import { customersLabel, sellsLabel } from "./start-qualify";

export const CONSENT_VERSION = "2026-09-15";

export const BUSINESS_TYPES = [
  { value: "retail", label: "Retail / D2C store" },
  { value: "services", label: "Services / appointments" },
  { value: "education", label: "Education / coaching" },
  { value: "healthcare", label: "Clinic / healthcare" },
  { value: "realestate", label: "Real estate" },
  { value: "other", label: "Something else" },
] as const;

export const ENQUIRY_BANDS = [
  { value: "0-20", label: "Up to 20 a day" },
  { value: "21-100", label: "21 – 100 a day" },
  { value: "101-500", label: "101 – 500 a day" },
  { value: "500+", label: "More than 500 a day" },
] as const;

export const PRIMARY_NEEDS = [
  { value: "replies", label: "Answering customer questions" },
  { value: "handoff", label: "Approvals and handing over to my team" },
  { value: "campaigns", label: "Campaigns and follow-ups" },
] as const;

export type LeadStatus = "new" | "contacted" | "qualified" | "demo_booked" | "won" | "lost";

export const LEAD_STATUSES: Array<{ value: LeadStatus; label: string }> = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "qualified", label: "Qualified" },
  { value: "demo_booked", label: "Demo booked" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
];

/** A missing answer (a /start lead has none) reads as "—". */
export const NO_ANSWER = "—";

export function labelFor(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string | null | undefined,
): string {
  if (!value) return NO_ANSWER;
  return options.find((o) => o.value === value)?.label ?? value;
}

/** Batch 72: the ad landing page's source; its leads carry only a number (and maybe a name). */
export const START_LEAD_SOURCE = "landing_start";

export function isStartLead(lead: Pick<LeadRow, "source">): boolean {
  return lead.source === START_LEAD_SOURCE;
}

/** The lead's heading: business, else the person's name, else the number. */
export function leadTitle(lead: Pick<LeadRow, "business_name" | "name" | "phone">): string {
  return lead.business_name?.trim() || lead.name?.trim() || lead.phone;
}

/** "Name · +91…", leaving out a name the lead didn't give. */
export function leadContact(lead: Pick<LeadRow, "name" | "phone">): string {
  return [lead.name?.trim(), lead.phone].filter(Boolean).join(" · ");
}

/** The admin search: name, business or number; any of them may be missing. */
export function leadMatches(
  lead: Pick<LeadRow, "name" | "business_name" | "phone">,
  needle: string,
): boolean {
  const n = needle.trim().toLowerCase();
  if (!n) return true;
  return (
    (lead.name ?? "").toLowerCase().includes(n) ||
    (lead.business_name ?? "").toLowerCase().includes(n) ||
    (lead.phone ?? "").includes(n)
  );
}

export type LeadSubmission = {
  business_type: string;
  enquiry_band: string;
  primary_need: string;
  name: string;
  business_name: string;
  phone: string;
  website?: string;
  consent: boolean;
  consent_version: string;
  landing_path?: string;
  attribution?: Record<string, string>;
  /** Honeypot: must stay empty. */
  company_website_confirm?: string;
};

export type LeadRow = {
  id: string;
  created_at: string;
  updated_at: string;
  /** Batch 72: NULL for a /start lead (source "landing_start"); every other source has them. */
  business_type: string | null;
  enquiry_band: string | null;
  primary_need: string | null;
  name: string | null;
  business_name: string | null;
  phone: string;
  website: string | null;
  consent: boolean;
  consent_version: string;
  consent_at: string;
  landing_path: string | null;
  referrer_host: string | null;
  first_attribution: Record<string, string>;
  latest_attribution: Record<string, string>;
  source: string;
  status: LeadStatus;
  assigned_to: string | null;
  demo_at: string | null;
  /** When the team should next chase this enquiry. */
  next_follow_up_at: string | null;
  /** Set only once the demo actually happened — distinct from "Demo booked". */
  demo_attended_at: string | null;
  organization_id: string | null;
  is_test: boolean;
  /** Batch 75: the /start answers ({ sells, customers, answered_at }); {} when skipped or /demo. */
  qualification?: { sells?: string; customers?: string; answered_at?: string } | null;
};

export type LeadNote = {
  id: string;
  lead_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
};

/** "12 Nov, 10:05 am" for the admin list and sheet; "—" when there is no time. */
export function leadTime(value: string | null): string {
  if (!value) return NO_ANSWER;
  return new Date(value).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Batch 75: a /start answer ("sells" / "customers") as its label, or "—"
 * when the lead skipped the questions (or came from /demo).
 */
export function leadAnswer(
  lead: Pick<LeadRow, "qualification">,
  key: "sells" | "customers",
): string {
  const value = lead.qualification?.[key];
  return (key === "sells" ? sellsLabel(value) : customersLabel(value)) ?? NO_ANSWER;
}

/** "all", one answer's value, or "none" (skipped / not asked). */
export type AnswerFilter = string;

function answerMatches(value: string | undefined, filter: AnswerFilter | undefined): boolean {
  if (!filter || filter === "all") return true;
  if (filter === "none") return !value;
  return value === filter;
}

/**
 * The admin list's filter: status tab, "unassigned new" toggle, the
 * null-safe search and (Batch 75) the Sells / Customers answers.
 */
export function filterLeads<T extends LeadRow>(
  leads: T[],
  opts: {
    status: LeadStatus | "all";
    search: string;
    unassignedOnly: boolean;
    sells?: AnswerFilter;
    customers?: AnswerFilter;
  },
): T[] {
  return leads.filter(
    (l) =>
      (opts.status === "all" || l.status === opts.status) &&
      (!opts.unassignedOnly || (l.status === "new" && !l.assigned_to)) &&
      leadMatches(l, opts.search) &&
      answerMatches(l.qualification?.sells, opts.sells) &&
      answerMatches(l.qualification?.customers, opts.customers),
  );
}
