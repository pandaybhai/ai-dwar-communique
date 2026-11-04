import { useEffect, useState } from "react";
import { PhoneOff } from "lucide-react";
import { aidwar } from "@/integrations/aidwar/client";
import { unreachableLabel, unreachableOf, type Unreachable } from "@/lib/wa-reachability";

/**
 * Batch 63 (B): "Not on WhatsApp since 3 Nov" on a customer whose number
 * WhatsApp said can't receive messages (contacts.wa_unreachable). Read here
 * through the member's own client, on its own: before 20261350 adds the
 * column the read fails and nothing is shown — the screen around it never
 * changes. Shown in the contact drawer and in both Inboxes' chat headers.
 */

const cache = new Map<string, Unreachable | null>();

export function useUnreachable(contactId: string | null | undefined): Unreachable | null {
  const [mark, setMark] = useState<Unreachable | null>(
    contactId ? (cache.get(contactId) ?? null) : null,
  );
  useEffect(() => {
    let alive = true;
    if (!contactId) {
      setMark(null);
      return;
    }
    void aidwar
      .from("contacts")
      .select("wa_unreachable")
      .eq("id", contactId)
      .maybeSingle()
      .then(
        ({ data, error }) => {
          const next = error
            ? null
            : unreachableOf((data as { wa_unreachable?: unknown } | null)?.wa_unreachable);
          cache.set(contactId, next);
          if (alive) setMark(next);
        },
        () => undefined,
      );
    return () => {
      alive = false;
    };
  }, [contactId]);
  return mark;
}

export function UnreachableBadge({
  contactId,
  mark: given,
  className = "",
  compact = false,
}: {
  contactId?: string | null;
  /** Already read by the caller (skips the read). */
  mark?: Unreachable | null;
  className?: string;
  /** One short line ("Not on WhatsApp"); the date is in the tooltip. */
  compact?: boolean;
}) {
  const read = useUnreachable(given === undefined ? contactId : null);
  const mark = given === undefined ? read : given;
  if (!mark) return null;
  const title = `${unreachableLabel(mark)} — ${mark.reason}${mark.template ? ` — last tried with ${mark.template}` : ""}. Clears when a message is delivered.`;
  return (
    <span
      data-testid="not-on-whatsapp"
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300 ${className}`}
    >
      <PhoneOff className="h-3 w-3" aria-hidden="true" />
      {compact ? "Not on WhatsApp" : unreachableLabel(mark)}
    </span>
  );
}
