import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-side mirror of public.has_permission, resolved in exactly the same
 * order: super admin -> owner -> member override -> role preset.
 *
 * The service client bypasses RLS, so resolution here must reproduce the
 * database logic rather than lean on it.
 */
export type EffectivePermissions = {
  role: string | null;
  isSuperAdmin: boolean;
  keys: string[];
  overrides: Record<string, boolean>;
};

export async function resolveEffectivePermissions(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<EffectivePermissions> {
  const [{ data: profile }, { data: membership }, { data: allPerms }] = await Promise.all([
    supabase.from("profiles").select("is_super_admin").eq("id", userId).maybeSingle(),
    supabase
      .from("organization_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .maybeSingle(),
    supabase.from("permissions").select("key"),
  ]);

  const everyKey = ((allPerms ?? []) as { key: string }[]).map((p) => p.key);
  const isSuperAdmin = (profile as { is_super_admin?: boolean } | null)?.is_super_admin === true;
  const role = (membership as { role?: string } | null)?.role ?? null;

  if (isSuperAdmin) {
    return { role, isSuperAdmin: true, keys: everyKey, overrides: {} };
  }
  if (!role) {
    return { role: null, isSuperAdmin: false, keys: [], overrides: {} };
  }

  const { data: overrideRows } = await supabase
    .from("member_permissions")
    .select("permission_key, granted")
    .eq("organization_id", organizationId)
    .eq("user_id", userId);

  const overrides: Record<string, boolean> = {};
  for (const row of (overrideRows ?? []) as { permission_key: string; granted: boolean }[]) {
    overrides[row.permission_key] = row.granted;
  }

  // Owners always hold everything; overrides can never lock them out.
  if (role === "owner") {
    return { role, isSuperAdmin: false, keys: everyKey, overrides };
  }

  const { data: presetRows } = await supabase
    .from("role_permissions")
    .select("permission_key")
    .eq("role", role);

  const preset = new Set(
    ((presetRows ?? []) as { permission_key: string }[]).map((r) => r.permission_key),
  );

  const keys = everyKey.filter((key) =>
    key in overrides ? overrides[key] === true : preset.has(key),
  );

  return { role, isSuperAdmin: false, keys, overrides };
}

export async function hasPermission(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
  permission: string,
): Promise<boolean> {
  const resolved = await resolveEffectivePermissions(supabase, organizationId, userId);
  return resolved.keys.includes(permission);
}
