import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArchiveRestore, Plus, Table2, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { usePermissions } from "@/hooks/use-permissions";
import { STARTERS } from "@/lib/flow-starters";
import { relativeTime } from "@/lib/catalog";
import { responsesLine, type FlowResponseCount } from "@/lib/flow-responses";
import { flowStatus } from "@/lib/flow-status";
import { flowDeletedAt, restoreDaysLeft } from "@/lib/flow-delete";
import { DeleteFlowDialog } from "@/components/flows/v2/delete-flow-dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Row = { id: string; name: string; is_enabled: boolean; updated_at: string; config?: Record<string, unknown> | null };

/**
 * How many runs (Responses rows) each flow has and when the latest started:
 * one head count and one newest-row read per flow, both on the
 * (flow_id, started_at) index — never the runs themselves.
 */
async function loadResponseCounts(organizationId: string, ids: string[]): Promise<Record<string, FlowResponseCount>> {
  const pairs = await Promise.all(
    ids.map(async (id) => {
      const [{ count }, { data }] = await Promise.all([
        aidwar.from("flow_runs").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("flow_id", id),
        aidwar.from("flow_runs").select("started_at").eq("organization_id", organizationId).eq("flow_id", id).order("started_at", { ascending: false }).limit(1),
      ]);
      const last = ((data ?? []) as Array<{ started_at: string | null }>)[0]?.started_at ?? null;
      return [id, { count: count ?? 0, last }] as const;
    }),
  );
  return Object.fromEntries(pairs);
}

export function ChatFlowsList({ organizationId }: { organizationId: string }) {
  const { can } = usePermissions();
  const canEdit = can("flows_v2.edit");
  // The Responses view needs contacts.view, same as inside the editor.
  const canViewResponses = can("contacts.view");
  const [counts, setCounts] = useState<Record<string, FlowResponseCount>>({});
  // Flows with a published version; null until read (or if the read fails).
  const [published, setPublished] = useState<Set<string> | null>(null);
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Batch 35: deleted flows are hidden, except under the "Deleted flows" filter.
  const [showDeleted, setShowDeleted] = useState(false);
  const [deleted, setDeleted] = useState<Row[]>([]);
  const [deleting, setDeleting] = useState<Row | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await aidwar.from("flows").select("id, name, is_enabled, updated_at, config").eq("organization_id", organizationId).like("key", "v2:%").order("updated_at", { ascending: false });
    if (e) { setError(true); return; }
    const all = (data ?? []) as Row[];
    const list = all.filter((r) => !flowDeletedAt(r));
    setDeleted(all.filter((r) => flowDeletedAt(r) && restoreDaysLeft(r) > 0));
    setRows(list);
    const ids = list.map((r) => r.id);
    if (ids.length) {
      void Promise.resolve(
        aidwar.from("flow_versions").select("flow_id").eq("organization_id", organizationId).eq("status", "published").in("flow_id", ids),
      ).then(({ data: pubs, error: pe }) => {
        if (!pe) setPublished(new Set(((pubs ?? []) as Array<{ flow_id: string }>).map((p) => p.flow_id)));
      }, () => {});
    }
    // Counts arrive after the list; a failed count just leaves the line out.
    void loadResponseCounts(organizationId, list.map((r) => r.id)).then(setCounts).catch(() => {});
  }, [organizationId]);
  useEffect(() => { void load(); }, [load]);

  const restore = async (row: Row) => {
    setBusy(true);
    const { error: e } = await callApi("/api/flows/v2", { body: { action: "restore_flow", organization_id: organizationId, flow_id: row.id } });
    setBusy(false);
    if (e) { toast.error(e); return; }
    toast.success(`“${row.name}” is back. Publish it again if it was off.`);
    void load();
  };

  const create = async (key: string) => {
    const s = STARTERS.find((x) => x.key === key)!;
    setBusy(true);
    const { data, error: e } = await callApi<{ flow_id: string }>("/api/flows/v2", { body: { action: "create", organization_id: organizationId, name: s.name, graph: s.graph() } });
    setBusy(false);
    if (e || !data) { toast.error(e ?? "Couldn't create the flow."); return; }
    void navigate({ to: "/app/flows/v2/$id", params: { id: data.flow_id } });
  };

  if (error) return <ErrorState message="We couldn't load your chat flows. Refresh to try again." />;
  if (!rows) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {deleted.length > 0 || showDeleted ? (
          <Button variant="ghost" size="sm" onClick={() => setShowDeleted((v) => !v)}>
            {showDeleted ? "Back to your flows" : `Deleted flows (${deleted.length})`}
          </Button>
        ) : null}
        {canEdit && !showDeleted && <Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> New chat flow</Button>}
      </div>
      {showDeleted ? (
        deleted.length === 0 ? (
          <EmptyState icon={Trash2} title="No deleted flows" description="Flows you delete stay here for 30 days, then they're gone." />
        ) : (
          <ul className="divide-y divide-border rounded-2xl border border-border bg-card" data-testid="deleted-flows">
            {deleted.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    Deleted {relativeTime(flowDeletedAt(r)!)} · {restoreDaysLeft(r)} day{restoreDaysLeft(r) === 1 ? "" : "s"} left to restore
                  </span>
                </span>
                {canEdit ? (
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(r)}>
                    <ArchiveRestore className="mr-1 h-4 w-4" /> Restore
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )
      ) : rows.length === 0 ? (
        <EmptyState icon={Workflow} title="No chat flows yet" description="Build menus, questions and hand-offs that run on their own — no AI needed." action={canEdit ? <Button onClick={() => setOpen(true)}>Create your first flow</Button> : undefined} />
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2 pr-3 transition hover:bg-muted/50">
              <Link to="/app/flows/v2/$id" params={{ id: r.id }} className="flex min-w-0 flex-1 items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block truncate font-medium">{r.name}</span>
                  {counts[r.id] ? (
                    <span className="block text-xs text-muted-foreground">{responsesLine(counts[r.id]!, relativeTime)}</span>
                  ) : null}
                </span>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${r.is_enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{flowStatus(r.is_enabled, published ? published.has(r.id) : null)}</span>
              </Link>
              {canViewResponses ? (
                <Link to="/app/flows/v2/$id" params={{ id: r.id }} search={{ view: "responses" }} className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition hover:bg-primary/10">
                  <Table2 className="h-3.5 w-3.5" /> Responses
                </Link>
              ) : null}
              {canEdit ? (
                <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label={`Delete ${r.name}`} title="Delete flow" onClick={() => setDeleting(r)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <DeleteFlowDialog
        organizationId={organizationId}
        flow={deleting}
        open={Boolean(deleting)}
        onOpenChange={(v) => { if (!v) setDeleting(null); }}
        onDeleted={() => { setDeleting(null); void load(); }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Start from a template</DialogTitle></DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {STARTERS.map((s) => (
              <button key={s.key} type="button" disabled={busy} onClick={() => void create(s.key)} className="rounded-xl border border-border p-4 text-left transition hover:border-primary hover:shadow-sm disabled:opacity-60">
                <p className="font-semibold">{s.name}</p>
                <p className="text-sm text-muted-foreground">{s.description}</p>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
