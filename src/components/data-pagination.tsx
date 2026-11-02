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

/** Batch 57: Aiden Workspace's words for Pagination (Classic passes none). */
export type PaginationWords = {
  showing: (start: number, end: number, total: number) => string;
  previous: string;
  next: string;
  page: (page: number, pages: number) => string;
};

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  words,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
  /**
   * Batch 57, Aiden Workspace only: its words, Indian number grouping and
   * 44px buttons on a phone. Unset: the Classic bar below, exactly as before.
   */
  words?: PaginationWords;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : page * pageSize + 1;
  const end = Math.min(total, (page + 1) * pageSize);

  if (words) {
    return (
      <div className="flex flex-col items-center justify-between gap-3 border-t border-line px-4 py-3 sm:flex-row">
        <p className="m-0 text-sm text-muted-foreground tabular-nums">
          {words.showing(start, end, total)}
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-full phone:h-11 phone:px-4"
            disabled={page <= 0}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeft className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
            {words.previous}
          </Button>
          <span className="text-sm text-muted-foreground tabular-nums">
            {words.page(page + 1, pages)}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="rounded-full phone:h-11 phone:px-4"
            disabled={page + 1 >= pages}
            onClick={() => onPageChange(page + 1)}
          >
            {words.next}
            <ChevronRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </div>
      </div>
    );
  }

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
