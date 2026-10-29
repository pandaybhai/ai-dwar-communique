import * as React from "react";

import { cn } from "@/lib/utils";

/** A keyboard key, for shortcut hints ("⌘ K", "J"). Batch 39. */
function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-border bg-subtle px-1 font-sans text-[0.6875rem] font-medium leading-none text-muted-foreground shadow-[0_1px_0_var(--border)]",
        className,
      )}
      {...props}
    />
  );
}

export { Kbd };
