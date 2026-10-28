import type { SupabaseClient } from "@supabase/supabase-js";
import { isOptedOut } from "@/lib/opt-out.server";
import { logServerActivity } from "@/lib/whatsapp-api.server";

/**
 * Batch 36: who/when/how a contact came to be opted in. The import, "Add
 * contact", the contact drawer and the Contacts list's bulk actions all write
 * it through here; an opt-out is never changed by any of them (only the
 * customer can take a STOP back, with START or another opt-in keyword).
 *
 * contacts.opt_in_source / contacts.opted_in_at come from
 * 20261140_batch36_opt_in_default.sql. Until that file is applied, every write
 * here retries without the two columns (PostgREST answers PGRST204), so the
 * status still changes exactly as asked and the activity log keeps the record.
 */
/** "api": the Public API's contacts calls (Batch 37, public-api-contacts.server.ts). */
export type OptInSource = "import" | "manual" | "bulk" | "keyword" | "api";

export const CONSENT_COLUMNS = ["opt_in_source", "opted_in_at"] as const;

export function optInConsent(source: OptInSource, at: Date = new Date()) {
  return { opt_in_source: source, opted_in_at: at.toISOString() };
}

type DbError = { code?: string; message?: string } | null | undefined;

/** The database doesn't have the consent columns yet (migration not applied). */
export function isMissingConsentColumn(error: DbError): boolean {
  if (!error) return false;
  const text = `${error.code ?? ""} ${error.message ?? ""}`;
  return (
    CONSENT_COLUMNS.some((c) => text.includes(c)) &&
    (error.code === "PGRST204" || error.code === "42703" || /column/i.test(text))
  );
}

export function withoutConsentColumns<T extends Record<string, unknown>>(patch: T): T {
  const copy: Record<string, unknown> = { ...patch };
  for (const c of CONSENT_COLUMNS) delete copy[c];
  return copy as T;
}

/**
 * Runs a contacts write with the consent columns, and once more without them
 * when the database doesn't know them yet.
 */
export async function writeWithConsent<
  T extends Record<string, unknown>,
  R extends { error: DbError },
>(patch: T, run: (patch: T) => PromiseLike<R>): Promise<R> {
  const first = await run(patch);
  if (!isMissingConsentColumn(first.error)) return first;
  return run(withoutConsentColumns(patch));
}

export type OptInResult = {
  /** Contacts switched to opted in by this call. */
  changed: number;
  /** Contacts left as they were because the customer opted out. */
  skipped_opted_out: number;
  /** Contacts that were opted in already. */
  already_opted_in: number;
};

const ID_CHUNK = 500;

/**
 * Switches contacts to opted in — the given ids, or every "unknown" contact of
 * the workspace (`"all_unknown"`). Opted-out contacts are never touched, and
 * the update itself only matches rows still "unknown", so a STOP that lands
 * meanwhile wins. One activity log entry records who did it and how.
 */
export async function markContactsOptedIn(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    userId: string | null;
    source: OptInSource;
    contactIds: string[] | "all_unknown";
    at?: Date | undefined;
  },
): Promise<{ result: OptInResult; error: string | null }> {
  const at = args.at ?? new Date();
  const patch = { opt_in_status: "opted_in", ...optInConsent(args.source, at) };
  const result: OptInResult = { changed: 0, skipped_opted_out: 0, already_opted_in: 0 };

  if (args.contactIds === "all_unknown") {
    const { error, count } = await writeWithConsent(patch, (p) =>
      supabase
        .from("contacts")
        .update(p, { count: "exact" })
        .eq("organization_id", args.organizationId)
        .eq("opt_in_status", "unknown"),
    );
    if (error) return { result, error: error.message ?? "update failed" };
    result.changed = count ?? 0;
  } else {
    const ids = Array.from(new Set(args.contactIds.filter(Boolean)));
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const { data, error: readErr } = await supabase
        .from("contacts")
        .select("id, opt_in_status")
        .eq("organization_id", args.organizationId)
        .in("id", chunk);
      if (readErr) return { result, error: readErr.message };
      const rows = (data ?? []) as { id: string; opt_in_status: string | null }[];
      const toChange: string[] = [];
      for (const row of rows) {
        if (isOptedOut(row.opt_in_status)) result.skipped_opted_out += 1;
        else if (row.opt_in_status === "opted_in") result.already_opted_in += 1;
        else toChange.push(row.id);
      }
      if (!toChange.length) continue;
      const { error, count } = await writeWithConsent(patch, (p) =>
        supabase
          .from("contacts")
          .update(p, { count: "exact" })
          .eq("organization_id", args.organizationId)
          .in("id", toChange)
          .eq("opt_in_status", "unknown"),
      );
      if (error) return { result, error: error.message ?? "update failed" };
      const changed = count ?? toChange.length;
      result.changed += changed;
      // A row that stopped being "unknown" between the read and the write was
      // an opt-out arriving meanwhile (or another opt-in): either way, not ours.
      result.skipped_opted_out += toChange.length - changed;
    }
  }

  await logServerActivity(supabase, args.organizationId, args.userId, "contacts_opted_in", {
    source: args.source,
    scope: args.contactIds === "all_unknown" ? "all_unknown" : "selected",
    contact_ids: args.contactIds === "all_unknown" ? undefined : args.contactIds.slice(0, 500),
    at: at.toISOString(),
    ...result,
  });
  return { result, error: null };
}

export type MerchantOptInStatus = "opted_in" | "unknown" | "opted_out";

/**
 * The contact drawer's opt-in switch. The merchant may move a contact between
 * unknown and opted in, or record an opt-out; an opted-out contact never
 * changes here (only the customer's own START does that).
 */
export async function setContactOptIn(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    userId: string | null;
    contactId: string;
    status: MerchantOptInStatus;
    at?: Date | undefined;
  },
): Promise<{ status: string | null; changed: boolean; error: string | null }> {
  const { data, error: readErr } = await supabase
    .from("contacts")
    .select("id, opt_in_status")
    .eq("organization_id", args.organizationId)
    .eq("id", args.contactId)
    .maybeSingle();
  if (readErr) return { status: null, changed: false, error: readErr.message };
  if (!data) return { status: null, changed: false, error: "Contact not found." };
  const current = (data as { opt_in_status: string | null }).opt_in_status ?? "unknown";

  if (isOptedOut(current)) {
    if (args.status === "opted_out") return { status: current, changed: false, error: null };
    return {
      status: current,
      changed: false,
      error: "This customer opted out. Only they can opt back in, by replying START.",
    };
  }
  if (current === args.status) return { status: current, changed: false, error: null };

  if (args.status === "opted_in") {
    const { result, error } = await markContactsOptedIn(supabase, {
      organizationId: args.organizationId,
      userId: args.userId,
      source: "manual",
      contactIds: [args.contactId],
      at: args.at,
    });
    if (error) return { status: current, changed: false, error };
    return {
      status: result.changed ? "opted_in" : current,
      changed: result.changed > 0,
      error: null,
    };
  }

  // Back to unknown, or an opt-out the merchant records for the customer. The
  // consent record no longer applies; the activity log keeps the history.
  const patch = { opt_in_status: args.status, opt_in_source: null, opted_in_at: null };
  const { error } = await writeWithConsent(patch, (p) =>
    supabase
      .from("contacts")
      .update(p)
      .eq("organization_id", args.organizationId)
      .eq("id", args.contactId)
      .eq("opt_in_status", current),
  );
  if (error) return { status: current, changed: false, error: error.message ?? "update failed" };
  await logServerActivity(supabase, args.organizationId, args.userId, "optin_changed", {
    contact_id: args.contactId,
    from: current,
    to: args.status,
    source: "manual",
  });
  return { status: args.status, changed: true, error: null };
}
