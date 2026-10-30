import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { SectionTabs, useShellSection } from "@/components/shell/section-tabs";
import { AidenOrb } from "@/components/design-v2/aiden-orb";

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
  const shell = useShellSection();
  if (shell?.section && shell.section.tabs.length > 1) {
    // Batch 44, new design: the preview's page head — the section's name, its
    // sub-tabs and the page's actions on one line, the page's own words below.
    return (
      <div className="mb-7 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h1 className="min-w-0 font-display text-[clamp(1.75rem,3.4vw,2.5rem)] font-extrabold leading-[1.05] tracking-[-0.03em] [overflow-wrap:break-word] text-foreground">
            {shell.section.label}
          </h1>
          <SectionTabs />
          {actions ? (
            <div className="flex flex-wrap items-center gap-2 wide:ml-auto">{actions}</div>
          ) : null}
        </div>
        <p className="max-w-2xl text-body text-muted-foreground">
          <span className="sr-only">{title}: </span>
          {description}
        </p>
      </div>
    );
  }
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
  art = "orb",
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  /** Batch 39: "plain" drops the card frame, for an empty pane inside a layout. */
  variant?: "card" | "plain";
  /** Batch 57, Aiden Workspace only: "people" adds three customer avatars under the orb. */
  art?: "orb" | "people";
}) {
  const shell = useShellSection();
  if (shell) {
    // Batch 57, Aiden Workspace (only the new shell provides the section
    // state): drawn with our own orb, not an icon tile; the words say what
    // will show here and the one step that fills it.
    return (
      <div
        className={cn(
          "nd-rise flex flex-col items-center gap-3 px-5 py-10 text-center",
          variant === "card" && "rounded-[18px] border-[1.5px] border-dashed border-line",
        )}
      >
        <AidenOrb state="draft" size={72} />
        {art === "people" ? (
          <span aria-hidden="true" className="flex">
            {["bg-av1", "bg-av2", "bg-av3"].map((bg, i) => (
              <span
                key={bg}
                className={cn("h-[34px] w-[34px] rounded-full border-2 border-surface", bg, i > 0 && "-ml-2")}
              />
            ))}
          </span>
        ) : null}
        <h2 className="m-0 font-display text-[1.375rem] font-extrabold leading-tight tracking-[-0.02em] text-foreground text-balance">
          {title}
        </h2>
        <p className="m-0 max-w-[44ch] text-body text-muted-foreground">{description}</p>
        {action ? <div className="mt-2 flex flex-wrap justify-center gap-2.5">{action}</div> : null}
      </div>
    );
  }
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

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  /** Batch 57: a "Try again" button after the message (Aiden Workspace screens pass it). */
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-danger-border bg-danger-soft p-4 text-sm text-danger-soft-foreground"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      {onRetry ? <p className="min-w-0 flex-1">{message}</p> : <p>{message}</p>}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="shrink-0 rounded-md font-semibold underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
