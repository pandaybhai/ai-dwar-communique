import type { SupabaseClient } from "@supabase/supabase-js";
import {
  apiPhoneNumber,
  needsDefaultCountry,
  parseCcNumbers,
  storedCcNumbers,
  MAX_CC,
} from "@/lib/public-api-cc";
import { loadDefaultCountryCode } from "@/lib/default-country";

/**
 * Batch 61: the workspace's default copy numbers for API template sends —
 * organizations.api_cc_numbers (20261330), set only from Settings → API &
 * webhooks through /api/developer/copies (public_api.manage = owner / admin,
 * audit-logged as api_cc_default_saved). A request's own `cc` (even an empty
 * array) overrides it.
 *
 * The code works without 20261330: the column missing (or any failed read)
 * reads as "no default", so API sends go exactly as before; saving says the
 * file isn't applied yet.
 */

/** The default copy numbers, without `to` (E.164). [] when none or unreadable. */
export async function loadApiCcDefault(
  supabase: SupabaseClient,
  organizationId: string,
  to: string | null = null,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("organizations")
    .select("api_cc_numbers")
    .eq("id", organizationId)
    .maybeSingle();
  if (error) {
    console.warn(
      JSON.stringify({
        scope: "public_api",
        step: "cc_default_read",
        organization_id: organizationId,
        error: error.message,
      }),
    );
    return [];
  }
  const stored = storedCcNumbers((data as { api_cc_numbers?: unknown } | null)?.api_cc_numbers);
  const parsed = parseCcNumbers(stored, { to });
  return parsed.ok ? parsed.numbers : [];
}

/** True when the error is "column api_cc_numbers doesn't exist" (20261330 not applied). */
export function ccColumnMissing(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "42703" ||
    error.code === "PGRST204" ||
    /api_cc_numbers/.test(String(error.message ?? ""))
  );
}

export type SaveCcResult =
  | { ok: true; numbers: string[]; previous: string[] }
  | { ok: false; status: number; error: string };

/** Checks and saves the default (at most MAX_CC numbers, duplicates removed). */
export async function saveApiCcDefault(
  supabase: SupabaseClient,
  organizationId: string,
  raw: unknown,
): Promise<SaveCcResult> {
  // Batch 66: a number typed here follows the one phone rule (a 10-digit
  // number gets the default country code); stored numbers are read as before.
  let defaultCode: string | null = null;
  if (Array.isArray(raw) && raw.some(needsDefaultCountry)) {
    const read = await loadDefaultCountryCode(supabase, organizationId);
    if ("error" in read) return { ok: false, status: 503, error: read.error };
    defaultCode = read.code;
  }
  const parsed = parseCcNumbers(raw, {
    field: "The copy list",
    label: (i) => `Number ${i + 1}`,
    number: (entry) => apiPhoneNumber(entry, defaultCode),
  });
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const { data: before, error: readError } = await supabase
    .from("organizations")
    .select("api_cc_numbers")
    .eq("id", organizationId)
    .maybeSingle();
  if (readError)
    return ccColumnMissing(readError)
      ? {
          ok: false,
          status: 503,
          error: "Copies aren't set up on this server yet (20261330 isn't applied).",
        }
      : { ok: false, status: 503, error: "We couldn't read the copy numbers. Please try again." };
  const { error } = await supabase
    .from("organizations")
    .update({ api_cc_numbers: parsed.numbers })
    .eq("id", organizationId);
  if (error)
    return {
      ok: false,
      status: 503,
      error: "We couldn't save the copy numbers. Please try again.",
    };
  return {
    ok: true,
    numbers: parsed.numbers,
    previous: storedCcNumbers((before as { api_cc_numbers?: unknown } | null)?.api_cc_numbers),
  };
}

export { MAX_CC };
