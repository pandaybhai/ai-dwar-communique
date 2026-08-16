import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * A section card that always ships its three states: skeleton while loading,
 * a designed empty state when there is nothing to plot, and the chart itself.
 */
export function ChartCard({
  title,
  description,
  loading,
  isEmpty,
  emptyIcon: EmptyIcon,
  emptyTitle,
  emptyDescription,
  action,
  children,
  className,
}: {
  title: string;
  description?: string | undefined;
  loading?: boolean | undefined;
  isEmpty?: boolean | undefined;
  emptyIcon: LucideIcon;
  emptyTitle: string;
  emptyDescription: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <Card className={cn("border-border/70 shadow-sm", className)}>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle className="text-base font-semibold">{title}</CardTitle>
          {description ? <CardDescription className="mt-1">{description}</CardDescription> : null}
        </div>
        {action}
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-56 w-full rounded-xl" />
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border/70 bg-muted/30 px-6 py-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10">
              <EmptyIcon className="h-6 w-6 text-primary" />
            </div>
            <p className="mt-4 text-sm font-semibold text-foreground">{emptyTitle}</p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
              {emptyDescription}
            </p>
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

export function MetricCard({
  label,
  value,
  rateText,
  rateLabel,
  thin,
  deltaText,
  direction,
  loading,
}: {
  label: string;
  value: number;
  rateText?: string | undefined;
  rateLabel?: string | undefined;
  thin?: boolean | undefined;
  deltaText?: string | undefined;
  direction?: 0 | 1 | -1 | undefined;
  loading?: boolean | undefined;
}) {
  if (loading) {
    return (
      <Card className="border-border/70 shadow-sm">
        <CardContent className="space-y-3 p-5">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-7 w-16" />
          <Skeleton className="h-3 w-28" />
        </CardContent>
      </Card>
    );
  }

  const DeltaIcon = direction === 1 ? ArrowUpRight : direction === -1 ? ArrowDownRight : Minus;

  return (
    <Card className="border-border/70 shadow-sm transition-shadow duration-200 hover:shadow-md">
      <CardContent className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className="mt-2 text-2xl font-bold tracking-tight text-foreground">
          {value.toLocaleString()}
        </p>
        {rateText ? (
          <p className="mt-1 text-xs text-muted-foreground">
            <span className={cn("font-medium", thin ? "text-foreground/70" : "text-primary")}>
              {rateText}
            </span>{" "}
            {rateLabel}
          </p>
        ) : null}
        {deltaText ? (
          <p
            className={cn(
              "mt-3 flex items-center gap-1 text-xs",
              direction === 1
                ? "text-primary"
                : direction === -1
                  ? "text-destructive"
                  : "text-muted-foreground",
            )}
          >
            <DeltaIcon className="h-3.5 w-3.5" />
            {deltaText}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
