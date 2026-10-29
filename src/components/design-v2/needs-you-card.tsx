import type { ReactNode } from "react";
import { BorderBeam } from "@/components/magicui/border-beam";
import { cn } from "@/lib/utils";

/**
 * The one gold thing on a screen (Batch 44): something only the owner can
 * decide. A gold card with a light travelling round its border; the actions
 * go in `actions` (a gold Button for the main choice, outline for the rest).
 */
export function NeedsYouCard({
  title,
  children,
  actions,
  className,
}: {
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        "relative flex flex-col gap-2.5 rounded-[20px] border-2 border-gold-line bg-gold-bg p-[18px] text-foreground",
        className,
      )}
    >
      <BorderBeam />
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      {children ? <div className="text-body [&_p]:m-0">{children}</div> : null}
      {actions ? <div className="mt-1 flex flex-wrap gap-2">{actions}</div> : null}
    </section>
  );
}
