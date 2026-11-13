import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Batch 78: the business name the person typed on /start, to prefill the
 * post-sign-up business step (the workspace name; still editable). Only a
 * /start lead already linked to this account (demo_leads.linked_user_id,
 * set by /api/public/start-link when the sign-up's own number is the
 * lead's) is read — never another person's lead, never by phone alone.
 * Nothing to prefill (or a failed read) is null: the step starts empty
 * exactly as before.
 */
export async function leadBusinessNameFor(
  supabase: SupabaseClient,
  userId: string,
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("demo_leads")
      .select("business_name, created_at")
      .eq("linked_user_id", userId)
      .eq("source", "landing_start")
      .order("created_at", { ascending: false })
      .limit(5);
    if (error || !Array.isArray(data)) return null;
    for (const row of data as Array<{ business_name?: unknown }>) {
      const name = typeof row.business_name === "string" ? row.business_name.trim() : "";
      if (name.length >= 2) return name.slice(0, 80);
    }
    return null;
  } catch {
    return null;
  }
}
