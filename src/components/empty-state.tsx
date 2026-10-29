import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description: string;
  /** Batch 39: buttons on the right of the title (stack under it on phones). */
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="type-display text-foreground">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground sm:text-body">{description}</p>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = "card",
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  /** Batch 39: "plain" drops the card frame, for an empty pane inside a layout. */
  variant?: "card" | "plain";
}) {
  return (
    <div
      className={cn(
        "animate-in fade-in slide-in-from-bottom-1 px-6 py-12 text-center duration-300",
        variant === "card" && "rounded-2xl border border-border bg-card shadow-xs",
      )}
    >
      <div className="relative mx-auto h-14 w-14">
        <div className="absolute -inset-3 rounded-full bg-primary/10 blur-xl" aria-hidden="true" />
        <div className="relative flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-card shadow-sm">
          <Icon className="h-6 w-6 text-primary" aria-hidden="true" />
        </div>
      </div>
      <h2 className="mt-5 text-base font-semibold text-foreground">{title}</h2>
      <p className="mx-auto mt-1.5 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-danger-border bg-danger-soft p-4 text-sm text-danger-soft-foreground"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}
