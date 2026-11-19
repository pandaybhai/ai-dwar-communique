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

/**
 * Batch 82: the page a checkout belongs to. /999 (the default everywhere, so
 * its checkout is exactly as before) and /199 — the ₹199 paid trial: the same
 * sheet and server steps with its own lead source, cookie and return path.
 * The price is never a field here: startPlanPurchase decides it on the
 * server from the source.
 */
export type CheckoutPage = {
  source: "landing_999" | "landing_199";
  path: "/999" | "/199";
  cookie: string;
  /** What AddPaymentInfo / InitiateCheckout say the order is worth. */
  value: number;
};
export const PAGE_999: CheckoutPage = {
  source: LANDING_999_SOURCE,
  path: "/999",
  cookie: LEAD_999_COOKIE,
  value: 999,
};
export const LANDING_199_SOURCE = "landing_199";
export const PAGE_199: CheckoutPage = {
  source: LANDING_199_SOURCE,
  path: "/199",
  cookie: "aidwar_199_lead",
  value: 199,
};
/** Batch 82: the one /199 answer when the offer was used before (no order is made). */
export const OFFER_USED_MESSAGE = "You've already used the ₹199 offer — our team will call you";
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
  // Batch 81: the business name is asked after payment (setup); when given now
  // it must still read as a name.
  const businessName = str(body["business_name"], 150);
  if (businessName && businessName.length < 2) {
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
  page: CheckoutPage = PAGE_999,
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
    if ((data as { source?: string } | null)?.source === page.source) {
      existing = { id: (data as { id: string }).id };
    }
  }
  if (!existing) {
    const { data } = await supabase
      .from("demo_leads")
      .select("id")
      .eq("phone", phone)
      .eq("source", page.source)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    existing = (data as { id: string } | null) ?? null;
  }
  if (existing) {
    await supabase
      .from("demo_leads")
      .update({ name, ...(businessName ? { business_name: businessName } : {}), phone })
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
      business_name: businessName || null,
      phone,
      website: null,
      consent: true,
      consent_version: CHECKOUT_CONSENT_VERSION,
      consent_at: new Date().toISOString(),
      landing_path: page.path,
      referrer_host: referrerHost,
      first_attribution: {},
      latest_attribution: {},
      source: page.source,
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

export async function leadCookie(leadId: string, page: CheckoutPage = PAGE_999): Promise<string> {
  const { startLeadToken } = await import("@/lib/start-lead-cookie.server");
  const route = `/api/public/checkout-${page.path.slice(1)}`;
  return `${page.cookie}=${await startLeadToken(leadId)}; Path=${route}; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_TTL_S}`;
}

export async function leadFromCookie(
  request: Request,
  page: CheckoutPage = PAGE_999,
): Promise<string | null> {
  let token: string | null = null;
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === page.cookie) token = v.join("=");
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
      /** Batch 81: the workspace paid for (the success screen names it). */
      organization_id: string;
      checkout: { payment_session_id: string; mode: "sandbox" | "production" } | null;
      url: string;
      meta: import("@/lib/meta-events").BrowserMetaEvent | null;
    }
  | {
      ok: false;
      status: number;
      error: string;
      code?: "needs_workspace" | "already_on_plan" | "offer_used";
    };

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
    /**
     * Batch 80b: /999?admin_test_price=1 — a Super Admin's ₹1 live test.
     * Checked here, on the server, against is_super_admin: anyone else is
     * refused (never silently charged ₹999 instead).
     */
    adminTestPrice?: unknown;
    /** Batch 82: /199 (the ₹199 paid trial); /999 when left out. */
    page?: CheckoutPage;
  },
): Promise<StartPayResult> {
  const page = input.page ?? PAGE_999;
  let adminTest = false;
  if (input.adminTestPrice !== undefined && input.adminTestPrice !== null) {
    const { isSuperAdmin } = await import("@/lib/whatsapp-api.server");
    if (input.adminTestPrice !== 1 || !(await isSuperAdmin(supabase, input.userId))) {
      return { ok: false, status: 403, error: "The ₹1 test price is for AiDwar admins only." };
    }
    adminTest = true;
  }
  const { testCodeFromRequest } = await import("@/lib/meta-capi.server");
  const metaTestCode = testCodeFromRequest(input.request ?? null);
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
  // Batch 82: one ₹199 per workspace and per WhatsApp number — checked here,
  // before any order exists; a used offer makes no order (no ₹999 instead).
  let introCheck: IntroCheck | null = null;
  // A Super Admin's ₹1 live test (verified above) is a test, not the offer.
  if (page.source === LANDING_199_SOURCE && !adminTest) {
    introCheck = await introCheck199(supabase, { organizationId, phone: input.phone });
    if (introCheck !== "eligible") {
      console.log(
        JSON.stringify({
          scope: "checkout_199",
          stage: "offer_used",
          intro_check: introCheck,
          organization_id: organizationId,
        }),
      );
      return { ok: false, status: 409, code: "offer_used", error: OFFER_USED_MESSAGE };
    }
  }
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
      .eq("source", page.source)
      .is("linked_user_id", null);
  }

  const { startPlanPurchase } = await import("@/lib/plan-purchase.server");
  const started = await startPlanPurchase(supabase, {
    organizationId,
    userId: input.userId,
    planKey: BASIC_PLAN_KEY,
    billingWhatsapp: input.phone,
    landing: {
      source: page.source,
      returnPath: page.path,
      ...(adminTest ? { adminTestPrice: 1 as const } : {}),
      metaTestCode,
      ...(introCheck ? { introCheck } : {}),
    },
  });
  if ("error" in started) return { ok: false, status: 400, error: started.error };

  // "Reached Pay": Admin → Leads shows it as Checkout abandoned until paid.
  if (input.leadId) {
    await supabase
      .from("demo_leads")
      .update({ checkout_at: new Date().toISOString(), payment_id: started.payment_id })
      .eq("id", input.leadId)
      .eq("source", page.source)
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
    const params = safeParams({
      value: adminTest ? 1 : page.value,
      currency: "INR",
      content_name: "basic",
    });
    const { queueMetaEvent } = await import("@/lib/meta-capi.server");
    await queueMetaEvent(supabase, {
      event: "AddPaymentInfo",
      eventId,
      params,
      userId: input.userId,
      sourceUrl: input.request?.headers.get("referer") ?? null,
      ...(input.request ? { request: input.request } : {}),
      // Batch 80b: ?meta_test=<code> → Meta Test Events (this browser only).
      testCode: metaTestCode,
      once: true,
    });
    meta = { event: "AddPaymentInfo", event_id: eventId, params };
  } catch {
    meta = null; // measurement never touches the payment
  }

  return {
    ok: true,
    payment_id: started.payment_id,
    organization_id: organizationId,
    checkout: started.checkout ?? null,
    url: started.url,
    meta,
  };
}

/** "Checkout abandoned": reached Pay, not paid, 30 minutes on. Pure. */
export const ABANDONED_AFTER_MS = 10 * 60_000;
export function checkoutAbandoned(
  lead: { source: string; checkout_at?: string | null; paid_at?: string | null },
  now: number = Date.now(),
): boolean {
  if (
    (lead.source !== LANDING_999_SOURCE && lead.source !== LANDING_199_SOURCE) ||
    !lead.checkout_at ||
    lead.paid_at
  )
    return false;
  return Date.parse(lead.checkout_at) <= now - ABANDONED_AFTER_MS;
}

/* ---------------------------------------------- Batch 81: no password --- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** "asha@gmail.com" → "as•••@gmail.com" — enough to recognise, never the whole address. */
export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 2)}${"•".repeat(Math.max(3, Math.min(6, user.length - 2)))}@${domain}`;
}

/** A strong random password nobody sees (the buyer sets their own later, or signs in by link). */
export function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return `${btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}aA1!`;
}

export type AccountResult =
  | { ok: true; status: "created"; token_hash: string; user_id: string }
  | { ok: true; status: "existing"; sent_to: string | null }
  | { ok: false; status: number; error: string; field?: "email" | "phone" | "name" };

/**
 * Batch 81: the account behind a /999 checkout, with no password typed.
 *
 *  - New email and number: the account is made with the existing auth admin
 *    API (a random strong password, the same full_name + phone metadata
 *    /signup sends, so handle_new_user fills the profile the same way), and a
 *    one-time magic-link token (generateLink — no email is sent) goes back to
 *    this browser, which turns it into its session (verifyOtp). Email +
 *    password log-in keeps working: the buyer sets a password after paying.
 *  - The email, or the number, already has an account: never a dead end and
 *    never signed in for them — a one-time log-in link is emailed to that
 *    account (signInWithOtp, no new user) and the answer shows only a masked
 *    address. The link brings them back to /999 with their details kept.
 *
 * Only for a browser that saved its /999 lead (the lead cookie) with this
 * same number: no account is made without the lead's own checks (rate
 * limit, honeypot, number rules).
 */
export async function createOrRecallAccount(
  supabase: SupabaseClient,
  input: { leadId: string | null; phone: string; name: string; email: string },
  page: CheckoutPage = PAGE_999,
): Promise<AccountResult> {
  if (!input.leadId) {
    return { ok: false, status: 409, error: "Please start again from the checkout." };
  }
  const typed = checkRealNumber(input.phone);
  if (!typed.ok) return { ok: false, status: 400, error: typed.error, field: "phone" };
  const name = str(input.name, 100);
  if (name.length < 2) return { ok: false, status: 400, error: "Enter your name", field: "name" };
  const email = input.email.trim().toLowerCase().slice(0, 200);
  if (!EMAIL_RE.test(email)) {
    return { ok: false, status: 400, error: "Enter a valid email", field: "email" };
  }
  const { data: lead } = await supabase
    .from("demo_leads")
    .select("id, phone, source")
    .eq("id", input.leadId)
    .maybeSingle();
  const l = lead as { phone?: string; source?: string } | null;
  if (!l || l.source !== page.source || l.phone !== typed.phone) {
    return { ok: false, status: 409, error: "Please start again from the checkout." };
  }

  const { APP_PUBLIC_URL } = await import("@/lib/app-url");
  const auth = (supabase as unknown as { auth: SupabaseClient["auth"] }).auth;
  const recall = async (accountEmail: string): Promise<AccountResult> => {
    const { error } = await auth.signInWithOtp({
      email: accountEmail,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${APP_PUBLIC_URL}${page.path}?resume=1`,
      },
    });
    if (error) {
      console.log(
        JSON.stringify({ scope: "checkout_999", stage: "recall_failed", error: error.message }),
      );
    }
    return { ok: true, status: "existing", sent_to: error ? null : maskEmail(accountEmail) };
  };

  // This number already belongs to an account: that account's email gets the link.
  const { data: byPhone } = await supabase
    .from("profiles")
    .select("email")
    .eq("phone", typed.phone)
    .limit(1);
  const phoneEmail = ((byPhone ?? []) as Array<{ email?: string | null }>)[0]?.email ?? null;
  if (phoneEmail) return recall(phoneEmail);

  const made = await auth.admin.createUser({
    email,
    password: randomPassword(),
    email_confirm: true,
    user_metadata: { full_name: name, phone: typed.phone, signup_source: page.source },
  });
  if (made.error || !made.data.user) {
    const message = made.error?.message ?? "";
    if (/already (been )?registered|already exists|email_exists/i.test(message)) {
      return recall(email);
    }
    return { ok: false, status: 500, error: "We couldn't create your account. Please try again." };
  }
  const link = await auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = (link.data?.properties as { hashed_token?: string } | undefined)?.hashed_token;
  if (link.error || !tokenHash) {
    // The account exists; the emailed link signs them in instead.
    return recall(email);
  }
  return { ok: true, status: "created", token_hash: tokenHash, user_id: made.data.user.id };
}

/* ------------------------------------------- Batch 82: one ₹199 offer --- */

export type IntroCheck = "eligible" | "org_paid" | "phone_paid";

/** "+919812345670" → both ways numbers are stored ("+91…" and "91…"). */
function phoneVariants(phone: string): string[] {
  const digits = phone.replace(/\D/g, "");
  return digits ? [`+${digits}`, digits] : [];
}

/**
 * Batch 82: may this workspace / number still have the ₹199 offer? Checked on
 * the server at order creation (and on the lead step, by number alone).
 *  - "org_paid": the workspace has any paid payment;
 *  - "phone_paid": the number (Batch 78 rules → E.164, matched with or
 *    without "+") is on a paid lead (demo_leads.paid_at, any page), or is the
 *    owner's phone (profiles.phone) or the billing WhatsApp
 *    (billing_accounts.billing_whatsapp) of a workspace with a paid plan fee.
 * A failed read answers "eligible" only when nothing was found — the checks
 * that did run still refuse.
 */
export async function introCheck199(
  supabase: SupabaseClient,
  input: { organizationId: string | null; phone: string },
): Promise<IntroCheck> {
  if (input.organizationId) {
    const { data } = await supabase
      .from("payments")
      .select("id")
      .eq("organization_id", input.organizationId)
      .eq("status", "paid")
      .limit(1);
    if (((data ?? []) as unknown[]).length > 0) return "org_paid";
  }
  const typed = checkRealNumber(input.phone);
  const variants = phoneVariants(typed.ok ? typed.phone : input.phone);
  if (variants.length === 0) return "eligible";

  const { data: leads } = await supabase
    .from("demo_leads")
    .select("id")
    .in("phone", variants)
    .not("paid_at", "is", null)
    .limit(1);
  if (((leads ?? []) as unknown[]).length > 0) return "phone_paid";

  const orgIds = new Set<string>();
  const { data: people } = await supabase.from("profiles").select("id").in("phone", variants);
  const userIds = ((people ?? []) as Array<{ id: string }>).map((p) => p.id);
  if (userIds.length > 0) {
    const { data: owned } = await supabase
      .from("organization_members")
      .select("organization_id")
      .in("user_id", userIds)
      .eq("role", "owner");
    for (const m of (owned ?? []) as Array<{ organization_id: string }>)
      orgIds.add(m.organization_id);
  }
  const { data: accounts } = await supabase
    .from("billing_accounts")
    .select("id")
    .in("billing_whatsapp", variants);
  const accountIds = ((accounts ?? []) as Array<{ id: string }>).map((a) => a.id);
  if (accountIds.length > 0) {
    const { data: billed } = await supabase
      .from("organizations")
      .select("id")
      .in("billing_account_id", accountIds);
    for (const o of (billed ?? []) as Array<{ id: string }>) orgIds.add(o.id);
  }
  if (orgIds.size === 0) return "eligible";
  const { data: paid } = await supabase
    .from("payments")
    .select("id")
    .in("organization_id", [...orgIds])
    .eq("purpose", "plan_fee")
    .eq("status", "paid")
    .limit(1);
  return ((paid ?? []) as unknown[]).length > 0 ? "phone_paid" : "eligible";
}
