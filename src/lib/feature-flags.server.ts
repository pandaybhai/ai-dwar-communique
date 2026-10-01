import type { SupabaseClient } from "@supabase/supabase-js";

/** Flag state for one organization, resolved exactly like the client hook. */
export async function enabledFlags(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Set<string>> {
  const [{ data: flags }, { data: overrides }] = await Promise.all([
    supabase.from("feature_flags").select("key, default_enabled"),
    supabase
      .from("organization_feature_overrides")
      .select("flag_key, enabled")
      .eq("organization_id", organizationId),
  ]);
  const state = new Map<string, boolean>();
  for (const f of (flags ?? []) as Array<{ key: string; default_enabled: boolean }>) {
    state.set(f.key, f.default_enabled);
  }
  for (const o of (overrides ?? []) as Array<{ flag_key: string; enabled: boolean }>) {
    state.set(o.flag_key, o.enabled);
  }
  return new Set(Array.from(state.entries()).filter(([, on]) => on).map(([k]) => k));
}
