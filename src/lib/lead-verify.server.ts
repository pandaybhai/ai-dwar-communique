import type { SupabaseClient } from "@supabase/supabase-js";
import { APP_PUBLIC_URL } from "@/lib/app-url";
import { normalizePhone, toWaId } from "@/lib/phone";
import {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  newVerifyCode,
  readVerifyCode,
  verifyMessage,
  waMeLink,
  type VerifyState,
} from "@/lib/lead-verify";

/**
 * Batch 78: /start's WhatsApp verification, server side (taken from the
 * parked Batch 74 work — its VERIFY code only).
 *
 * After step 3 the lead is saved and the browser gets a code bound to (the
 * lead, its E.164 number, a random nonce kept in an httpOnly cookie — only
 * its sha256 is stored), 15 minutes, used once. The visitor sends
 * "VERIFY V-XXXX" to AiDwar's own number; it counts only when the sender's
 * wa_id is the lead's number. Then demo_leads.verified_at is set and the
 * reply (free text — the customer just wrote) carries the resume link to
 * /signup for someone who switched device. The page polls with its cookie.
 *
 * Meta's Lead is sent only for a verified lead, once per number: from the
 * verifying browser (its own request, fbc from the fbclid it arrived with),
 * else /start/continue, else the minute worker after a few minutes
 * (runVerifiedLeadEvents) — one event id, so Meta counts it once.
 */

export const NONCE_COOKIE = "aidwar_start_nonce";
export const NONCE_TTL_S = 60 * 60;
const PER_PHONE_PER_HOUR = 5;

const enc = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A random browser nonce (base64url, 24 bytes). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function nonceSetCookie(nonce: string): string {
  return `${NONCE_COOKIE}=${nonce}; Path=/api/public; HttpOnly; Secure; SameSite=Lax; Max-Age=${NONCE_TTL_S}`;
}

export function nonceFromRequest(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === NONCE_COOKIE) {
      const value = v.join("=");
      return /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : null;
    }
  }
  return null;
}

/* ------------------------------------------------------- the AiDwar number --- */

/** AiDwar's own WhatsApp number (digits), from platform_settings — never hardcoded. */
export async function aidwarWaId(supabase: SupabaseClient): Promise<string | null> {
  const { data: settings } = await supabase
    .from("platform_settings")
    .select("onboarding_whatsapp_account_id")
    .maybeSingle();
  const accountId =
    (settings as { onboarding_whatsapp_account_id?: string | null } | null)
      ?.onboarding_whatsapp_account_id ?? null;
  if (!accountId) return null;
  const { data: account } = await supabase
    .from("whatsapp_accounts")
    .select("display_phone_number")
    .eq("id", accountId)
    .maybeSingle();
  return (
    toWaId((account as { display_phone_number?: string | null } | null)?.display_phone_number) ||
    null
  );
}

/* ---------------------------------------------------------------- codes --- */

export type VerificationRow = {
  id: string;
  lead_id: string;
  code: string;
  phone: string;
  browser_nonce_hash: string;
  expires_at: string;
  used_at: string | null;
  attempts: number;
  created_at: string;
};

const ROW =
  "id, lead_id, code, phone, browser_nonce_hash, expires_at, used_at, attempts, created_at";

export type IssuedCode = { code: string; message: string; waLink: string; expiresAt: string };

/**
 * A fresh code for this lead, number and browser. At most 5 an hour per
 * number. Not available (no AiDwar number, or 20261420 not applied yet) →
 * an error the page answers by going on to /signup unverified.
 */
export async function issueVerifyCode(
  supabase: SupabaseClient,
  input: { leadId: string; phone: string; nonce: string; now?: number },
): Promise<{ ok: true; issued: IssuedCode } | { ok: false; error: string; status: number }> {
  const now = input.now ?? Date.now();
  const phone = normalizePhone(input.phone);
  const aidwar = await aidwarWaId(supabase);
  if (!aidwar) {
    return { ok: false, error: "WhatsApp verification isn't available right now.", status: 503 };
  }
  const { count, error: countError } = await supabase
    .from("lead_verifications")
    .select("id", { count: "exact", head: true })
    .eq("phone", phone)
    .gte("created_at", new Date(now - 60 * 60 * 1000).toISOString());
  if (countError) {
    log({ stage: "unavailable", error: countError.message });
    return { ok: false, error: "WhatsApp verification isn't available right now.", status: 503 };
  }
  if ((count ?? 0) >= PER_PHONE_PER_HOUR) {
    return {
      ok: false,
      error: "Too many codes for this number. Please try again in an hour.",
      status: 429,
    };
  }
  const expiresAt = new Date(now + CODE_TTL_MS).toISOString();
  const nonceHash = await sha256Hex(input.nonce);
  for (let i = 0; i < 5; i++) {
    const code = newVerifyCode(crypto.getRandomValues(new Uint8Array(4)));
    const { error } = await supabase.from("lead_verifications").insert({
      lead_id: input.leadId,
      code,
      phone,
      browser_nonce_hash: nonceHash,
      expires_at: expiresAt,
    });
    if (!error) {
      const message = verifyMessage(code);
      return { ok: true, issued: { code, message, waLink: waMeLink(aidwar, message), expiresAt } };
    }
    if (!/duplicate|unique|23505/i.test(`${error.code ?? ""} ${error.message ?? ""}`)) {
      log({ stage: "issue_failed", error: error.message });
      break;
    }
  }
  return { ok: false, error: "WhatsApp verification isn't available right now.", status: 503 };
}

/* -------------------------------------------------------------- inbound --- */

type Channel = {
  organizationId: string;
  phoneNumberId: string;
  accessToken: string;
  conversationId: string;
  to: string;
};

const START = "aidwar.in/start";

async function resumeLink(leadId: string, now: number): Promise<string> {
  const { continueToken } = await import("@/lib/start-lead-cookie.server");
  return `${APP_PUBLIC_URL}/start/continue?t=${await continueToken(leadId, now)}`;
}

/**
 * "VERIFY V-XXXX" sent to AiDwar's own number (the first stage of the
 * platform-number pipeline, before AD codes and the stranger reply). Counts
 * only when the sender is the lead's number; a wrong number never learns
 * whose code it is. Always answers the sender (free text — they just wrote)
 * and returns true; false only when the message carries no code.
 */
export async function handleVerifyMessage(
  supabase: SupabaseClient,
  args: { channel: Channel; waId: string; body: string; now?: number },
): Promise<boolean> {
  const code = readVerifyCode(args.body);
  if (!code) return false;
  const now = args.now ?? Date.now();
  const say = async (text: string, kind: string) => {
    const { sendServiceText } = await import("@/lib/service-text.server");
    await sendServiceText(supabase, {
      ...args.channel,
      windowOpen: true,
      body: text,
      metadata: { kind: `lead_verify_${kind}` },
    });
  };

  const { data } = await supabase
    .from("lead_verifications")
    .select(ROW)
    .eq("code", code)
    .maybeSingle();
  const row = (data as VerificationRow | null) ?? null;
  const sameNumber = Boolean(row) && toWaId(row!.phone) === toWaId(args.waId);

  if (!row) {
    await say(
      `We couldn't find that code. Go back to ${START} and tap "Open WhatsApp to verify" again.`,
      "unknown",
    );
    return true;
  }
  const attempts = row.attempts ?? 0;
  if (!sameNumber) {
    if (attempts < MAX_CODE_ATTEMPTS) {
      await supabase
        .from("lead_verifications")
        .update({ attempts: attempts + 1 })
        .eq("id", row.id);
    }
    await say(
      `This code is for a different WhatsApp number. Please send it from the number you typed on ${START}, or go back and enter this number.`,
      "wrong_number",
    );
    return true;
  }
  if (row.used_at) {
    // The same person sending it twice: they are verified; send the link again.
    await say(
      `✅ You're already verified! Tap to finish your free trial: ${await resumeLink(row.lead_id, now)}`,
      "repeat",
    );
    return true;
  }
  if (attempts >= MAX_CODE_ATTEMPTS || Date.parse(row.expires_at) <= now) {
    await say(
      `That code has expired. Go back to ${START} and tap "Open WhatsApp to verify" for a new one.`,
      "expired",
    );
    return true;
  }

  // The one moment the code counts: a conditional update, so two copies of the
  // same message (Meta retries) can't both use it.
  const at = new Date(now).toISOString();
  const { data: used } = await supabase
    .from("lead_verifications")
    .update({ used_at: at })
    .eq("id", row.id)
    .is("used_at", null)
    .select("id");
  if (!used || (used as unknown[]).length === 0) {
    await say(
      `✅ You're already verified! Tap to finish your free trial: ${await resumeLink(row.lead_id, now)}`,
      "repeat",
    );
    return true;
  }
  await supabase
    .from("demo_leads")
    .update({ verified_at: at })
    .eq("id", row.lead_id)
    .is("verified_at", null);
  const { data: lead } = await supabase
    .from("demo_leads")
    .select("name")
    .eq("id", row.lead_id)
    .maybeSingle();
  const first = String((lead as { name?: string | null } | null)?.name ?? "")
    .trim()
    .split(/\s+/)[0];
  await say(
    `✅ Verified${first ? `, ${first}` : ""}! Tap to finish your free trial: ${await resumeLink(row.lead_id, now)}`,
    "verified",
  );
  log({ stage: "verified", lead: row.lead_id });
  return true;
}

/* ------------------------------------------------------- browser checks --- */

/** Where this browser's newest code for its lead stands. */
export async function pollVerify(
  supabase: SupabaseClient,
  input: { leadId: string; nonce: string; now?: number },
): Promise<VerifyState> {
  const now = input.now ?? Date.now();
  const { data } = await supabase
    .from("lead_verifications")
    .select(ROW)
    .eq("lead_id", input.leadId)
    .eq("browser_nonce_hash", await sha256Hex(input.nonce))
    .order("created_at", { ascending: false })
    .limit(1);
  const row = ((data ?? []) as VerificationRow[])[0];
  if (!row) return "none";
  if (row.used_at) return "verified";
  if (Date.parse(row.expires_at) <= now || (row.attempts ?? 0) >= MAX_CODE_ATTEMPTS)
    return "expired";
  return "waiting";
}

type StartLead = {
  id: string;
  name: string | null;
  business_name: string | null;
  phone: string;
  source: string;
  qualification: { sells?: string; customers?: string } | null;
  verified_at?: string | null;
  linked_user_id: string | null;
  organization_id: string | null;
};

export async function readStartLead(
  supabase: SupabaseClient,
  leadId: string,
): Promise<StartLead | null> {
  const { data } = await supabase
    .from("demo_leads")
    // "*": works before 20261420 adds verified_at (then undefined = not verified).
    .select("*")
    .eq("id", leadId)
    .maybeSingle();
  const lead = (data as StartLead | null) ?? null;
  return lead && lead.source === "landing_start"
    ? { ...lead, verified_at: lead.verified_at ?? null }
    : null;
}

/**
 * Meta's Lead for a verified /start lead — "Lead." + sha256(number), the id
 * Batch 72 used for every Lead of that person, so Meta counts them once;
 * hashed ph / fn / ln / external_id (the lead id), fbc from the fbclid, and
 * custom_data { lead_source, sells, customers, verified: true }. Never for an
 * unverified lead. Answers the browser copy (fired only after consent).
 */
export async function sendVerifiedLead(
  supabase: SupabaseClient,
  lead: StartLead,
  opts: {
    request?: Request | null;
    fbc?: string | null;
    actionSource?: "website" | "system_generated";
    now?: number;
  } = {},
): Promise<import("@/lib/meta-events").BrowserMetaEvent | null> {
  if (!lead.verified_at) return null;
  try {
    const { leadEventId, safeParams } = await import("@/lib/meta-events");
    const eventId = await leadEventId(lead.phone, lead.id);
    const params = safeParams({
      lead_source: "landing_start",
      sells: lead.qualification?.sells,
      customers: lead.qualification?.customers,
      verified: true,
    });
    const capi = await import("@/lib/meta-capi.server");
    const event = {
      event: "Lead" as const,
      eventId,
      params,
      actionSource: opts.actionSource ?? "website",
      request: opts.request ?? null,
      lead: { phone: lead.phone, name: lead.name, leadId: lead.id },
      fbc: opts.fbc ?? null,
      once: true,
    };
    if (opts.actionSource === "system_generated") await capi.sendMetaEvent(supabase, event);
    else await capi.queueMetaEvent(supabase, event);
    return { event: "Lead", event_id: eventId, params };
  } catch {
    return null; // measurement never changes the answer
  }
}

/**
 * The verifying browser takes its result: the details for /signup's prefill
 * and Meta's Lead (its own request, fbc from its fbclid). Only for this
 * browser's own lead (cookie) and nonce, only once it is verified.
 */
export async function claimVerified(
  supabase: SupabaseClient,
  input: { leadId: string; nonce: string; request: Request; fbc: string | null; now?: number },
): Promise<
  | {
      ok: true;
      prefill: { name: string; phone: string; business_name: string };
      meta: import("@/lib/meta-events").BrowserMetaEvent | null;
    }
  | { ok: false; state: VerifyState }
> {
  const state = await pollVerify(supabase, input);
  if (state !== "verified") return { ok: false, state };
  const lead = await readStartLead(supabase, input.leadId);
  if (!lead || !lead.verified_at) return { ok: false, state: "waiting" };
  const meta = await sendVerifiedLead(supabase, lead, { request: input.request, fbc: input.fbc });
  return {
    ok: true,
    prefill: { name: lead.name ?? "", phone: lead.phone, business_name: lead.business_name ?? "" },
    meta,
  };
}

/**
 * The minute worker's safety net: a lead verified 2–60 minutes ago whose Lead
 * nobody sent (the visitor closed the page and never opened the link) gets
 * it now, system_generated. The once-marker makes a second send impossible.
 */
export async function runVerifiedLeadEvents(
  supabase: SupabaseClient,
  opts: { now?: number; limit?: number } = {},
): Promise<{ checked: number }> {
  const now = opts.now ?? Date.now();
  const { data, error } = await supabase
    .from("demo_leads")
    .select(
      "id, name, business_name, phone, source, qualification, verified_at, linked_user_id, organization_id",
    )
    .eq("source", "landing_start")
    .eq("is_test", false)
    .lte("verified_at", new Date(now - 2 * 60 * 1000).toISOString())
    .gte("verified_at", new Date(now - 60 * 60 * 1000).toISOString())
    .order("verified_at", { ascending: true })
    .limit(opts.limit ?? 10);
  if (error) return { checked: 0 };
  const leads = (data ?? []) as StartLead[];
  for (const lead of leads) {
    await sendVerifiedLead(supabase, lead, { actionSource: "system_generated", now });
  }
  return { checked: leads.length };
}

function log(detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ scope: "lead_verify", ...detail }));
}
