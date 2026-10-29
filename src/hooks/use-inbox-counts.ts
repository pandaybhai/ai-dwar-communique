import { useCallback, useEffect, useState } from "react";
import { aidwar } from "@/integrations/aidwar/client";

const CHANGED = "aidwar:inbox-changed";

/** Tell the sidebar the Inbox list moved (the Inbox calls this after a reload). */
export function inboxChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(CHANGED));
}

/**
 * Batch 39: the sidebar's Inbox counts — chats with unread messages and chats
 * waiting for a person (needs_human), the Inbox's own "Waiting for you" filter.
 * Two head-only counts (no rows); a failed read shows no badge.
 */
export function useInboxCounts(organizationId: string | null): { unread: number; waiting: number } {
  const [counts, setCounts] = useState({ unread: 0, waiting: 0 });

  const load = useCallback(async () => {
    if (!organizationId) return setCounts({ unread: 0, waiting: 0 });
    try {
      const [unread, waiting] = await Promise.all([
        aidwar
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .gt("unread_count", 0),
        aidwar
          .from("conversations")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", organizationId)
          .eq("needs_human", true),
      ]);
      setCounts({
        unread: unread.error ? 0 : (unread.count ?? 0),
        waiting: waiting.error ? 0 : (waiting.count ?? 0),
      });
    } catch {
      setCounts({ unread: 0, waiting: 0 });
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | null = null;
    // A burst of Inbox reloads (realtime) asks once.
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 800);
    };
    const every = setInterval(() => void load(), 60_000);
    window.addEventListener(CHANGED, soon);
    window.addEventListener("focus", soon);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(every);
      window.removeEventListener(CHANGED, soon);
      window.removeEventListener("focus", soon);
    };
  }, [load]);

  return counts;
}
