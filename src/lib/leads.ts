/**
 * Demo enquiries — shared vocabulary between the public landing form and the
 * Super Admin inbox. Pure data: safe to import from the browser.
 */

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

export function labelFor(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string,
): string {
  return options.find((o) => o.value === value)?.label ?? value;
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
  business_type: string;
  enquiry_band: string;
  primary_need: string;
  name: string;
  business_name: string;
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
  organization_id: string | null;
  is_test: boolean;
};

export type LeadNote = {
  id: string;
  lead_id: string;
  author_id: string | null;
  author_name: string | null;
  body: string;
  created_at: string;
};
