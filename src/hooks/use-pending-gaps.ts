import { useCallback, useEffect, useState } from "react";
import { aidwar } from "@/integrations/aidwar/client";

const CHANGED = "aidwar:gaps-changed";

/** Tell every listener the waiting-questions list moved. */
export function gapsChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGED));
}

/** How many customer questions are still waiting on an answer in this workspace. */
export function usePendingGapCount(organizationId: string | null): number {
  const [count, setCount] = useState(0);

  const load = useCallback(async () => {
    if (!organizationId) {
      setCount(0);
      return;
    }
    const { count: rows } = await aidwar
      .from("pending_owner_replies")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("status", "pending");
    setCount(rows ?? 0);
  }, [organizationId]);

  useEffect(() => {
    void load();
    const handler = () => void load();
    window.addEventListener(CHANGED, handler);
    return () => window.removeEventListener(CHANGED, handler);
  }, [load]);

  return count;
}
