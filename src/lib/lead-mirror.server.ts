import type { SupabaseClient } from "@supabase/supabase-js";
import { leadAnswers, leadSettled } from "@/lib/lead-alerts.server";
import { normalizePhone, toWaId } from "@/lib/phone";

/**
 * Batch 76: every /start and /demo lead is mirrored into AiDwar's own
 * workspace — the one that owns the platform WhatsApp number
 * (platform_settings.onboarding_whatsapp_account_id → whatsapp_accounts
 * .organization_id; never a hard-coded id) — so the sales team works leads
 * in the normal workspace: Contacts filtered by the tag "AiDwar lead", the
 * Inbox for anyone who messaged Aiden.
 *
 *  - One contact per number: the same key the inbox uses (organization_id +
 *    phone, normalised by normalizePhone exactly as the webhook stores it),
 *    so someone who already messaged Aiden is updated, never duplicated. A new
 *    contact is created only when there is none (insert … on conflict do
 *    nothing), with source "website".
 *  - Tag "AiDwar lead" (created when missing) and attributes lead_source,
 *    sells, customers, lead_status, signed_up, lead_created_at — merged into
 *    the contact's own attributes, refreshed when the lead is answered, signs
 *    up or changes status.
 *  - opt_in_status is never written: the /start consent line isn't marketing
 *    opt-in, so the contact keeps whatever it already had ("unknown" when new).
 *  - One contact note "Lead from /start: sells X, customers Y", written once
 *    per lead when its answers are in (or after the 3-minute wait):
 *    demo_leads.mirrored_at is claimed first, so it never repeats.
 *  - Sends nothing — no WhatsApp message, no template, no event.
 *
 * Never throws: a lead is saved whatever happens here, and the minute worker
 * (catchUpLeadMirror) and the Super Admin backfill pick up anything missed.
 */

export const LEAD_TAG = "AiDwar lead";
const MIRROR_SOURCES = ["landing_start", "landing"] as const;

type MirrorLead = {
  id: string;
  phone: string;
  name: string | null;
  source: string;
  status: string | null;
  created_at: string;
  business_type: string | null;
  qualification: { sells?: string; customers?: string; answered_at?: string } | null;
  linked_user_id: string | null;
  organization_id: string | null;
  is_test: boolean | null;
  mirrored_at: string | null;
};

const LEAD_COLUMNS =
  "id, phone, name, source, status, created_at, business_type, qualification, linked_user_id, organization_id, is_test, mirrored_at";

export type MirrorOutcome =
  | { ok: true; contactId: string; created: boolean; noted: boolean }
  | { ok: false; skipped: string };

/** The workspace that owns AiDwar's own WhatsApp number, or null. */
export async function leadMirrorOrg(supabase: SupabaseClient): Promise<string | null> {
  const { data: settings } = await supabase
    .from("platform_settings")
    .select("onboarding_whatsapp_account_id")
    .maybeSingle();
  const accountId = (settings as { onboarding_whatsapp_account_id?: string | null } | null)
    ?.onboarding_whatsapp_account_id;
  if (!accountId) return null;
  const { data: account } = await supabase
    .from("whatsapp_accounts")
    .select("organization_id")
    .eq("id", accountId)
    .maybeSingle();
  return (account as { organization_id?: string | null } | null)?.organization_id ?? null;
}

/** The lead's attributes on the contact. Unanswered questions are left out. */
export function leadAttributes(lead: MirrorLead): Record<string, string | boolean> {
  const a = leadAnswers(lead);
  return {
    lead_source: a.source,
    ...(a.sells ? { sells: a.sells } : {}),
    ...(a.customers ? { customers: a.customers } : {}),
    lead_status: lead.status ?? "new",
    signed_up: Boolean(lead.linked_user_id || lead.organization_id),
    lead_created_at: lead.created_at,
  };
}

export function leadNoteText(lead: MirrorLead): string {
  const a = leadAnswers(lead);
  return `Lead from ${a.source}: sells ${a.sells ?? "—"}, customers ${a.customers ?? "—"}`;
}

async function tagId(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const read = async () => {
    const { data } = await supabase
      .from("tags")
      .select("id")
      .eq("organization_id", orgId)
      .eq("name", LEAD_TAG)
      .maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
  };
  const found = await read();
  if (found) return found;
  await supabase
    .from("tags")
    .upsert(
      { organization_id: orgId, name: LEAD_TAG },
      { onConflict: "organization_id,name", ignoreDuplicates: true },
    );
  return read();
}

type ContactRow = {
  id: string;
  name: string | null;
  attributes: Record<string, unknown> | null;
};

async function readContact(
  supabase: SupabaseClient,
  orgId: string,
  phone: string,
): Promise<ContactRow | null> {
  const { data } = await supabase
    .from("contacts")
    .select("id, name, attributes")
    .eq("organization_id", orgId)
    .eq("phone", phone)
    .maybeSingle();
  return (data as ContactRow | null) ?? null;
}

/**
 * Mirrors one lead (by id, or the row already read). Safe to call any number
 * of times: the contact, tag link and attributes converge, the note is once.
 */
export async function mirrorLead(
  supabase: SupabaseClient,
  leadOrId: string | MirrorLead,
  opts: { now?: number; orgId?: string | null } = {},
): Promise<MirrorOutcome> {
  try {
    const now = opts.now ?? Date.now();
    let lead: MirrorLead | null;
    if (typeof leadOrId === "string") {
      const { data } = await supabase
        .from("demo_leads")
        .select(LEAD_COLUMNS)
        .eq("id", leadOrId)
        .maybeSingle();
      lead = (data as MirrorLead | null) ?? null;
    } else lead = leadOrId;
    if (!lead) return { ok: false, skipped: "no_lead" };
    if (lead.is_test) return { ok: false, skipped: "test_lead" };
    if (!(MIRROR_SOURCES as readonly string[]).includes(lead.source)) {
      return { ok: false, skipped: "not_a_website_lead" };
    }
    const phone = normalizePhone(lead.phone);
    if (!phone) return { ok: false, skipped: "no_phone" };
    const orgId = opts.orgId !== undefined ? opts.orgId : await leadMirrorOrg(supabase);
    if (!orgId) return { ok: false, skipped: "no_platform_org" };

    const attributes = leadAttributes(lead);
    const stamp = new Date(now).toISOString();
    let contact = await readContact(supabase, orgId, phone);
    let created = false;
    if (!contact) {
      // opt_in_status is left to the column's default ("unknown").
      const { data } = await supabase
        .from("contacts")
        .upsert(
          {
            organization_id: orgId,
            phone,
            wa_id: toWaId(phone),
            name: (lead.name ?? "").trim() || null,
            attributes,
            source: "website",
            source_detail: { form: attributes["lead_source"], lead_id: lead.id },
          },
          { onConflict: "organization_id,phone", ignoreDuplicates: true },
        )
        .select("id, name, attributes");
      const row = ((data ?? []) as ContactRow[])[0];
      if (row) {
        contact = row;
        created = true;
      } else contact = await readContact(supabase, orgId, phone); // created meanwhile
    }
    if (!contact) return { ok: false, skipped: "contact_write_failed" };

    if (!created) {
      const merged = { ...(contact.attributes ?? {}), ...attributes };
      const name = contact.name || (lead.name ?? "").trim() || null;
      if (
        JSON.stringify(merged) !== JSON.stringify(contact.attributes ?? {}) ||
        name !== contact.name
      ) {
        await supabase
          .from("contacts")
          .update({ attributes: merged, name, updated_at: stamp })
          .eq("id", contact.id)
          .eq("organization_id", orgId);
      }
    }

    const tag = await tagId(supabase, orgId);
    if (tag) {
      await supabase
        .from("contact_tags")
        .upsert(
          { contact_id: contact.id, tag_id: tag, organization_id: orgId },
          { onConflict: "contact_id,tag_id", ignoreDuplicates: true },
        );
    }

    // The note, once per lead, when the answers are in (or we stopped waiting).
    let noted = false;
    if (!lead.mirrored_at && leadSettled(lead, now)) {
      const { data: claimed } = await supabase
        .from("demo_leads")
        .update({ mirrored_at: stamp })
        .eq("id", lead.id)
        .is("mirrored_at", null)
        .select("id");
      if (claimed && (claimed as unknown[]).length > 0) {
        const { error } = await supabase.from("contact_notes").insert({
          organization_id: orgId,
          contact_id: contact.id,
          author_id: null,
          body: leadNoteText(lead),
        });
        noted = !error;
        if (error) log({ stage: "note_failed", lead: lead.id, error: error.message });
      }
    }
    return { ok: true, contactId: contact.id, created, noted };
  } catch (error) {
    const id = typeof leadOrId === "string" ? leadOrId : leadOrId.id;
    log({
      stage: "failed",
      lead: id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, skipped: "error" };
  }
}

/**
 * The minute worker's safety net: today's leads whose note isn't written yet
 * (mirrored_at null) and whose answers are in or whose wait is over.
 */
export async function catchUpLeadMirror(
  supabase: SupabaseClient,
  opts: { now?: number; limit?: number } = {},
): Promise<{ mirrored: number; skipped: string | null }> {
  const now = opts.now ?? Date.now();
  const { data } = await supabase
    .from("demo_leads")
    .select(LEAD_COLUMNS)
    .in("source", [...MIRROR_SOURCES])
    .eq("is_test", false)
    .is("mirrored_at", null)
    .gte("created_at", new Date(now - 24 * 60 * 60 * 1000).toISOString())
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 20);
  const leads = ((data ?? []) as MirrorLead[]).filter((l) => leadSettled(l, now));
  if (!leads.length) return { mirrored: 0, skipped: null };
  const orgId = await leadMirrorOrg(supabase);
  if (!orgId) {
    log({ stage: "skipped", reason: "no_platform_org" });
    return { mirrored: 0, skipped: "no_platform_org" };
  }
  let mirrored = 0;
  for (const lead of leads) {
    const out = await mirrorLead(supabase, lead, { now, orgId });
    if (out.ok) mirrored += 1;
  }
  return { mirrored, skipped: null };
}

/**
 * Super Admin's one-off backfill: mirrors existing leads, oldest first, a
 * bounded batch per call (re-run until remaining is 0). Idempotent — already
 * mirrored leads are skipped; running it again never adds a contact, tag
 * link or note twice.
 */
export async function backfillLeadMirror(
  supabase: SupabaseClient,
  opts: { now?: number; batch?: number } = {},
): Promise<
  { ok: true; mirrored: number; failed: number; remaining: number } | { ok: false; error: string }
> {
  const now = opts.now ?? Date.now();
  const orgId = await leadMirrorOrg(supabase);
  if (!orgId) return { ok: false, error: "AiDwar's own WhatsApp number isn't set up." };
  const pending = () =>
    supabase
      .from("demo_leads")
      .select(LEAD_COLUMNS)
      .in("source", [...MIRROR_SOURCES])
      .eq("is_test", false)
      .is("mirrored_at", null);
  const { data } = await pending()
    .order("created_at", { ascending: true })
    .limit(opts.batch ?? 100);
  // Old leads are past their wait, so each gets its note now.
  const leads = (data ?? []) as MirrorLead[];
  let mirrored = 0;
  let failed = 0;
  for (const lead of leads) {
    const out = await mirrorLead(supabase, lead, { now, orgId });
    if (out.ok && (out.noted || lead.mirrored_at)) mirrored += 1;
    else failed += 1;
  }
  const { count } = await supabase
    .from("demo_leads")
    .select("id", { count: "exact", head: true })
    .in("source", [...MIRROR_SOURCES])
    .eq("is_test", false)
    .is("mirrored_at", null);
  return { ok: true, mirrored, failed, remaining: count ?? 0 };
}

function log(detail: Record<string, unknown>): void {
  console.log(JSON.stringify({ scope: "lead_mirror", ...detail }));
}
