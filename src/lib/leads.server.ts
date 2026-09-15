/**
 * Demo enquiry storage. Server-only: every function here runs with the service
 * role, because public.demo_leads has RLS enabled with no policies — the table
 * is unreachable from any client key by design. Merchant admins therefore can
 * never read another business's sales enquiries.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "./phone";
import {
  BUSINESS_TYPES,
  CONSENT_VERSION,
  ENQUIRY_BANDS,
  PRIMARY_NEEDS,
  type LeadNote,
  type LeadRow,
  type LeadStatus,
  type LeadSubmission,
} from "./leads";

const ATTRIBUTION_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
  "ref",
] as const;

/**
 * Ad click IDs (gclid, fbclid, wbraid, gbraid, msclkid) are never stored.
 * Demo-contact permission is not advertising/tracking consent, and there is
 * no separate verified advertising-consent mechanism, so we drop them at the
 * server even if a client sends them.
 */

export type LeadResult =
  | { ok: true; id: string; duplicate: boolean }
  | { ok: false; error: string; status: number };

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function oneOf(options: ReadonlyArray<{ value: string }>, value: string): boolean {
  return options.some((o) => o.value === value);
}

/** Strips query strings and fragments — referrers can carry session tokens. */
function referrerHost(referrer: string | null): string | null {
  if (!referrer) return null;
  try {
    return new URL(referrer).host.slice(0, 200);
  } catch {
    return null;
  }
}

function safePath(value: string): string | null {
  if (!value.startsWith("/")) return null;
  return value.split("?")[0]?.split("#")[0]?.slice(0, 300) ?? null;
}

function cleanAttribution(
  input: Record<string, unknown> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const key of ATTRIBUTION_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 200);
  }
  return out;
}

async function hashIp(ip: string): Promise<string> {
  const data = new TextEncoder().encode(`aidwar-lead:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .slice(0, 12)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function submitLead(
  supabase: SupabaseClient,
  body: Partial<LeadSubmission>,
  meta: { ip: string | null; referrer: string | null },
): Promise<LeadResult> {
  // Honeypot — a real person never fills a hidden field.
  if (str(body.company_website_confirm, 200)) {
    return { ok: false, error: "We couldn't send that request.", status: 400 };
  }

  const business_type = str(body.business_type, 40);
  const enquiry_band = str(body.enquiry_band, 20);
  const primary_need = str(body.primary_need, 40);
  if (
    !oneOf(BUSINESS_TYPES, business_type) ||
    !oneOf(ENQUIRY_BANDS, enquiry_band) ||
    !oneOf(PRIMARY_NEEDS, primary_need)
  ) {
    return { ok: false, error: "Please choose an option in each question.", status: 400 };
  }

  const name = str(body.name, 100);
  const business_name = str(body.business_name, 150);
  if (name.length < 2) return { ok: false, error: "Please enter your name.", status: 400 };
  if (business_name.length < 2) {
    return { ok: false, error: "Please enter your business name.", status: 400 };
  }

  const phone = normalizePhone(str(body.phone, 30));
  if (phone.replace(/\D/g, "").length < 10 || phone.replace(/\D/g, "").length > 15) {
    return {
      ok: false,
      error: "Please enter your WhatsApp number with country code, like +91 98765 43210.",
      status: 400,
    };
  }

  let website: string | null = str(body.website, 200) || null;
  if (website) {
    const candidate = /^https?:\/\//i.test(website) ? website : `https://${website}`;
    try {
      website = new URL(candidate).toString().slice(0, 200);
    } catch {
      return { ok: false, error: "That website address doesn't look right.", status: 400 };
    }
  }

  if (body.consent !== true) {
    return {
      ok: false,
      error: "Please tick the box so we may contact you about this demo.",
      status: 400,
    };
  }

  const ipHash = meta.ip ? await hashIp(meta.ip) : null;

  // Rate limit: at most 5 enquiries an hour from one network.
  if (ipHash) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("demo_leads")
      .select("id", { count: "exact", head: true })
      .eq("ip_hash", ipHash)
      .gte("created_at", since);
    if ((count ?? 0) >= 5) {
      return {
        ok: false,
        error: "We've already got a few requests from here. Please try again later.",
        status: 429,
      };
    }
  }

  // Double submission: same number inside 10 minutes is the same enquiry.
  const dedupeSince = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: existing } = await supabase
    .from("demo_leads")
    .select("id")
    .eq("phone", phone)
    .gte("created_at", dedupeSince)
    .limit(1)
    .maybeSingle();
  if (existing) return { ok: true, id: (existing as { id: string }).id, duplicate: true };

  const attribution = cleanAttribution(body.attribution as Record<string, unknown>);

  const { data, error } = await supabase
    .from("demo_leads")
    .insert({
      business_type,
      enquiry_band,
      primary_need,
      name,
      business_name,
      phone,
      website,
      consent: true,
      consent_version: str(body.consent_version, 40) || CONSENT_VERSION,
      consent_at: new Date().toISOString(),
      landing_path: safePath(str(body.landing_path, 300)),
      referrer_host: referrerHost(meta.referrer),
      first_attribution: attribution,
      latest_attribution: attribution,
      ip_hash: ipHash,
    })
    .select("id")
    .single();

  if (error || !data) {
    return { ok: false, error: "We couldn't save that just now. Please try again.", status: 500 };
  }
  return { ok: true, id: (data as { id: string }).id, duplicate: false };
}

/* ---------------------------------------------------------------- admin --- */

export async function listLeads(
  supabase: SupabaseClient,
): Promise<{ leads: LeadRow[]; new_count: number; admins: Array<{ id: string; name: string }> }> {
  const { data } = await supabase
    .from("demo_leads")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(500);

  const leads = ((data ?? []) as LeadRow[]).map((l) => ({ ...l, ip_hash: undefined }) as LeadRow);

  const { data: admins } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .eq("is_super_admin", true);

  return {
    leads,
    new_count: leads.filter((l) => l.status === "new" && !l.is_test).length,
    admins: ((admins ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>)
      .map((a) => ({ id: a.id, name: a.full_name || a.email || "Admin" })),
  };
}

export async function listNotes(
  supabase: SupabaseClient,
  leadId: string,
): Promise<LeadNote[]> {
  const { data } = await supabase
    .from("demo_lead_notes")
    .select("id, lead_id, author_id, body, created_at")
    .eq("lead_id", leadId)
    .order("created_at", { ascending: false });
  const notes = (data ?? []) as LeadNote[];

  const ids = Array.from(new Set(notes.map((n) => n.author_id).filter(Boolean))) as string[];
  if (!ids.length) return notes.map((n) => ({ ...n, author_name: null }));
  const { data: people } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .in("id", ids);
  const byId = new Map(
    ((people ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>).map(
      (p) => [p.id, p.full_name || p.email || "Admin"],
    ),
  );
  return notes.map((n) => ({ ...n, author_name: n.author_id ? (byId.get(n.author_id) ?? null) : null }));
}

export async function updateLead(
  supabase: SupabaseClient,
  leadId: string,
  patch: { status?: LeadStatus; assigned_to?: string | null; demo_at?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const update: Record<string, unknown> = {};
  if (patch.status) update["status"] = patch.status;
  if ("assigned_to" in patch) update["assigned_to"] = patch.assigned_to;
  if ("demo_at" in patch) update["demo_at"] = patch.demo_at;
  if (!Object.keys(update).length) return { ok: true };

  const { error } = await supabase.from("demo_leads").update(update).eq("id", leadId);
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function addNote(
  supabase: SupabaseClient,
  leadId: string,
  authorId: string,
  body: string,
): Promise<{ ok: boolean; error?: string }> {
  const text = body.trim().slice(0, 4000);
  if (!text) return { ok: false, error: "Write something first." };
  const { error } = await supabase
    .from("demo_lead_notes")
    .insert({ lead_id: leadId, author_id: authorId, body: text });
  return error ? { ok: false, error: error.message } : { ok: true };
}

/**
 * Links a lead to a workspace only on a server-verified identity match: the
 * signed-in user's own phone or email, never a claim sent by the browser.
 */
export async function linkLeadToVerifiedSignup(
  supabase: SupabaseClient,
  userId: string,
  organizationId: string,
): Promise<void> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("phone")
    .eq("id", userId)
    .maybeSingle();
  const phone = normalizePhone((profile as { phone?: string } | null)?.phone ?? "");
  if (!phone) return;
  await supabase
    .from("demo_leads")
    .update({ organization_id: organizationId, linked_user_id: userId })
    .eq("phone", phone)
    .is("organization_id", null);
}
