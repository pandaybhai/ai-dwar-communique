import { usePermissions } from "@/hooks/use-permissions";
import { useCallback, useEffect, useState } from "react";
import { Copy, Filter, Pencil, Plus, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { logActivity } from "@/lib/activity";
import { formatDate, type TagRow } from "@/lib/contacts";
import { normalizeFilters, type SegmentRow } from "@/lib/segments";
import { EmptyState, ErrorState } from "@/components/empty-state";
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

export function SegmentsView({
  organizationId,
  role,
  tags,
  attributeKeys,
}: {
  organizationId: string;
  role: string | null;
  tags: TagRow[];
  attributeKeys: string[];
}) {
  const { can } = usePermissions();
  const isAdmin = can("segments.manage");
  void role;

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
      for (const p of ((profiles as { id: string; full_name: string | null; email: string | null }[]) ??
        [])) {
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

  return (
    <>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Segments update themselves — build the rules once and the audience stays fresh.
        </p>
        <Button className="rounded-full" onClick={openNew}>
          <Plus className="mr-2 h-4 w-4" />
          New segment
        </Button>
      </div>

      {error ? (
        <ErrorState message={error} />
      ) : loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-2xl" />
          ))}
        </div>
      ) : segments.length === 0 ? (
        <EmptyState
          icon={Filter}
          title="No segments yet"
          description="Group your contacts by tag, opt-in status or anything you've imported — then reach exactly the right people."
          action={
            <Button className="rounded-full" onClick={openNew}>
              <Plus className="mr-2 h-4 w-4" />
              Create your first segment
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {segments.map((s) => (
            <div
              key={s.id}
              className="group rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate font-semibold text-foreground">{s.name}</h3>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {s.description || "No description"}
                  </p>
                </div>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                  {s.filters.match === "all" ? "All rules" : "Any rule"}
                </span>
              </div>

              <div className="mt-5 flex items-center gap-2">
                <Users className="h-4 w-4 text-primary" />
                {counts[s.id] === undefined ? (
                  <Skeleton className="h-6 w-14" />
                ) : (
                  <span className="text-2xl font-bold text-foreground">{counts[s.id]}</span>
                )}
                <span className="text-xs text-muted-foreground">contacts</span>
              </div>

              <p className="mt-3 text-[11px] text-muted-foreground">
                Created by {s.created_by ? (authors[s.created_by] ?? "Teammate") : "Teammate"} ·{" "}
                {formatDate(s.created_at)}
              </p>

              <div className="mt-4 flex items-center gap-1 border-t border-border/60 pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full"
                  onClick={() => {
                    setEditing(s);
                    setDuplicateName(undefined);
                    setBuilderOpen(true);
                  }}
                >
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full"
                  onClick={() => openDuplicate(s)}
                >
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Duplicate
                </Button>
                {isAdmin ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto rounded-full text-muted-foreground hover:text-destructive"
                    onClick={() => setPendingDelete(s)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
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
    </>
  );
}
