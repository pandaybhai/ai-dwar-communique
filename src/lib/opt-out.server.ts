import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";

/**
 * Opt-out is checked again right before a template leaves, never only when a
 * list was built: a customer who opted out five minutes ago must not get the
 * next message. Opt-out is workspace-wide, never per number.
 */
export async function contactOptedOut(
  supabase: SupabaseClient,
  organizationId: string,
  who: { contactId?: string | null; phone?: string | null },
): Promise<{ optedOut: boolean; error: string | null }> {
  let query = supabase
    .from("contacts")
    .select("opt_in_status")
    .eq("organization_id", organizationId);
  if (who.contactId) {
    query = query.eq("id", who.contactId);
  } else {
    const phone = normalizePhone(who.phone ?? "");
    if (!phone) return { optedOut: false, error: null };
    query = query.eq("phone", phone);
  }
  const { data, error } = await query.limit(1).maybeSingle();
  if (error) return { optedOut: false, error: error.message };
  return {
    optedOut: isOptedOut((data as { opt_in_status?: string | null } | null)?.opt_in_status),
    error: null,
  };
}

export function isOptedOut(status: string | null | undefined): boolean {
  return String(status ?? "").toLowerCase() === "opted_out";
}

/**
 * The opt-in change an import may make to an existing contact. Consent on an
 * import can raise "unknown" to "opted_in" but never overrides an opt-out:
 * only the customer can take that back.
 */
export function importOptInPatch(
  existingStatus: string | null | undefined,
  consent: boolean,
): { opt_in_status?: "opted_in" } {
  if (!consent || isOptedOut(existingStatus)) return {};
  return { opt_in_status: "opted_in" };
}
