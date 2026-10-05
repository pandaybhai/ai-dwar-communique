import { useEffect, useState } from "react";
import { aidwar } from "@/integrations/aidwar/client";

/**
 * How many automations this workspace has (any state), or null while unknown
 * — not loaded yet, or the count couldn't be read. Only a known 0 hides the
 * Automations menu (see automationsNavHidden); the automations themselves keep
 * running exactly as before.
 */
export function useAutomationsCount(organizationId: string | null): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    setCount(null);
    if (!organizationId) return;
    void Promise.resolve(
      aidwar.from("automations").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    )
      .then(({ count: rows, error }) => {
        if (!cancelled) setCount(error ? null : (rows ?? null));
      })
      .catch(() => {
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);
  return count;
}
