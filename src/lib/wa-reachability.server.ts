import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isUnreachableCode,
  nextUnreachable,
  parseErrorDetail,
  unreachableOf,
  warnsNow,
  type Unreachable,
} from "@/lib/wa-reachability";

/**
 * Batch 63 (B): keeps contacts.wa_unreachable in step with Meta's statuses.
 * Called from the status webhook through `later()` (never on the reply
 * path, never retried with the event): a failed bookkeeping write is logged
 * and changes nothing about the message, its price or its campaign.
 *
 * Until 20261350_batch63.sql adds the column every call is a no-op (the
 * first 42703 / PGRST204 switches it off for ten minutes in this server).
 */

let columnMissingUntil = 0;

function columnMissing(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /wa_unreachable/.test(String(error.message ?? ""))
  );
}

function giveUp(error: { code?: string | null; message?: string | null }): void {
  if (columnMissing(error)) columnMissingUntil = Date.now() + 10 * 60_000;
  else
    console.warn(
      JSON.stringify({ scope: "wa_reachability", error: error.message ?? String(error) }),
    );
}

/** Test hook: forget a "column missing" seen earlier. */
export function resetReachabilityCache(): void {
  columnMissingUntil = 0;
}

async function contactOf(
  supabase: SupabaseClient,
  args: { contactId?: string | null; conversationId?: string | null },
): Promise<string | null> {
  if (args.contactId) return args.contactId;
  if (!args.conversationId) return null;
  const { data } = await supabase
    .from("conversations")
    .select("contact_id")
    .eq("id", args.conversationId)
    .maybeSingle();
  return ((data as { contact_id?: string | null } | null)?.contact_id ?? null) || null;
}

export type StatusForReachability = {
  organizationId: string;
  messageId: string;
  contactId?: string | null;
  conversationId?: string | null;
  /** messages.type — only a template's failure marks the number. */
  type?: string | null;
  templateName?: string | null;
  status: string;
  /** Meta's errors for a failed status (or messages.error_detail). */
  errors?: unknown;
  at: string;
};

/**
 * failed + "can't receive" code on a template → mark (first date kept, count
 * up); delivered / read of any message → clear. Anything else: nothing.
 * Returns what it did (for tests and logs).
 */
export async function noteSendStatus(
  supabase: SupabaseClient,
  s: StatusForReachability,
): Promise<"marked" | "cleared" | "none"> {
  if (Date.now() < columnMissingUntil) return "none";
  try {
    if (s.status === "failed") {
      if (s.type !== "template") return "none";
      const e = parseErrorDetail(s.errors);
      if (!isUnreachableCode(e.code)) return "none";
      const contactId = await contactOf(supabase, s);
      if (!contactId) return "none";
      const { data, error } = await supabase
        .from("contacts")
        .select("wa_unreachable")
        .eq("id", contactId)
        .eq("organization_id", s.organizationId)
        .maybeSingle();
      if (error) {
        giveUp(error);
        return "none";
      }
      const current = unreachableOf((data as { wa_unreachable?: unknown } | null)?.wa_unreachable);
      // The same failure again (Meta retried the event) counts once.
      if (current && current.message_id === s.messageId) return "none";
      const next = nextUnreachable(current, {
        at: s.at,
        code: e.code!,
        detail: s.errors,
        template: s.templateName ?? null,
        messageId: s.messageId,
      });
      const { error: writeError } = await supabase
        .from("contacts")
        .update({ wa_unreachable: next })
        .eq("id", contactId)
        .eq("organization_id", s.organizationId);
      if (writeError) {
        giveUp(writeError);
        return "none";
      }
      return "marked";
    }
    if (s.status === "delivered" || s.status === "read") {
      const contactId = await contactOf(supabase, s);
      if (!contactId) return "none";
      // One conditional update: a contact that isn't marked matches no row.
      const { data, error } = await supabase
        .from("contacts")
        .update({ wa_unreachable: null })
        .eq("id", contactId)
        .eq("organization_id", s.organizationId)
        .not("wa_unreachable", "is", null)
        .select("id");
      if (error) {
        giveUp(error);
        return "none";
      }
      return (data as unknown[] | null)?.length ? "cleared" : "none";
    }
    return "none";
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "wa_reachability",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return "none";
  }
}

/** The mark on a workspace's contact by phone, or null (any failure = null). */
export async function unreachableByPhone(
  supabase: SupabaseClient,
  organizationId: string,
  phone: string,
): Promise<Unreachable | null> {
  if (Date.now() < columnMissingUntil) return null;
  try {
    const { data, error } = await supabase
      .from("contacts")
      .select("wa_unreachable")
      .eq("organization_id", organizationId)
      .eq("phone", phone)
      .maybeSingle();
    if (error) {
      giveUp(error);
      return null;
    }
    return unreachableOf((data as { wa_unreachable?: unknown } | null)?.wa_unreachable);
  } catch {
    return null;
  }
}

/** For the API's 202: the warning, when the number was marked recently. */
export async function apiUnreachableWarning(
  supabase: SupabaseClient,
  organizationId: string,
  phone: string,
): Promise<string | null> {
  const { UNREACHABLE_WARNING } = await import("@/lib/wa-reachability");
  return warnsNow(await unreachableByPhone(supabase, organizationId, phone))
    ? UNREACHABLE_WARNING
    : null;
}
