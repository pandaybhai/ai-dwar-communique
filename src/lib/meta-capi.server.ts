import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CUSTOM_EVENTS,
  META_PIXEL_ID,
  hashedUserData,
  safeParams,
  type MetaEventName,
  type MetaParams,
} from "@/lib/meta-events";

/**
 * Batch 70: the Meta Conversions API — every conversion in AiDwar's own funnel
 * is also sent from the server, with the same event_name and event_id as the
 * browser pixel, so Meta counts it once.
 *
 *  - The access token is read only from the server secret META_CAPI_TOKEN
 *    (process.env; never in code, the client bundle or a log). Missing: nothing
 *    is sent, logged once per process. META_CAPI_TEST_CODE (optional) adds
 *    test_event_code for Events Manager > Test events.
 *  - Never blocks or breaks the flow it describes: queueMetaEvent hands the
 *    send to the runtime's waitUntil when there is one, else waits at most a
 *    few seconds; every failure is swallowed and recorded.
 *  - Customer matching only for AiDwar's own users (the workspace owner who
 *    signed up): email, phone, first name and user id, normalised and SHA-256
 *    hashed. Never a merchant's customers, contacts, messages or workspace data.
 *  - A user who switched off "Share my activity with Meta" (auth user_metadata
 *    meta_share_opt_out) is never sent.
 *  - Each keyed event (a payment, a workspace's first X) is sent once: a
 *    "meta_event_sent" row on the platform workspace's activity log is the
 *    marker, and the latest sent/failed rows are what Super Admin's status line
 *    reads.
 */

export const META_CAPI_TIMEOUT_MS = 4000;
const QUEUE_WAIT_MS = 5000;

export type MetaServerEvent = {
  event: MetaEventName;
  eventId: string;
  params?: Record<string, unknown>;
  /** The AiDwar user the event is about (signed up / paying), for matching and opt-out. */
  userId?: string | null;
  /** A workspace event: matched to (and opted out by) its first owner. */
  organizationId?: string | null;
  /**
   * "website": a person's own request (ip, user agent, _fbp/_fbc cookies are
   * read from it). "system_generated": settled by a webhook, a sweep or a Super
   * Admin — no request is that person's, so none of it is read.
   */
  actionSource?: "website" | "system_generated";
  /** The page the event happened on (the browser's URL for relayed events). */
  sourceUrl?: string | null;
  /** The person's own request, when the caller has it (else the current one is used for "website"). */
  request?: Request | null;
  /** Only once per event id (payments, workspace firsts). Browser-random ids skip the marker. */
  once?: boolean;
  /**
   * Batch 72: a lead who has no account yet (the /start or /demo form): their
   * own number and name, hashed before sending, and the lead id as
   * external_id. Never a merchant's customer.
   */
  lead?: { phone: string | null; name: string | null; leadId: string } | null;
  /** Batch 72: fbc built from the fbclid the visitor arrived with (used when no _fbc cookie). */
  fbc?: string | null;
  /** Batch 77: the _fbp cookie stored from the lead's own visit (used when no request has one). */
  fbp?: string | null;
};

let tokenMissingLogged = false;

/** The token, from the standard env name only; never returned to a client or logged. */
export function capiToken(env: Record<string, string | undefined> = process.env): string | null {
  const t = (env["META_CAPI_TOKEN"] ?? "").trim();
  return t || null;
}

function capiTestCode(env: Record<string, string | undefined> = process.env): string | null {
  const t = (env["META_CAPI_TEST_CODE"] ?? "").trim();
  return t || null;
}

/** The current request, when the code runs inside one (portable: no host API). */
async function currentRequest(): Promise<Request | null> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    return getRequest() ?? null;
  } catch {
    return null;
  }
}

type WaitUntil = (promise: Promise<unknown>) => void;
function waitUntilOf(request: Request | null): WaitUntil | null {
  if (!request) return null;
  const r = request as Request & {
    waitUntil?: WaitUntil;
    runtime?: { cloudflare?: { context?: { waitUntil?: WaitUntil } } };
  };
  if (typeof r.waitUntil === "function") return r.waitUntil;
  const ctx = r.runtime?.cloudflare?.context;
  if (ctx && typeof ctx.waitUntil === "function") return ctx.waitUntil.bind(ctx);
  return null;
}

/** ip, user agent and Meta's own cookies from a person's request. */
export function requestFacts(request: Request | null): {
  client_ip_address?: string;
  client_user_agent?: string;
  fbp?: string;
  fbc?: string;
} {
  if (!request) return {};
  const h = request.headers;
  const ip =
    h.get("cf-connecting-ip") ??
    h.get("x-real-ip") ??
    h.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  const ua = h.get("user-agent");
  const cookies = Object.fromEntries(
    (h.get("cookie") ?? "")
      .split(";")
      .map((c) => c.trim().split("="))
      .filter((p) => p.length >= 2)
      .map(([k, ...v]) => [k!, v.join("=")]),
  );
  const out: {
    client_ip_address?: string;
    client_user_agent?: string;
    fbp?: string;
    fbc?: string;
  } = {};
  if (ip) out.client_ip_address = ip.slice(0, 64);
  if (ua) out.client_user_agent = ua.slice(0, 400);
  const fbp = cookies["_fbp"];
  if (fbp && /^fb\.\d\.\d+\.\d+$/.test(fbp)) out.fbp = fbp;
  const fbc = cookies["_fbc"];
  if (fbc && /^fb\.\d\.\d+\.[A-Za-z0-9_-]+$/.test(fbc)) out.fbc = fbc;
  return out;
}

/** The workspace's first owner (the person who signed up). */
async function ownerOf(supabase: SupabaseClient, organizationId: string): Promise<string | null> {
  const { data } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .order("created_at", { ascending: true })
    .limit(1);
  return ((data ?? []) as { user_id: string }[])[0]?.user_id ?? null;
}

type Person = {
  userId: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  optedOut: boolean;
  createdAt: string | null;
};

/** The AiDwar user's own facts (auth + profile). Null when unreadable. */
export async function loadPerson(supabase: SupabaseClient, userId: string): Promise<Person | null> {
  try {
    const admin = (
      supabase as unknown as {
        auth?: { admin?: { getUserById?: (id: string) => Promise<{ data: { user: unknown } }> } };
      }
    ).auth?.admin;
    const got = admin?.getUserById ? await admin.getUserById(userId) : null;
    const user = (got?.data?.user ?? null) as {
      email?: string | null;
      created_at?: string | null;
      user_metadata?: Record<string, unknown> | null;
    } | null;
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, phone")
      .eq("id", userId)
      .maybeSingle();
    const p = (profile ?? {}) as { full_name?: string | null; phone?: string | null };
    const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
    if (!user && !profile) return null;
    return {
      userId,
      email: user?.email ?? null,
      phone: p.phone ?? (typeof meta["phone"] === "string" ? (meta["phone"] as string) : null),
      // Batch 72: a brand-new sign-up's name is in its metadata (full_name).
      firstName:
        p.full_name ??
        (typeof meta["full_name"] === "string" ? (meta["full_name"] as string) : null),
      optedOut: meta["meta_share_opt_out"] === true,
      createdAt: user?.created_at ?? null,
    };
  } catch {
    return null;
  }
}

/** The Graph request body for one event (exported for tests). */
export async function capiBody(input: {
  event: MetaEventName;
  eventId: string;
  eventTime: number;
  actionSource: "website" | "system_generated";
  sourceUrl: string | null;
  params: MetaParams;
  person: Person | null;
  facts: ReturnType<typeof requestFacts>;
  testCode: string | null;
  lead?: MetaServerEvent["lead"];
  fbc?: string | null;
  fbp?: string | null;
}): Promise<Record<string, unknown>> {
  const userData: Record<string, unknown> = {
    ...(input.person
      ? await hashedUserData({
          email: input.person.email,
          phone: input.person.phone,
          fullName: input.person.firstName,
          userId: input.person.userId,
        })
      : input.lead
        ? await hashedUserData({
            phone: input.lead.phone,
            fullName: input.lead.name,
            userId: input.lead.leadId,
          })
        : {}),
    ...input.facts,
  };
  // The _fbc cookie when the visitor has one (cookie consent), else the one
  // built from the fbclid they arrived with.
  if (!userData["fbc"] && input.fbc) userData["fbc"] = input.fbc;
  if (!userData["fbp"] && input.fbp) userData["fbp"] = input.fbp;
  const event: Record<string, unknown> = {
    event_name: input.event,
    event_time: input.eventTime,
    event_id: input.eventId,
    action_source: input.actionSource,
    user_data: userData,
    custom_data: input.params,
  };
  if (input.sourceUrl) event["event_source_url"] = input.sourceUrl;
  return { data: [event], ...(input.testCode ? { test_event_code: input.testCode } : {}) };
}

async function platformOrg(supabase: SupabaseClient): Promise<string | null> {
  try {
    const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
    return await resolvePlatformOrg(supabase);
  } catch {
    return null;
  }
}

async function alreadySent(
  supabase: SupabaseClient,
  platform: string | null,
  eventId: string,
): Promise<boolean> {
  if (!platform) return false;
  const { data } = await supabase
    .from("activity_log")
    .select("id")
    .eq("organization_id", platform)
    .eq("action", "meta_event_sent")
    .eq("details->>event_id", eventId)
    .limit(1);
  return ((data ?? []) as unknown[]).length > 0;
}

async function record(
  supabase: SupabaseClient,
  platform: string | null,
  action: "meta_event_sent" | "meta_event_failed",
  details: Record<string, unknown>,
): Promise<void> {
  if (!platform) return;
  try {
    await supabase
      .from("activity_log")
      .insert({ organization_id: platform, user_id: null, action, details });
  } catch {
    // the record never changes the send
  }
}

export type SendOutcome =
  "sent" | "token_missing" | "opted_out" | "already_sent" | "no_person" | "failed";

/** Sends one event now. Never throws. */
export async function sendMetaEvent(
  supabase: SupabaseClient,
  ev: MetaServerEvent,
  env: Record<string, string | undefined> = process.env,
): Promise<SendOutcome> {
  try {
    const token = capiToken(env);
    if (!token) {
      if (!tokenMissingLogged) {
        tokenMissingLogged = true;
        console.log(JSON.stringify({ scope: "meta_capi", stage: "token_missing" }));
      }
      return "token_missing";
    }

    // Who the event is about: the user, else the workspace's first owner.
    let userId = ev.userId ?? null;
    if (!userId && ev.organizationId) userId = await ownerOf(supabase, ev.organizationId);
    const person = userId ? await loadPerson(supabase, userId) : null;
    if (person?.optedOut) return "opted_out";
    // A workspace or account event needs its person (matching + opt-out); a
    // visitor's page event (ViewContent, Contact, Lead) has none.
    if ((ev.organizationId || ev.userId) && !person) return "no_person";

    const platform = await platformOrg(supabase);
    if (ev.once && (await alreadySent(supabase, platform, ev.eventId))) return "already_sent";

    const actionSource = ev.actionSource ?? "website";
    const request = actionSource === "website" ? (ev.request ?? (await currentRequest())) : null;
    const body = await capiBody({
      event: ev.event,
      eventId: ev.eventId,
      eventTime: Math.floor(Date.now() / 1000),
      actionSource,
      sourceUrl:
        ev.sourceUrl ??
        (actionSource === "website" ? (request?.headers.get("referer") ?? null) : null),
      params: safeParams(ev.params ?? {}),
      person,
      facts: requestFacts(request),
      testCode: capiTestCode(env),
      lead: person ? null : (ev.lead ?? null),
      fbc: ev.fbc ?? null,
      fbp: ev.fbp ?? null,
    });

    const { GRAPH_VERSION } = await import("@/lib/whatsapp-api.server");
    const { outsideFetch } = await import("@/lib/outside-call.server");
    // The token goes in the POST body, never in a URL a log could print.
    const res = await outsideFetch(
      "meta",
      `https://graph.facebook.com/${GRAPH_VERSION}/${META_PIXEL_ID}/events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...body, access_token: token }),
      },
      { timeoutMs: META_CAPI_TIMEOUT_MS },
    );
    const custom = (CUSTOM_EVENTS as readonly string[]).includes(ev.event);
    if (!res.ok) {
      const answer = (await res.json().catch(() => ({}))) as {
        error?: { code?: number; error_subcode?: number };
      };
      const code = answer.error?.code ?? res.status;
      console.log(
        JSON.stringify({ scope: "meta_capi", stage: "send_failed", event: ev.event, code }),
      );
      await record(supabase, platform, "meta_event_failed", {
        event: ev.event,
        event_id: ev.eventId,
        code,
        status: res.status,
      });
      return "failed";
    }
    await record(supabase, platform, "meta_event_sent", {
      event: ev.event,
      event_id: ev.eventId,
      custom,
      ...(ev.organizationId ? { organization_id: ev.organizationId } : {}),
    });
    return "sent";
  } catch (error) {
    const reason = error instanceof Error ? error.name : "error";
    console.log(
      JSON.stringify({ scope: "meta_capi", stage: "send_threw", event: ev.event, reason }),
    );
    try {
      await record(supabase, await platformOrg(supabase), "meta_event_failed", {
        event: ev.event,
        event_id: ev.eventId,
        code: reason.slice(0, 40),
      });
    } catch {
      // nothing more to do
    }
    return "failed";
  }
}

/**
 * Hands the send to the runtime (waitUntil) so the flow answers at once; with
 * no runtime to hand it to, waits at most QUEUE_WAIT_MS. Never throws.
 */
export async function queueMetaEvent(supabase: SupabaseClient, ev: MetaServerEvent): Promise<void> {
  try {
    if (!capiToken()) {
      // Logged once, nothing else to do.
      await sendMetaEvent(supabase, ev);
      return;
    }
    const request = ev.request ?? (await currentRequest());
    // The person's request is captured now: after the response there may be none.
    const work = sendMetaEvent(supabase, { ...ev, request }).then(
      () => undefined,
      () => undefined,
    );
    const later = waitUntilOf(request);
    if (later) {
      later(work);
      return;
    }
    await Promise.race([work, new Promise<void>((r) => setTimeout(r, QUEUE_WAIT_MS))]);
  } catch {
    // measurement never breaks the flow
  }
}

/** Super Admin's status line: token present, and the latest send outcome. Never the token. */
export async function metaCapiStatus(
  supabase: SupabaseClient,
  env: Record<string, string | undefined> = process.env,
): Promise<{
  token: "connected" | "missing";
  test_code: boolean;
  last_ok_at: string | null;
  last_error: { at: string; code: string | number | null; event: string | null } | null;
}> {
  const token = capiToken(env) ? "connected" : "missing";
  const platform = await platformOrg(supabase);
  const latest = async (action: string) => {
    if (!platform) return null;
    const { data } = await supabase
      .from("activity_log")
      .select("created_at, details")
      .eq("organization_id", platform)
      .eq("action", action)
      .order("created_at", { ascending: false })
      .limit(1);
    return (
      ((data ?? []) as { created_at: string; details: Record<string, unknown> | null }[])[0] ?? null
    );
  };
  const [ok, bad] = await Promise.all([latest("meta_event_sent"), latest("meta_event_failed")]);
  return {
    token,
    test_code: Boolean(capiTestCode(env)),
    last_ok_at: ok?.created_at ?? null,
    last_error:
      bad && (!ok || bad.created_at > ok.created_at)
        ? {
            at: bad.created_at,
            code: (bad.details?.["code"] as string | number | null) ?? null,
            event: (bad.details?.["event"] as string | null) ?? null,
          }
        : null,
  };
}

/** Test hook: forget that the missing token was logged. */
export function resetMetaCapiForTests(): void {
  tokenMissingLogged = false;
}

// ------------------------------------------------------------ the conversions

/** A workspace's monthly plan fee (its own override, else the plan's price). */
async function monthlyFee(supabase: SupabaseClient, organizationId: string): Promise<number> {
  const { data: org } = await supabase
    .from("organizations")
    .select("plan_version_id")
    .eq("id", organizationId)
    .maybeSingle();
  const versionId = (org?.["plan_version_id"] as string | null) ?? null;
  const [{ data: version }, { data: settings }] = await Promise.all([
    versionId
      ? supabase.from("plan_versions").select("price_monthly").eq("id", versionId).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("organization_billing_settings")
      .select("plan_fee_override")
      .eq("organization_id", organizationId)
      .maybeSingle(),
  ]);
  const override = Number(settings?.["plan_fee_override"] ?? Number.NaN);
  if (Number.isFinite(override) && override > 0) return override;
  return Number(version?.["price_monthly"] ?? 0) || 0;
}

/**
 * A paid payment's conversion: Subscribe for a plan fee (every confirmed plan
 * payment, Batch 68's offline records included), Purchase for credits. The
 * settle hook sends it and the browser fires the very same (name, id, value).
 */
export async function paymentConversion(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<{
  event: "Subscribe" | "Purchase";
  eventId: string;
  params: MetaParams;
  organizationId: string;
} | null> {
  const { data: payment } = await supabase
    .from("payments")
    .select("id, organization_id, status, purpose, amount, raw")
    .eq("id", paymentId)
    .maybeSingle();
  if (!payment || payment["status"] !== "paid" || !payment["organization_id"]) return null;
  const purpose = String(payment["purpose"] ?? "");
  if (purpose !== "plan_fee" && purpose !== "credit_purchase") return null;
  const { paymentGross } = await import("@/lib/invoices.server");
  const gross = paymentGross(payment as Record<string, unknown>);
  const organizationId = String(payment["organization_id"]);
  const { metaEventId, predictedLtv } = await import("@/lib/meta-events");
  // Batch 80: a /999 purchase is the page's Purchase — the price paid (net
  // of any GST), id "Purchase." + payment id, the same the browser fires.
  const raw = (payment["raw"] ?? {}) as Record<string, unknown>;
  if (purpose === "plan_fee" && raw["source"] === "landing_999") {
    return {
      event: "Purchase",
      eventId: metaEventId("Purchase", paymentId),
      params: safeParams({
        value: Number(payment["amount"] ?? 0),
        currency: "INR",
        content_name: "basic",
      }),
      organizationId,
    };
  }
  if (purpose === "plan_fee") {
    const fee = await monthlyFee(supabase, organizationId);
    return {
      event: "Subscribe",
      eventId: metaEventId("Subscribe", paymentId),
      params: safeParams({ value: gross, currency: "INR", predicted_ltv: predictedLtv(fee, 12) }),
      organizationId,
    };
  }
  return {
    event: "Purchase",
    eventId: metaEventId("Purchase", paymentId),
    params: safeParams({ value: gross, currency: "INR" }),
    organizationId,
  };
}

/**
 * settlePayment's hook, after the payment is marked paid: once per payment.
 * Settled by a webhook, a sweep or a Super Admin, so no request is the
 * owner's: system_generated, matched by the owner's hashed facts.
 */
export async function metaPaymentSettled(
  supabase: SupabaseClient,
  paymentId: string,
): Promise<void> {
  try {
    const c = await paymentConversion(supabase, paymentId);
    if (!c) return;
    await queueMetaEvent(supabase, {
      event: c.event,
      eventId: c.eventId,
      params: c.params,
      organizationId: c.organizationId,
      actionSource: "system_generated",
      once: true,
    });
  } catch {
    // measurement never touches settlement
  }
}

/** The service client (owner lookup, opt-out, markers); the caller's own when there is none. */
async function serviceOr(fallback: SupabaseClient): Promise<SupabaseClient> {
  try {
    const { getServiceClient } = await import("@/lib/whatsapp-webhook.server");
    return getServiceClient() ?? fallback;
  } catch {
    return fallback;
  }
}

/** A workspace's first WhatsApp number / campaign sent / flow live / Aiden replying: once per workspace. */
export async function metaWorkspaceFirst(
  supabase: SupabaseClient,
  organizationId: string,
  event: "WhatsAppConnected" | "FirstCampaignSent" | "FirstFlowActivated" | "AidenEnabled",
  /** "website" only when the current request is the owner's own (connect, publish, Aiden on). */
  actionSource: "website" | "system_generated" = "website",
): Promise<void> {
  try {
    const { metaEventId } = await import("@/lib/meta-events");
    await queueMetaEvent(await serviceOr(supabase), {
      event,
      eventId: metaEventId(event, organizationId),
      organizationId,
      actionSource,
      once: true,
    });
  } catch {
    // never touches the flow it describes
  }
}

/**
 * A plan change: PlanUpgraded when a workspace moves from one paid plan to a
 * dearer one (a first plan is Subscribe, not an upgrade). Once per change.
 */
export async function metaPlanChanged(
  supabase: SupabaseClient,
  organizationId: string,
  fromVersionId: string | null,
  toVersionId: string | null,
): Promise<void> {
  try {
    if (!fromVersionId || !toVersionId || fromVersionId === toVersionId) return;
    supabase = await serviceOr(supabase);
    const { data } = await supabase
      .from("plan_versions")
      .select("id, price_monthly")
      .in("id", [fromVersionId, toVersionId]);
    const price = (id: string) =>
      Number(
        ((data ?? []) as { id: string; price_monthly: number | null }[]).find((v) => v.id === id)
          ?.price_monthly ?? 0,
      );
    const from = price(fromVersionId);
    const to = price(toVersionId);
    if (!(from > 0 && to > from)) return;
    const { metaEventId } = await import("@/lib/meta-events");
    await queueMetaEvent(supabase, {
      event: "PlanUpgraded",
      eventId: metaEventId("PlanUpgraded", `${organizationId}-${toVersionId}`),
      params: { value: to, currency: "INR" },
      organizationId,
      // Changed by a webhook, a sweep or a Super Admin: never the owner's request.
      actionSource: "system_generated",
      once: true,
    });
  } catch {
    // never touches the plan change
  }
}

/**
 * A checkout our server just created (plan or credits): InitiateCheckout with
 * what the payment will charge, sent from the buyer's own request, once per
 * payment. Answers what the browser fires (same id and value).
 */
export async function metaCheckoutStarted(
  supabase: SupabaseClient,
  input: { paymentId: string; userId: string; request: Request },
): Promise<import("@/lib/meta-events").BrowserMetaEvent | null> {
  try {
    const { data: payment } = await supabase
      .from("payments")
      .select("id, amount, raw")
      .eq("id", input.paymentId)
      .maybeSingle();
    if (!payment) return null;
    const { paymentGross } = await import("@/lib/invoices.server");
    const { metaEventId } = await import("@/lib/meta-events");
    const eventId = metaEventId("InitiateCheckout", input.paymentId);
    const params = safeParams({
      value: paymentGross(payment as Record<string, unknown>),
      currency: "INR",
    });
    await queueMetaEvent(supabase, {
      event: "InitiateCheckout",
      eventId,
      params,
      userId: input.userId,
      request: input.request,
      once: true,
    });
    return { event: "InitiateCheckout", event_id: eventId, params };
  } catch {
    return null;
  }
}
