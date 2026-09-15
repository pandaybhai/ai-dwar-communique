/**
 * Landing page measurement. Deliberately tiny and privacy-aware:
 * - no pixels, no third-party scripts, no invented IDs
 * - never carries a name, number, email or website — only the shape of the
 *   interaction (which step, which example, which need band)
 * It writes to window.dataLayer when a tag manager is present and always
 * dispatches a DOM event so anything in-house can listen without a vendor.
 */
export type MarketingEvent =
  | "proof_engaged"
  | "demo_form_started"
  | "demo_step_completed"
  | "demo_lead_submitted"
  | "signup_link_clicked";

const SAFE_KEYS = [
  "example",
  "step",
  "business_type",
  "enquiry_band",
  "primary_need",
  "placement",
  "utm_source",
  "utm_medium",
  "utm_campaign",
] as const;

export function trackMarketing(
  event: MarketingEvent,
  properties: Record<string, string | undefined> = {},
): void {
  if (typeof window === "undefined") return;
  const safe: Record<string, string> = {};
  for (const key of SAFE_KEYS) {
    const value = properties[key];
    if (typeof value === "string" && value) safe[key] = value.slice(0, 80);
  }
  const detail = { event: `aidwar_${event}`, ...safe };
  try {
    const w = window as unknown as { dataLayer?: unknown[] };
    if (Array.isArray(w.dataLayer)) w.dataLayer.push(detail);
    window.dispatchEvent(new CustomEvent("aidwar:marketing", { detail }));
  } catch {
    // measurement must never break the page
  }
}

/**
 * Reads campaign parameters from the URL. Ad click IDs (gclid, fbclid, …)
 * are deliberately not collected: demo-contact permission is not
 * advertising/tracking consent.
 */
export function readAttribution(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  const out: Record<string, string> = {};
  for (const key of [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "ref",
  ]) {
    const value = params.get(key);
    if (value) out[key] = value.slice(0, 200);
  }
  return out;
}
