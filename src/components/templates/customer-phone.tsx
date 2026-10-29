import type { ReactNode } from "react";
import { PhoneFrame } from "@/components/developers/whatsapp-phone";
import { cn } from "@/lib/utils";

/**
 * Batch 41: the developer portal's phone (Batch 38) for a message being
 * composed in the app — the campaign wizard and the template editor. The
 * phone takes the app's own WhatsApp colours, so it follows light and dark
 * with the rest of the screen instead of the portal's fixed light palette.
 * (The portal's .wa-phone rule is unlayered CSS, so these need `!` to win.)
 */
export function CustomerPhone({
  business,
  children,
  className,
}: {
  business: string;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <div
      className={cn(
        "[--app-wa-in:var(--wa-in)] [--app-wa-link:var(--wa-link)] [--app-wa-meta:var(--wa-meta)] [--app-wa-text:var(--wa-text)] [--app-wa-wall:var(--wa-wall)]",
        "[&_.wa-phone]:[--wa-bubble:var(--app-wa-in)]! [&_.wa-phone]:[--wa-link:var(--app-wa-link)]! [&_.wa-phone]:[--wa-meta:var(--app-wa-meta)]! [&_.wa-phone]:[--wa-text:var(--app-wa-text)]! [&_.wa-phone]:[--wa-wall:var(--app-wa-wall)]!",
        className,
      )}
    >
      <PhoneFrame business={business} compact label="The message on the customer's WhatsApp">
        <div className="msg-arrive">{children}</div>
      </PhoneFrame>
    </div>
  );
}
