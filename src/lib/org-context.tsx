import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { RELEASE_FLAG, type DesignName } from "@/lib/aiden-workspace";

export type OrgRole = "owner" | "admin" | "marketer" | "agent";

export type Organization = {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
  plan_status?: string | null;
  plan_version_id?: string | null;
  trial_ends_at?: string | null;
};

export type Membership = { role: OrgRole; organization: Organization };

/**
 * Batch 53: what the Aiden Workspace resolver needs beyond the flags, for
 * this member in the active workspace (GET /api/design). Loaded only while
 * the release flag's global default is on; null until then.
 */
export type DesignPrefs = {
  superAdminOverride: boolean | null;
  choice: DesignName | null;
  unlockedAt: string | null;
  introSeenAt: string | null;
};

export type Profile = {
  id: string;
  full_name: string | null;
  email: string | null;
  is_super_admin?: boolean | null;
};

type OrgContextValue = {
  loading: boolean;
  error: string | null;
  memberships: Membership[];
  active: Membership | null;
  profile: Profile | null;
  setActiveOrg: (organizationId: string) => void;
  reload: () => Promise<void>;
  /** @deprecated gate on a permission key via usePermissions() instead. */
  canManage: boolean;
  isSuperAdmin: boolean;
  flagsLoading: boolean;
  isFeatureEnabled: (key: string) => boolean;
  /** Batch 53: each flag's global default (feature_flags.default_enabled), no overrides. */
  flagDefaults: Record<string, boolean>;
  /** Batch 53: Aiden Workspace inputs; null while loading or while the release flag is off. */
  designPrefs: DesignPrefs | null;
  designPrefsLoading: boolean;
  /** Batch 53: remember this person's design (server-side) and record design.switched. */
  chooseDesign: (design: DesignName, from: DesignName, path: string | null) => Promise<void>;
  markIntroSeen: () => Promise<void>;
  permissions: string[];
  permissionOverrides: Record<string, boolean>;
  permissionsLoading: boolean;
  can: (key: string) => boolean;
  reloadPermissions: () => Promise<void>;
};

const OrgContext = createContext<OrgContextValue | null>(null);
const STORAGE_KEY = "aidwar.active_org";

export function OrgProvider({ children }: { children: ReactNode }) {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [flagsLoading, setFlagsLoading] = useState(true);
  const [flagDefaults, setFlagDefaults] = useState<Record<string, boolean>>({});
  const [designPrefs, setDesignPrefs] = useState<DesignPrefs | null>(null);
  const [designPrefsLoading, setDesignPrefsLoading] = useState(true);
  const [permissions, setPermissions] = useState<string[]>([]);
  const [permissionOverrides, setPermissionOverrides] = useState<Record<string, boolean>>({});
  const [permissionsLoading, setPermissionsLoading] = useState(true);

  const load = useCallback(async () => {
    setError(null);
    // Local session read — no network hop before the first query.
    const { data: userData } = await aidwar.auth.getSession();
    const uid = userData.session?.user?.id;
    if (!uid) {
      setLoading(false);
      return;
    }

    const [{ data: rows, error: memberErr }, { data: prof }] = await Promise.all([
      aidwar
        .from("organization_members")
        .select(
          "role, organizations(id, name, slug, status, timezone, plan_status, plan_version_id, trial_ends_at)",
        )
        .eq("user_id", uid)
        .order("created_at", { ascending: true }),
      aidwar
        .from("profiles")
        .select("id, full_name, email, is_super_admin")
        .eq("id", uid)
        .maybeSingle(),
    ]);

    if (memberErr) {
      setError("We couldn't load your workspaces. Please refresh.");
      setLoading(false);
      return;
    }

    const list: Membership[] = (
      (rows ?? []) as unknown as {
        role: OrgRole;
        organizations: Organization | Organization[] | null;
      }[]
    )
      .map((r) => ({
        role: r.role,
        organization:
          (Array.isArray(r.organizations) ? r.organizations[0] : r.organizations) ?? null,
      }))
      .filter((m): m is Membership => m.organization !== null);

    setMemberships(list);
    setProfile(
      (prof as Profile) ?? {
        id: uid,
        full_name: null,
        email: userData.session?.user?.email ?? null,
      },
    );

    const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
    const next = list.find((m) => m.organization.id === stored) ?? list[0] ?? null;
    setActiveId(next?.organization.id ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setFlagsLoading(true);
      const { data: defs } = await aidwar.from("feature_flags").select("key, default_enabled");
      const resolved: Record<string, boolean> = {};
      for (const f of (defs ?? []) as { key: string; default_enabled: boolean }[]) {
        resolved[f.key] = f.default_enabled;
      }
      const defaults = { ...resolved };
      if (activeId) {
        const { data: overrides } = await aidwar
          .from("organization_feature_overrides")
          .select("flag_key, enabled")
          .eq("organization_id", activeId);
        for (const o of (overrides ?? []) as { flag_key: string; enabled: boolean }[]) {
          resolved[o.flag_key] = o.enabled;
        }
      }
      if (!cancelled) {
        setFlags(resolved);
        setFlagDefaults(defaults);
        setFlagsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const loadPermissions = useCallback(async (orgId: string | null) => {
    if (!orgId) {
      setPermissions([]);
      setPermissionOverrides({});
      setPermissionsLoading(false);
      return;
    }
    setPermissionsLoading(true);
    const { data } = await callApi<{
      permissions: string[];
      overrides: Record<string, boolean>;
    }>(`/api/permissions?organization_id=${encodeURIComponent(orgId)}`, { method: "GET" });
    setPermissions(data?.permissions ?? []);
    setPermissionOverrides(data?.overrides ?? {});
    setPermissionsLoading(false);
  }, []);

  useEffect(() => {
    void loadPermissions(activeId);
  }, [activeId, loadPermissions]);

  // Batch 53: shipped dark. Nothing is fetched while the release flag's
  // global default is off (or its row doesn't exist): today's behaviour.
  const releaseOn = !flagsLoading && flagDefaults[RELEASE_FLAG] === true;
  useEffect(() => {
    let cancelled = false;
    if (!releaseOn || !activeId) {
      setDesignPrefs(null);
      setDesignPrefsLoading(!releaseOn ? flagsLoading : false);
      return;
    }
    setDesignPrefsLoading(true);
    (async () => {
      const { data } = await callApi<{
        super_admin_override: boolean | null;
        choice: DesignName | null;
        unlocked_at: string | null;
        intro_seen_at: string | null;
      }>(`/api/design?organization_id=${encodeURIComponent(activeId)}`, { method: "GET" });
      if (cancelled) return;
      setDesignPrefs({
        superAdminOverride: typeof data?.super_admin_override === "boolean" ? data.super_admin_override : null,
        choice: data?.choice === "classic" || data?.choice === "aiden_workspace" ? data.choice : null,
        unlockedAt: data?.unlocked_at ?? null,
        introSeenAt: data?.intro_seen_at ?? null,
      });
      setDesignPrefsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [releaseOn, activeId, flagsLoading]);

  const chooseDesign = useCallback(
    async (design: DesignName, from: DesignName, path: string | null) => {
      if (!activeId) return;
      // The new look shows at once; the server remembers it for every device.
      setDesignPrefs((p) => ({
        superAdminOverride: p?.superAdminOverride ?? null,
        unlockedAt: p?.unlockedAt ?? null,
        introSeenAt: p?.introSeenAt ?? null,
        choice: design,
      }));
      await callApi(`/api/design`, {
        method: "POST",
        body: { organization_id: activeId, action: "choose", design, from, path },
      });
    },
    [activeId],
  );

  const markIntroSeen = useCallback(async () => {
    if (!activeId) return;
    const now = new Date().toISOString();
    setDesignPrefs((p) => (p ? { ...p, introSeenAt: now } : p));
    await callApi(`/api/design`, { method: "POST", body: { organization_id: activeId, action: "intro_seen" } });
  }, [activeId]);

  const setActiveOrg = useCallback((organizationId: string) => {
    setActiveId(organizationId);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, organizationId);
  }, []);

  const active = memberships.find((m) => m.organization.id === activeId) ?? null;

  const isFeatureEnabled = useCallback((key: string) => flags[key] ?? false, [flags]);

  const can = useCallback((key: string) => permissions.includes(key), [permissions]);

  return (
    <OrgContext.Provider
      value={{
        loading,
        error,
        memberships,
        active,
        profile,
        setActiveOrg,
        reload: load,
        canManage: active?.role === "owner" || active?.role === "admin",
        isSuperAdmin: Boolean(profile?.is_super_admin),
        flagsLoading,
        isFeatureEnabled,
        flagDefaults,
        designPrefs,
        designPrefsLoading,
        chooseDesign,
        markIntroSeen,
        permissions,
        permissionOverrides,
        permissionsLoading,
        can,
        reloadPermissions: () => loadPermissions(activeId),
      }}
    >
      {children}
    </OrgContext.Provider>
  );
}

export function useOrg() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used inside OrgProvider");
  return ctx;
}
