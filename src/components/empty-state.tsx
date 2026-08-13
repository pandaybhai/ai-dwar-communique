import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";

export function PageHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-8">
      <h1 className="text-2xl font-bold tracking-tight text-foreground sm:text-3xl">{title}</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted-foreground sm:text-base">{description}</p>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 rounded-2xl border border-border/70 bg-card p-10 text-center shadow-sm duration-500">
      <div className="relative mx-auto h-24 w-24">
        <div className="absolute inset-0 rounded-full bg-primary/10 blur-xl" />
        <div className="relative flex h-24 w-24 items-center justify-center rounded-3xl border border-primary/15 bg-gradient-to-br from-primary/15 to-primary/5">
          <Icon className="h-9 w-9 text-primary" />
        </div>
      </div>
      <h2 className="mt-6 text-lg font-semibold text-foreground">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{description}</p>
      {action ? <div className="mt-6 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-80" />
      </div>
      <Skeleton className="h-56 w-full rounded-2xl" />
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="rounded-2xl border border-destructive/20 bg-destructive/5 p-6 text-sm text-destructive">
      {message}
    </div>
  );
}
