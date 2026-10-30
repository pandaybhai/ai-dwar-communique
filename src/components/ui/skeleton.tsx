import { cn } from "@/lib/utils";

/**
 * Batch 57: `data-slot="skeleton"` lets Aiden Workspace shimmer it
 * (styles.css, html[data-design="new"] only); Classic still pulses.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-foreground/[0.07]", className)}
      {...props}
    />
  );
}

export { Skeleton };
