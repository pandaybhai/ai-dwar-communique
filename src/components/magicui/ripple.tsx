import React, { type ComponentPropsWithoutRef, type CSSProperties } from "react";

import { cn } from "@/lib/utils";

/**
 * Magic UI's ripple (magicui.design), restyled for AiDwar (Batch 44) into the
 * preview's orb rings: emerald hairlines that grow out and fade, one every
 * .8s (keyframes .nd-orb-ring in styles.css; reduced motion hides them).
 */
interface RippleProps extends ComponentPropsWithoutRef<"div"> {
  numCircles?: number;
}

export const Ripple = React.memo(function Ripple({
  numCircles = 3,
  className,
  ...props
}: RippleProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0 select-none", className)}
      {...props}
    >
      {Array.from({ length: numCircles }, (_, i) => (
        <span
          key={i}
          className="nd-orb-ring absolute inset-0 rounded-full"
          style={{ "--i": i } as CSSProperties}
        />
      ))}
    </div>
  );
});

Ripple.displayName = "Ripple";
