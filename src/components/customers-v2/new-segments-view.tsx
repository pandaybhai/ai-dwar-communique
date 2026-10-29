import { useCallback, useEffect, useState } from "react";
import { Copy, Filter, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { usePermissions } from "@/hooks/use-permissions";
import { callApi } from "@/lib/whatsapp-client";
import { logActivity } from "@/lib/activity";
import { formatDate, type TagRow } from "@/lib/contacts";
import { normalizeFilters, type SegmentRow } from "@/lib/segments";
import { EmptyState, ErrorState, PageHeader } from "@/components/empty-state";
import { SegmentBuilderDialog } from "@/components/segments/segment-builder-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * Batch 48: Customers → Segments in the new design. The classic SegmentsView's
 * reads and writes, unchanged: the segments list, each count from
 * /api/contacts/evaluate-segment, the classic builder for new / edit /
 * duplicate, and the same delete (segments.manage) with its activity log.
 */
export function NewSegmentsView({
  organizationId,
  tags,
  attributeKeys,
}: {
  organizationId: string;
  tags: TagRow[];
  attributeKeys: string[];
}) {
  const { can } = usePermissions();
  const isAdmin = can("segments.manage");

  const [segments, setSegments] = useState<SegmentRow[]>([]);
  const [authors, setAuthors] = useState<Record<string, string>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editing, setEditing] = useState<SegmentRow | null>(null);
  const [duplicateName, setDuplicateName] = useState<string | undefined>(undefined);
  const [pendingDelete, setPendingDelete] = useState<SegmentRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: qErr } = await aidwar
      .from("segments")
      .select("id, name, description, filters, created_by, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false });
    if (qErr) {
      setError("We couldn't load your segments. Please try again.");
      setLoading(false);
      return;
    }
    const rows = ((data ?? []) as SegmentRow[]).map((s) => ({
      ...s,
      filters: normalizeFilters(s.filters),
    }));
    setSegments(rows);
    setLoading(false);

    const ids = Array.from(new Set(rows.map((s) => s.created_by).filter(Boolean))) as string[];
    if (ids.length) {
      const { data: profiles } = await aidwar
        .from("profiles")
        .select("id, full_name, email")
        .in("id", ids);
      const map: Record<string, string> = {};
      for (const p of (profiles as {
        id: string;
        full_name: string | null;
        email: string | null;
      }[]) ?? []) {
        map[p.id] = p.full_name || p.email || "Teammate";
      }
      setAuthors(map);
    }

    for (const s of rows) {
      void callApi<{ count: number }>("/api/contacts/evaluate-segment", {
        body: { organization_id: organizationId, filters: s.filters },
      }).then(({ data: res }) => {
        if (res) setCounts((prev) => ({ ...prev, [s.id]: res.count }));
      });
    }
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmDelete() {
    const segment = pendingDelete;
    if (!segment) return;
    setPendingDelete(null);
    const { error: delErr } = await aidwar.from("segments").delete().eq("id", segment.id);
    if (delErr) {
      toast.error("We couldn't delete this segment.");
      return;
    }
    void logActivity("segment_deleted", organizationId, { name: segment.name });
    toast.success("Segment deleted.");
    void load();
  }

  function openNew() {
    setEditing(null);
    setDuplicateName(undefined);
    setBuilderOpen(true);
  }

  function openDuplicate(segment: SegmentRow) {
    setEditing({ ...segment, id: "" } as SegmentRow);
    setDuplicateName(`${segment.name} copy`);
    setBuilderOpen(true);
  }

  const action =
    "inline-flex h-9 items-center gap-1.5 rounded-[11px] px-3 text-sm font-semibold text-muted-foreground transition-colors duration-200 hover:bg-ground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden";

  return (
    <div className="nd-view-enter">
      <PageHeader
        title="Segments"
        description="Segments update themselves: build the rules once and the audience stays fresh. Campaigns pick a segment as their audience."
        actions={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New segment
          </Button>
        }
      />

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <div className="grid gap-4 wide:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-44 w-full rounded-[20px]" />
          ))}
        </div>
      ) : segments.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No segments yet"
          description="Group your customers by tag, opt-in status or anything you've imported, then reach exactly the right people."
          action={
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              Create your first segment
            </Button>
          }
        />
      ) : (
        <ul className="m-0 grid list-none gap-4 p-0 wide:grid-cols-2 lg:grid-cols-3">
          {segments.map((s) => (
            <li
              key={s.id}
              className="flex flex-col gap-3 rounded-[20px] border border-line bg-surface p-5 shadow-md"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="m-0 truncate font-display text-lg font-semibold">{s.name}</h2>
                  <p className="m-0 mt-1 line-clamp-2 text-[0.9375rem] text-muted-foreground">
                    {s.description || "No description"}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-aiden-soft px-2.5 py-1 text-[0.8125rem] font-semibold text-aiden-deep">
                  {s.filters.match === "all" ? "All rules" : "Any rule"}
                </span>
              </div>

              <div className="flex items-baseline gap-2">
                {counts[s.id] === undefined ? (
                  <Skeleton className="h-7 w-16" />
                ) : (
                  <span className="tabular font-display text-[1.75rem] font-semibold leading-none">
                    {counts[s.id]!.toLocaleString("en-IN")}
                  </span>
                )}
                <span className="text-[0.9375rem] text-muted-foreground">customers</span>
              </div>

              <p className="m-0 text-sm text-muted-foreground">
                Made by {s.created_by ? (authors[s.created_by] ?? "Teammate") : "Teammate"} on{" "}
                {formatDate(s.created_at)}
              </p>

              <div className="-mx-2 mt-auto flex items-center gap-1 border-t border-line pt-3">
                <button
                  type="button"
                  className={action}
                  onClick={() => {
                    setEditing(s);
                    setDuplicateName(undefined);
                    setBuilderOpen(true);
                  }}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  Edit
                </button>
                <button type="button" className={action} onClick={() => openDuplicate(s)}>
                  <Copy className="h-4 w-4" aria-hidden="true" />
                  Duplicate
                </button>
                {isAdmin ? (
                  <button
                    type="button"
                    className={`${action} ml-auto hover:text-danger-soft-foreground`}
                    onClick={() => setPendingDelete(s)}
                    aria-label={`Delete ${s.name}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <SegmentBuilderDialog
        organizationId={organizationId}
        tags={tags}
        attributeKeys={attributeKeys}
        open={builderOpen}
        onOpenChange={setBuilderOpen}
        segment={editing}
        {...(duplicateName ? { initialName: duplicateName } : {})}
        onSaved={load}
      />

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(o) => !o && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this segment?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.name}” will be removed. Your contacts stay exactly as they are.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
