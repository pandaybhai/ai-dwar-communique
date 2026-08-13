import { useCallback, useEffect, useState } from "react";
import { aidwar } from "@/integrations/aidwar/client";

export type Organization = {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
};

export type Membership = { role: "owner" | "admin" | "agent"; organization: Organization };

export function useOrganization() {
  const [membership, setMembership] = useState<Membership | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await aidwar
      .from("organization_members")
      .select("role, organizations(id, name, slug, status, timezone)")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (err) {
      setError("We couldn't load your workspace. Please refresh.");
      setLoading(false);
      return;
    }
    const row = data as { role: Membership["role"]; organizations: Organization | null } | null;
    setMembership(row?.organizations ? { role: row.role, organization: row.organizations } : null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { membership, loading, error, reload: load };
}
