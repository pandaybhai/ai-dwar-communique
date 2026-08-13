import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { aidwar } from "@/integrations/aidwar/client";

export type OrgRole = "owner" | "admin" | "agent";

export type Organization = {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
};

export type Membership = { role: OrgRole; organization: Organization };

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
  canManage: boolean;
  isSuperAdmin: boolean;
  flagsLoading: boolean;
  isFeatureEnabled: (key: string) => boolean;
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

  const load = useCallback(async () => {
    setError(null);
    const { data: userData } = await aidwar.auth.getUser();
    const uid = userData.user?.id;
    if (!uid) {
      setLoading(false);
      return;
    }

    const [{ data: rows, error: memberErr }, { data: prof }] = await Promise.all([
      aidwar
        .from("organization_members")
        .select("role, organizations(id, name, slug, status, timezone)")
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

    const list: Membership[] = ((rows ?? []) as unknown as {
      role: OrgRole;
      organizations: Organization | Organization[] | null;
    }[])
      .map((r) => ({
        role: r.role,
        organization: (Array.isArray(r.organizations) ? r.organizations[0] : r.organizations) ?? null,
      }))
      .filter((m): m is Membership => m.organization !== null);

    setMemberships(list);
    setProfile((prof as Profile) ?? { id: uid, full_name: null, email: userData.user?.email ?? null });

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
        setFlagsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const setActiveOrg = useCallback((organizationId: string) => {
    setActiveId(organizationId);
    if (typeof window !== "undefined") window.localStorage.setItem(STORAGE_KEY, organizationId);
  }, []);

  const active = memberships.find((m) => m.organization.id === activeId) ?? null;

  const isFeatureEnabled = useCallback((key: string) => flags[key] ?? false, [flags]);

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
