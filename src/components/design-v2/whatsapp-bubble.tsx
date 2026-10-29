import type { ReactNode } from "react";
import { Check, CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export type BubbleTicks = "sent" | "delivered" | "read";

/**
 * A WhatsApp message as the preview draws it (Batch 44): the customer's on
 * white (left), the business's / Aiden's in mint (right) with a sender label,
 * and a system note in gold (centre) for what Aiden or the team did.
 */
export function WhatsAppBubble({
  from,
  sender,
  time,
  ticks,
  meta,
  children,
  className,
}: {
  from: "in" | "out" | "system";
  sender?: string;
  time?: string;
  ticks?: BubbleTicks;
  /** Batch 46: more on the time line, before the time (a "Sent via API" tag, a sending clock). */
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  if (from === "system") {
    return (
      <p
        className={cn(
          "m-0 max-w-[90%] self-center rounded-[10px] bg-gold-bg px-3 py-[7px] text-center text-sm font-semibold text-gold-ink",
          className,
        )}
      >
        {children}
      </p>
    );
  }
  const out = from === "out";
  return (
    <div
      className={cn(
        "max-w-[85%] rounded-[14px] px-3 pb-1.5 pt-[9px] text-body text-foreground shadow-xs wide:max-w-[70%]",
        out ? "self-end rounded-tr-[4px] bg-bubble-out" : "self-start rounded-tl-[4px] bg-surface",
        className,
      )}
    >
      {sender ? (
        <span className="block text-[0.78rem] font-bold text-aiden-deep">{sender}</span>
      ) : null}
      {children}
      {time || ticks || meta ? (
        <span className="mt-0.5 flex items-center justify-end gap-1 text-[0.72rem] text-muted-foreground">
          {meta}
          {time}
          {ticks ? <Ticks ticks={ticks} /> : null}
        </span>
      ) : null}
    </div>
  );
}

function Ticks({ ticks }: { ticks: BubbleTicks }) {
  const label = ticks === "read" ? "Read" : ticks === "delivered" ? "Delivered" : "Sent";
  const Icon = ticks === "sent" ? Check : CheckCheck;
  return (
    <span
      className={cn("inline-flex", ticks === "read" ? "text-aiden-deep" : "text-muted-foreground")}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** A product sent in a chat: picture, name, price line. */
export function ProductBubble({
  title,
  detail,
  image,
  imageAlt = "",
  className,
}: {
  title: string;
  detail?: string;
  image?: string | null;
  imageAlt?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex w-[230px] flex-col gap-0.5 self-end rounded-[14px] bg-bubble-out p-1.5 pb-2.5 shadow-xs",
        className,
      )}
    >
      {image ? (
        <img
          src={image}
          alt={imageAlt}
          className="mb-1.5 h-[120px] w-full rounded-[10px] object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="mb-1.5 block h-[120px] rounded-[10px] bg-gradient-to-br from-av5-ink to-av1-ink"
        />
      )}
      <b className="px-1.5 font-bold">{title}</b>
      {detail ? <span className="px-1.5 text-sm text-muted-foreground">{detail}</span> : null}
    </div>
  );
}
