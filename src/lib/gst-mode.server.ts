import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEMO_SUPPLIER_PAN,
  GSTIN_PATTERN,
  PAN_PATTERN,
  chargeFor,
  gstRegisteredFrom,
  gstSwitchBlock,
  isDemoGstin,
} from "@/lib/gst-mode";

/**
 * Batch 55: platform_settings.gst_registered, read fresh for every charge.
 * `null` means the read failed: a payment path refuses to start rather than
 * guess (charging GST while unregistered is the one thing that must not
 * happen, and under-charging a registered supplier is the other). A missing
 * row or a missing column (20261290 not applied) is a clean "not registered".
 */
export async function loadGstRegistered(supabase: SupabaseClient): Promise<boolean | null> {
  try {
    const { data, error } = await supabase
      .from("platform_settings")
      .select("*")
      .eq("id", true)
      .maybeSingle();
    if (error) {
      console.error("[gst-mode] platform settings read failed", error.message);
      return null;
    }
    return gstRegisteredFrom((data ?? null) as Record<string, unknown> | null);
  } catch (error) {
    console.error(
      "[gst-mode] platform settings read failed",
      String((error as Error)?.message ?? error),
    );
    return null;
  }
}

export const GST_MODE_UNREADABLE =
  "We couldn't start this payment just now. Please try again in a minute.";

/** The price of `base` under the platform's current GST mode, or an error to show. */
export async function priceNow(
  supabase: SupabaseClient,
  base: number,
): Promise<{ base: number; gst: number; total: number; registered: boolean } | { error: string }> {
  const registered = await loadGstRegistered(supabase);
  if (registered === null) return { error: GST_MODE_UNREADABLE };
  return { ...chargeFor(base, registered), registered };
}

export type GstSettings = {
  gst_registered: boolean;
  supplier_gstin: string | null;
  supplier_pan: string | null;
  /** The stored GSTIN/PAN were the pre-Batch-55 demo values (20261290 clears them). */
  demo_values: boolean;
  /** platform_settings.gst_registered exists (20261290 applied). */
  column_ready: boolean;
};

/** What Super Admin > Billing > GST shows. */
export async function loadGstSettings(
  supabase: SupabaseClient,
): Promise<GstSettings | { error: string }> {
  const { data, error } = await supabase
    .from("platform_settings")
    .select("*")
    .eq("id", true)
    .maybeSingle();
  if (error) return { error: "We couldn't read the platform billing settings." };
  const row = (data ?? {}) as Record<string, unknown>;
  const gstin = (row["supplier_gstin"] as string | null) ?? null;
  const pan = (row["supplier_pan"] as string | null) ?? null;
  return {
    gst_registered: gstRegisteredFrom(row),
    supplier_gstin: gstin,
    supplier_pan: pan,
    demo_values:
      isDemoGstin(gstin) ||
      String(pan ?? "")
        .trim()
        .toUpperCase() === DEMO_SUPPLIER_PAN,
    column_ready: Object.prototype.hasOwnProperty.call(row, "gst_registered"),
  };
}

/**
 * Saves the GST switch and the supplier GSTIN/PAN. Switching GST on is
 * refused while the GSTIN is empty, the demo one or malformed; the demo
 * values are never saved. The caller logs the change (before and after).
 */
export async function saveGstSettings(
  supabase: SupabaseClient,
  input: { gstRegistered: boolean; supplierGstin: string | null; supplierPan: string | null },
): Promise<{ before: GstSettings; after: GstSettings } | { error: string }> {
  const before = await loadGstSettings(supabase);
  if ("error" in before) return before;

  const gstin =
    String(input.supplierGstin ?? "")
      .trim()
      .toUpperCase() || null;
  const pan =
    String(input.supplierPan ?? "")
      .trim()
      .toUpperCase() || null;
  if (gstin && isDemoGstin(gstin)) return { error: "That is the demo GSTIN — it can't be saved." };
  if (gstin && !GSTIN_PATTERN.test(gstin)) {
    return {
      error: "That GSTIN doesn't look right — it should be 15 characters, like 36AAAAA0000A1Z5.",
    };
  }
  if (pan && pan === DEMO_SUPPLIER_PAN)
    return { error: "That is the demo PAN — it can't be saved." };
  if (pan && !PAN_PATTERN.test(pan)) {
    return { error: "That PAN doesn't look right — it should be 10 characters, like AAACM1234D." };
  }
  if (input.gstRegistered) {
    const block = gstSwitchBlock(gstin);
    if (block) return { error: block };
  }
  if (input.gstRegistered && !before.column_ready) {
    return { error: "The GST switch needs migration 20261290, which isn't applied yet." };
  }

  const patch: Record<string, unknown> = {
    supplier_gstin: gstin,
    supplier_pan: pan,
    updated_at: new Date().toISOString(),
  };
  if (before.column_ready) patch["gst_registered"] = input.gstRegistered;
  const { error } = await supabase.from("platform_settings").update(patch).eq("id", true);
  if (error) {
    return {
      error:
        error.code === "42703"
          ? "The GST switch needs migration 20261290, which isn't applied yet."
          : "The GST settings could not be saved.",
    };
  }
  const after = await loadGstSettings(supabase);
  if ("error" in after) return after;
  return { before, after };
}
