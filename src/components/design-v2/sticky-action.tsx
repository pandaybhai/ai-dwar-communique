import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Batch 57 (approved preview): on a phone the page's main action sits by the
 * thumb, just above the bottom bar (safe-area aware); from 701px it stays
 * where it is in the page. The page keeps its own bottom padding for it.
 */
export function StickyAction({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "phone:fixed phone:inset-x-[max(16px,env(safe-area-inset-left))] phone:bottom-[calc(env(safe-area-inset-bottom)+5.25rem)] phone:z-20 phone:flex phone:[&>*]:flex-1 phone:[&>*]:shadow-lg",
        className,
      )}
    >
      {children}
    </div>
  );
}
