import { DEFAULT_COUNTRY_CODE, enteredPhone } from "@/lib/phone";

/**
 * Batch 70: AiDwar's own Meta ads measurement — the browser pixel and the
 * Conversions API (server) share this file. Pure: no network, no storage.
 *
 * Only AiDwar's own funnel is measured (a visitor, a demo request, a business
 * owner signing up and paying us). Never a merchant's customers, contacts,
 * messages or workspace content.
 */

/** The one place the pixel id lives (dataset id for the Conversions API too). */
export const META_PIXEL_ID = "1601012231234080";

/** Standard events (browser pixel + server, deduplicated by event_id). */
export type MetaStandardEvent =
  | "PageView"
  | "ViewContent"
  | "Lead"
  | "Contact"
  | "CompleteRegistration"
  | "StartTrial"
  | "InitiateCheckout"
  | "Subscribe"
  | "Purchase";

/** Custom events sent from the server only (no pixel inside /app). */
export type MetaCustomEvent =
  | "WhatsAppConnected"
  | "FirstCampaignSent"
  | "FirstFlowActivated"
  | "AidenEnabled"
  | "PlanUpgraded";

export type MetaEventName = MetaStandardEvent | MetaCustomEvent;

export const CUSTOM_EVENTS: readonly MetaCustomEvent[] = [
  "WhatsAppConnected",
  "FirstCampaignSent",
  "FirstFlowActivated",
  "AidenEnabled",
  "PlanUpgraded",
];

/** The only parameters ever sent with an event (custom_data). Nothing else passes. */
export type MetaParams = {
  value?: number;
  currency?: "INR";
  predicted_ltv?: number;
  content_name?: string;
};

export const PARAM_KEYS = ["value", "currency", "predicted_ltv", "content_name"] as const;

/** Keeps only the allowed parameters: finite money, INR, a short page name. */
export function safeParams(input: Record<string, unknown> | null | undefined): MetaParams {
  const out: MetaParams = {};
  const money = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : undefined;
  };
  const value = money(input?.["value"]);
  if (value !== undefined) out.value = value;
  const ltv = money(input?.["predicted_ltv"]);
  if (ltv !== undefined) out.predicted_ltv = ltv;
  if (value !== undefined || ltv !== undefined) out.currency = "INR";
  const name = input?.["content_name"];
  if (typeof name === "string" && /^[A-Za-z0-9 &/-]{1,40}$/.test(name)) out.content_name = name;
  return out;
}

/**
 * The id both the browser and the server send for one occurrence, so Meta
 * counts it once: `Subscribe.<payment id>`, `StartTrial.<workspace id>`. A
 * browser-only occurrence (a page view, a click) uses a random id the browser
 * also hands to the server.
 */
export function metaEventId(event: MetaEventName, key: string): string {
  return `${event}.${String(key)
    .replace(/[^A-Za-z0-9_-]/g, "")
    .slice(0, 80)}`;
}

/** A browser-made id we accept from a request: letters, digits, dots and dashes. */
export function isEventId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._-]{7,120}$/.test(value);
}

/** Predicted lifetime value: the plan's monthly price × months (StartTrial 6, Subscribe 12). */
export function predictedLtv(monthlyPrice: number | null | undefined, months: number): number {
  const n = Number(monthlyPrice ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n * months * 100) / 100 : 0;
}

// --------------------------------------------------------------- where it runs

/** Public marketing pages: the pixel may load, PageView on every visit. */
const PUBLIC_EXACT = new Set([
  "/",
  "/pricing",
  "/demo",
  "/contact",
  "/privacy",
  "/terms",
  "/refund-policy",
  "/refunds",
  "/cancellation-policy",
  "/shipping",
  "/data-deletion",
  "/signup",
]);

/**
 * Where the browser pixel may run:
 *  - "public": marketing pages and /signup — consent banner, PageView, ViewContent, Contact;
 *  - "quiet": /login (loads nothing, no events), and the two signed-in steps
 *    that confirm a conversion — onboarding (/app/start) and billing
 *    (/app/billing) — where only that conversion fires, never a PageView;
 *  - null: everywhere else, including every /app working page and /admin —
 *    nothing loads and nothing is sent.
 */
export function pixelZone(pathname: string): "public" | "quiet" | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/admin" || path.startsWith("/admin/")) return null;
  if (path === "/app/start" || path === "/app/billing") return "quiet";
  if (path === "/app" || path.startsWith("/app/")) return null;
  if (path === "/login") return "quiet";
  if (PUBLIC_EXACT.has(path)) return "public";
  if (path === "/developers" || path.startsWith("/developers/")) return "public";
  return null;
}

/** Pages that are "content" for ViewContent (there is no separate features page today). */
export function viewContentName(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/pricing") return "Pricing";
  if (path === "/developers" || path.startsWith("/developers/")) return "Developers";
  if (path === "/demo") return "Demo";
  return null;
}

/** A link to us that counts as Contact: email, phone or WhatsApp. */
export function isContactHref(href: string | null | undefined): boolean {
  const h = String(href ?? "")
    .trim()
    .toLowerCase();
  return (
    h.startsWith("mailto:") ||
    h.startsWith("tel:") ||
    h.startsWith("https://wa.me/") ||
    h.startsWith("https://api.whatsapp.com/")
  );
}

// ------------------------------------------------------------ customer matching

/**
 * Normalising per Meta's customer-information spec, before hashing. Only for
 * the business owner signing up to AiDwar.
 */
export function normalizeEmail(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
}

/** Digits with the country code, no "+" or leading zeros (Batch 66's rule adds the code). */
export function normalizeMetaPhone(
  value: unknown,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE,
): string | null {
  const e = enteredPhone(typeof value === "string" ? value : "", defaultCountryCode);
  return e.ok ? e.phone.replace(/^\+/, "") : null;
}

/** First name: lowercase, letters only (Unicode), the first word. */
export function normalizeFirstName(value: unknown): string | null {
  const first = (typeof value === "string" ? value : "").trim().split(/\s+/)[0] ?? "";
  const v = first.toLowerCase().replace(/[^\p{L}]/gu, "");
  return v || null;
}

export function normalizeExternalId(value: unknown): string | null {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return v || null;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The owner's facts → Meta user_data, hashed. Missing facts are left out. */
export async function hashedUserData(owner: {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  userId?: string | null;
}): Promise<{ em?: string[]; ph?: string[]; fn?: string[]; external_id?: string[] }> {
  const out: { em?: string[]; ph?: string[]; fn?: string[]; external_id?: string[] } = {};
  const em = normalizeEmail(owner.email);
  if (em) out.em = [await sha256Hex(em)];
  const ph = normalizeMetaPhone(owner.phone);
  if (ph) out.ph = [await sha256Hex(ph)];
  const fn = normalizeFirstName(owner.firstName);
  if (fn) out.fn = [await sha256Hex(fn)];
  const ext = normalizeExternalId(owner.userId);
  if (ext) out.external_id = [await sha256Hex(ext)];
  return out;
}

/** What the server tells the browser to fire (same name, id and parameters). */
export type BrowserMetaEvent = { event: MetaStandardEvent; event_id: string; params: MetaParams };

// ---------------------------------------------------------- Super Admin status

export type MetaCapiStatusRow = {
  token: "connected" | "missing";
  test_code: boolean;
  last_ok_at: string | null;
  last_error: { at: string; code: string | number | null; event: string | null } | null;
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });

/**
 * Batch 70: Super Admin's read-only line for the Meta Conversions API — is
 * META_CAPI_TOKEN set on this server, and how did the last send go. After a
 * move to another host it shows at once whether the secret needs re-adding.
 * Never shows the token.
 */
export function metaCapiStatusText(s: MetaCapiStatusRow): string {
  if (s.token === "missing")
    return "Meta Conversions API: token missing (add the META_CAPI_TOKEN secret).";
  const parts = ["Meta Conversions API: connected"];
  if (s.test_code) parts.push("test code on");
  if (s.last_error)
    parts.push(
      `last error ${s.last_error.code ?? "unknown"}${s.last_error.event ? ` (${s.last_error.event})` : ""} at ${when(s.last_error.at)}`,
    );
  else if (s.last_ok_at) parts.push(`last send ok at ${when(s.last_ok_at)}`);
  else parts.push("nothing sent yet");
  return `${parts.join(" · ")}.`;
}
