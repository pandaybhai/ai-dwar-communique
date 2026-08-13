import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-3 rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-lg" />
      ))}
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);

  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-border/70 px-4 py-3 sm:flex-row">
      <p className="text-xs text-muted-foreground">
        Showing <span className="font-medium text-foreground">{start}</span>–
        <span className="font-medium text-foreground">{end}</span> of{" "}
        <span className="font-medium text-foreground">{total}</span>
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="rounded-full"
          disabled={page <= 0}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft className="mr-1 h-3.5 w-3.5" /> Previous
        </Button>
        <span className="text-xs text-muted-foreground">
          Page {page + 1} of {pages}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full"
          disabled={page + 1 >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          Next <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function NoResults({ message }: { message: string }) {
  return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{message}</p>;
}
