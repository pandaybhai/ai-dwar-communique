import type { SupabaseClient } from "@supabase/supabase-js";
import { checkRealNumber } from "@/lib/start-qualify";

/**
 * Batch 80: the /999 page's one-screen checkout, on the server. Two steps,
 * both reached from the same sheet without a page change:
 *
 *  1. "lead" (anonymous, on Pay): the buyer's number, name and business are
 *     saved once as a demo_leads row with source 'landing_999' — the Batch 76
 *     mirror and the new-lead alert ("Website /999") pick it up — and a
 *     signed httpOnly cookie remembers it for step 2. A filled honeypot gets
 *     an ordinary answer and nothing is saved.
 *  2. "pay" (signed in: the account was just made with the existing
 *     email + password sign-up, or the buyer signed in): the lead is linked
 *     to the account and its workspace, the Basic plan's payment starts
 *     through startPlanPurchase (the plan purchase every gateway settles
 *     through), checkout_at marks "reached Pay", and AddPaymentInfo goes to
 *     Meta. The Cashfree session goes back to the sheet, which opens
 *     Cashfree's own popup on our page.
 *
 * The plan goes live only from a paid order (settlePayment → activation), so
 * a failed or cancelled payment leaves the account and workspace as they are,
 * with no plan.
 */

export const LANDING_999_SOURCE = "landing_999";
export const BASIC_PLAN_KEY = "basic";
export const CHECKOUT_CONSENT_VERSION = "2026-11-13";
export const LEAD_999_COOKIE = "aidwar_999_lead";
const COOKIE_TTL_S = 60 * 60; // the token itself lives an hour (START_LEAD_TTL_S)

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`aidwar-lead:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type CheckoutLeadInput = {
  name: string;
  businessName: string;
  phone: string;
};

/** The checkout's own checks, in the order the fields appear. Pure. */
export function checkCheckoutFields(
  body: Record<string, unknown>,
):
  | { ok: true; lead: CheckoutLeadInput }
  | { ok: false; field: "phone" | "name" | "business_name"; error: string } {
  const typed = checkRealNumber(str(body["phone"], 30));
  if (!typed.ok) return { ok: false, field: "phone", error: typed.error };
  const name = str(body["name"], 100);
  if (name.length < 2) return { ok: false, field: "name", error: "Please enter your name." };
  const businessName = str(body["business_name"], 150);
  if (businessName.length < 2) {
    return { ok: false, field: "business_name", error: "Please enter your business name." };
  }
  return { ok: true, lead: { name, businessName, phone: typed.phone } };
}

export type SaveLeadResult =
  | { ok: true; id: string; duplicate: boolean; honeypot?: boolean }
  | { ok: false; status: number; error: string; field?: string };

/**
 * Step 1: the lead, saved once. The same browser (its cookie) or the same
 * number within a day updates its row instead of adding another.
 */
export async function saveCheckoutLead(
  supabase: SupabaseClient,
  body: Record<string, unknown>,
  meta: { ip: string | null; referrer: string | null; cookieLeadId: string | null },
): Promise<SaveLeadResult> {
  if (str(body["company_website_confirm"], 200)) {
    return { ok: true, id: "", duplicate: false, honeypot: true };
  }
  const checked = checkCheckoutFields(body);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error, field: checked.field };
  const { name, businessName, phone } = checked.lead;

  // The same lead again (a retry, a reopened sheet): its own row.
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  let existing: { id: string } | null = null;
  if (meta.cookieLeadId) {
    const { data } = await supabase
      .from("demo_leads")
      .select("id, source")
      .eq("id", meta.cookieLeadId)
      .maybeSingle();
    if ((data as { source?: string } | null)?.source === LANDING_999_SOURCE) {
      existing = { id: (data as { id: string }).id };
    }
  }
  if (!existing) {
    const { data } = await supabase
      .from("demo_leads")
      .select("id")
      .eq("phone", phone)
      .eq("source", LANDING_999_SOURCE)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    existing = (data as { id: string } | null) ?? null;
  }
  if (existing) {
    await supabase
      .from("demo_leads")
      .update({ name, business_name: businessName, phone })
      .eq("id", existing.id);
    return { ok: true, id: existing.id, duplicate: true };
  }

  const ipHash = meta.ip ? await hashIp(meta.ip) : null;
  if (ipHash) {
    const { count } = await supabase
      .from("demo_leads")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", new Date(Date.now() - 3600_000).toISOString());
    if ((count ?? 0) >= 8) {
      return {
        ok: false,
        status: 429,
        error: "We've had a few tries from here. Please wait a few minutes and try again.",
      };
    }
  }

  let referrerHost: string | null = null;
  try {
    referrerHost = meta.referrer ? new URL(meta.referrer).host.slice(0, 200) : null;
  } catch {
    referrerHost = null;
  }
  const { data, error } = await supabase
    .from("demo_leads")
    .insert({
      business_type: null,
      enquiry_band: null,
      primary_need: null,
      name,
      business_name: businessName,
      phone,
      website: null,
      consent: true,
      consent_version: CHECKOUT_CONSENT_VERSION,
      consent_at: new Date().toISOString(),
      landing_path: "/999",
      referrer_host: referrerHost,
      first_attribution: {},
      latest_attribution: {},
      source: LANDING_999_SOURCE,
      ip_hash: ipHash,
    })
    .select("id")
    .single();
  if (error || !data) {
    return { ok: false, status: 500, error: "We couldn't save that just now. Please try again." };
  }
  const id = (data as { id: string }).id;
  // Batch 76: the lead's contact in AiDwar's own workspace. Sends nothing.
  try {
    const { mirrorLead } = await import("@/lib/lead-mirror.server");
    await mirrorLead(supabase, id);
  } catch {
    // the mirror is a courtesy; the lead is saved
  }
  return { ok: true, id, duplicate: false };
}

export async function leadCookie(leadId: string): Promise<string> {
  const { startLeadToken } = await import("@/lib/start-lead-cookie.server");
  return `${LEAD_999_COOKIE}=${await startLeadToken(leadId)}; Path=/api/public/checkout-999; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_TTL_S}`;
}

export async function leadFromCookie(request: Request): Promise<string | null> {
  let token: string | null = null;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === LEAD_999_COOKIE) token = v.join("=");
  }
  if (!token) return null;
  const { readStartLeadToken } = await import("@/lib/start-lead-cookie.server");
  // The token's own expiry is START_LEAD_TTL_S (1 hour) from issue.
  return readStartLeadToken(token);
}

/** The signed-in person's own workspace (as owner), oldest first, or null. */
export async function ownedWorkspace(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("organization_members")
    .select("organization_id, created_at")
    .eq("user_id", userId)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1);
  return ((data as Array<{ organization_id: string }> | null) ?? [])[0]?.organization_id ?? null;
}

export type StartPayResult =
  | {
      ok: true;
      payment_id: string;
      checkout: { payment_session_id: string; mode: "sandbox" | "production" } | null;
      url: string;
      meta: import("@/lib/meta-events").BrowserMetaEvent | null;
    }
  | { ok: false; status: number; error: string; code?: "needs_workspace" | "already_on_plan" };

/**
 * Step 2: the Basic plan's payment for the signed-in buyer's workspace. A
 * buyer with no workspace yet gets code "needs_workspace": the sheet makes it
 * with the onboarding's own create path (create_organization) and asks again.
 */
export async function startCheckoutPayment(
  supabase: SupabaseClient,
  input: {
    userId: string;
    leadId: string | null;
    phone: string;
    organizationId?: string | null;
    request?: Request;
  },
): Promise<StartPayResult> {
  let organizationId = input.organizationId ?? null;
  if (organizationId) {
    const { data } = await supabase
      .from("organization_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", input.userId)
      .maybeSingle();
    if ((data as { role?: string } | null)?.role !== "owner") organizationId = null;
  }
  organizationId ??= await ownedWorkspace(supabase, input.userId);
  if (!organizationId) {
    return { ok: false, status: 409, code: "needs_workspace", error: "No workspace yet." };
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("plan_status, plan_version_id, plan_versions:plan_version_id(plans(key))")
    .eq("id", organizationId)
    .maybeSingle();
  const o = (org ?? {}) as Record<string, unknown>;
  const planKey = (
    ((o["plan_versions"] as Record<string, unknown> | null)?.["plans"] ?? null) as Record<
      string,
      unknown
    > | null
  )?.["key"];
  if (o["plan_status"] === "active" && planKey === BASIC_PLAN_KEY) {
    return {
      ok: false,
      status: 409,
      code: "already_on_plan",
      error: "You're already on AiDwar Basic.",
    };
  }

  if (input.leadId) {
    await supabase
      .from("demo_leads")
      .update({ linked_user_id: input.userId, organization_id: organizationId })
      .eq("id", input.leadId)
      .eq("source", LANDING_999_SOURCE)
      .is("linked_user_id", null);
  }

  const { startPlanPurchase } = await import("@/lib/plan-purchase.server");
  const started = await startPlanPurchase(supabase, {
    organizationId,
    userId: input.userId,
    planKey: BASIC_PLAN_KEY,
    billingWhatsapp: input.phone,
    landing: { source: LANDING_999_SOURCE, returnPath: "/999" },
  });
  if ("error" in started) return { ok: false, status: 400, error: started.error };

  // "Reached Pay": Admin → Leads shows it as Checkout abandoned until paid.
  if (input.leadId) {
    await supabase
      .from("demo_leads")
      .update({ checkout_at: new Date().toISOString(), payment_id: started.payment_id })
      .eq("id", input.leadId)
      .eq("source", LANDING_999_SOURCE)
      .then(
        () => null,
        () => null,
      );
  }

  // AddPaymentInfo (server always — the buyer accepted the terms on Pay; the
  // browser fires the same id only after the cookie banner's Accept).
  let meta: import("@/lib/meta-events").BrowserMetaEvent | null = null;
  try {
    const { metaEventId, safeParams } = await import("@/lib/meta-events");
    const eventId = metaEventId("AddPaymentInfo", started.payment_id);
    const params = safeParams({ value: 999, currency: "INR", content_name: "basic" });
    const { queueMetaEvent } = await import("@/lib/meta-capi.server");
    await queueMetaEvent(supabase, {
      event: "AddPaymentInfo",
      eventId,
      params,
      userId: input.userId,
      sourceUrl: input.request?.headers.get("referer") ?? null,
      ...(input.request ? { request: input.request } : {}),
      once: true,
    });
    meta = { event: "AddPaymentInfo", event_id: eventId, params };
  } catch {
    meta = null; // measurement never touches the payment
  }

  return {
    ok: true,
    payment_id: started.payment_id,
    checkout: started.checkout ?? null,
    url: started.url,
    meta,
  };
}

/** "Checkout abandoned": reached Pay, not paid, 30 minutes on. Pure. */
export const ABANDONED_AFTER_MS = 30 * 60_000;
export function checkoutAbandoned(
  lead: { source: string; checkout_at?: string | null; paid_at?: string | null },
  now: number = Date.now(),
): boolean {
  if (lead.source !== LANDING_999_SOURCE || !lead.checkout_at || lead.paid_at) return false;
  return Date.parse(lead.checkout_at) <= now - ABANDONED_AFTER_MS;
}
