import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * Wraps a control the current user may not use. The control stays visible but
 * inert, with a tooltip explaining exactly which permission is missing — a
 * discoverable "no" beats a silently vanishing button.
 */
export function PermissionGate({
  allowed,
  reason,
  children,
  className,
}: {
  allowed: boolean;
  reason: string;
  children: ReactNode;
  className?: string;
}) {
  if (allowed) return <>{children}</>;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={className}
            tabIndex={0}
            aria-disabled="true"
            role="button"
            aria-label={reason}
          >
            <span className="pointer-events-none block opacity-50 grayscale">{children}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-xs leading-relaxed">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
