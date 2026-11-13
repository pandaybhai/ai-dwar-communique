import { CUSTOMERS, SELLS } from "./start-qualify";
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
  | "Purchase"
  /** Batch 77: a lead's demo was booked (Admin → Leads, "Demo booked"). Server only. */
  | "Schedule";

/** Custom events sent from the server only (no pixel inside /app). */
export type MetaCustomEvent =
  | "WhatsAppConnected"
  | "FirstCampaignSent"
  | "FirstFlowActivated"
  | "AidenEnabled"
  | "PlanUpgraded"
  /** Batch 75: a /start lead answered what they sell and how many customers they have. */
  | "LeadQualified"
  /** Batch 77: a lead's stage in Admin → Leads ("Contacted", "Qualified", "Won"). */
  | "LeadContacted"
  | "SalesQualifiedLead"
  | "LeadWon";

export type MetaEventName = MetaStandardEvent | MetaCustomEvent;

export const CUSTOM_EVENTS: readonly MetaCustomEvent[] = [
  "WhatsAppConnected",
  "FirstCampaignSent",
  "FirstFlowActivated",
  "AidenEnabled",
  "PlanUpgraded",
  "LeadQualified",
  "LeadContacted",
  "SalesQualifiedLead",
  "LeadWon",
];

/** The only parameters ever sent with an event (custom_data). Nothing else passes. */
export type MetaParams = {
  value?: number;
  currency?: "INR";
  predicted_ltv?: number;
  content_name?: string;
  /** Batch 72: where a Lead came from ("landing_start", "landing", "signup"). */
  lead_source?: string;
  /** Batch 75 (LeadQualified): the /start answers, from their fixed lists only. */
  sells?: string;
  customers?: string;
  /** Batch 77: the lead's stage (demo_leads.status) that fired the event. */
  stage?: string;
};

export const PARAM_KEYS = [
  "value",
  "currency",
  "predicted_ltv",
  "content_name",
  "lead_source",
  "sells",
  "customers",
  "stage",
] as const;

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
  if (typeof name === "string" && /^[A-Za-z0-9 &/_-]{1,40}$/.test(name)) out.content_name = name;
  const source = input?.["lead_source"];
  if (typeof source === "string" && /^[a-z0-9_]{1,40}$/.test(source)) out.lead_source = source;
  const sells = input?.["sells"];
  if (typeof sells === "string" && SELLS.some((o) => o.value === sells)) out.sells = sells;
  const customers = input?.["customers"];
  if (typeof customers === "string" && CUSTOMERS.some((o) => o.value === customers)) {
    out.customers = customers;
  }
  const stage = input?.["stage"];
  if (typeof stage === "string" && /^[a-z_]{1,20}$/.test(stage)) out.stage = stage;
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
  // Batch 72: the ad landing page.
  "/start",
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

/** Batch 72: last name — the last word of a name with two or more, same rules. */
export function normalizeLastName(value: unknown): string | null {
  const words = (typeof value === "string" ? value : "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  const v = words[words.length - 1]!.toLowerCase().replace(/[^\p{L}]/gu, "");
  return v || null;
}

/** Batch 72: the country, only when the number says it (+91 → "in"). */
export function countryFromPhone(phone: string | null): string | null {
  return phone && phone.startsWith("91") && phone.length === 12 ? "in" : null;
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

/**
 * A person's facts → Meta user_data, hashed (never the plain values). Missing
 * facts are left out. Used for AiDwar's own sign-ups and leads only.
 */
export async function hashedUserData(person: {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  /** Batch 72: the full name; the last word becomes ln. */
  fullName?: string | null;
  userId?: string | null;
}): Promise<{
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  external_id?: string[];
  country?: string[];
}> {
  const out: {
    em?: string[];
    ph?: string[];
    fn?: string[];
    ln?: string[];
    external_id?: string[];
    country?: string[];
  } = {};
  const em = normalizeEmail(person.email);
  if (em) out.em = [await sha256Hex(em)];
  const ph = normalizeMetaPhone(person.phone);
  if (ph) out.ph = [await sha256Hex(ph)];
  const fn = normalizeFirstName(person.firstName ?? person.fullName);
  if (fn) out.fn = [await sha256Hex(fn)];
  const ln = normalizeLastName(person.fullName ?? person.firstName);
  if (ln) out.ln = [await sha256Hex(ln)];
  const ext = normalizeExternalId(person.userId);
  if (ext) out.external_id = [await sha256Hex(ext)];
  const country = countryFromPhone(ph);
  if (country) out.country = [await sha256Hex(country)];
  return out;
}

/**
 * Batch 75: one LeadQualified per person — "LeadQualified." + sha256 of the
 * number in E.164 digits, the same key as their Lead.
 */
export async function qualifiedEventId(phone: string | null): Promise<string | null> {
  const ph = normalizeMetaPhone(phone);
  return ph ? metaEventId("LeadQualified", await sha256Hex(ph)) : null;
}

/**
 * Batch 72: one Lead per person. The id is "Lead." + sha256 of the number in
 * E.164 digits (Batch 66's rule, +91 by default), so /start, /demo and
 * sign-up all send the same id and Meta counts the person once. Without a
 * number (never at sign-up today), the user id.
 */
export async function leadEventId(
  phone: string | null,
  fallbackKey?: string | null,
): Promise<string> {
  const ph = normalizeMetaPhone(phone);
  if (ph) return metaEventId("Lead", await sha256Hex(ph));
  return metaEventId("Lead", String(fallbackKey ?? ""));
}

/**
 * Batch 72: Meta's click id cookie value, built from the fbclid the visitor
 * arrived with ("fb.1.<ms>.<fbclid>"). Used only for the server send; the
 * fbclid itself is never stored.
 */
export function fbcFromFbclid(fbclid: unknown, atMs: unknown): string | null {
  if (typeof fbclid !== "string" || !/^[A-Za-z0-9_-]{10,500}$/.test(fbclid)) return null;
  const ms = Number(atMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return `fb.1.${Math.floor(ms)}.${fbclid}`;
}

/**
 * Batch 77: the event a lead's stage sends to Meta the first time the lead
 * reaches it (Admin → Leads). "new" and "lost" send nothing.
 */
export const LEAD_STAGE_EVENTS: Readonly<Record<string, MetaEventName>> = {
  contacted: "LeadContacted",
  qualified: "SalesQualifiedLead",
  demo_booked: "Schedule",
  won: "LeadWon",
};

/** "<EventName>." + the lead id: once per lead per stage (Meta dedups by it too). */
export function leadStageEventId(event: MetaEventName, leadId: string): string {
  return metaEventId(event, leadId);
}

/** What the server tells the browser to fire (same name, id and parameters). */
/** What the server tells the browser pixel to fire (Batch 75: a custom event goes as trackCustom). */
export type BrowserMetaEvent = { event: MetaEventName; event_id: string; params: MetaParams };

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
