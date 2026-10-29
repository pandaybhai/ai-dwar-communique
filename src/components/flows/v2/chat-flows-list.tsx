import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArchiveRestore, ArrowLeft, Plus, Search, Table2, Trash2, Workflow, Zap } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { usePermissions } from "@/hooks/use-permissions";
import { usePageShortcut } from "@/hooks/use-page-shortcut";
import { STARTERS } from "@/lib/flow-starters";
import { relativeTime } from "@/lib/catalog";
import { responsesLine, type FlowResponseCount } from "@/lib/flow-responses";
import { flowStatus, type FlowStatus } from "@/lib/flow-status";
import { FLOW_RESTORE_DAYS, flowDeletedAt, restoreDaysLeft } from "@/lib/flow-delete";
import type { FlowGraph } from "@/lib/flow-graph";
import { cn } from "@/lib/utils";
import { DeleteFlowDialog } from "@/components/flows/v2/delete-flow-dialog";
import { FlowThumbnail } from "@/components/flows/v2/flow-thumbnail";
import { KIND_LABELS } from "@/components/flows/v2/triggers-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Row = { id: string; name: string; is_enabled: boolean; updated_at: string; config?: Record<string, unknown> | null };
type TriggerLite = { flow_id: string; kind: string; config: Record<string, unknown> | null; is_enabled: boolean };
type Filter = "all" | FlowStatus;

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

/** What starts a flow, one short part per trigger: "Keyword “hi”, “menu”", "First message ever". */
export function triggerParts(triggers: TriggerLite[]): string[] {
  return triggers
    .filter((t) => t.is_enabled)
    .map((t) => {
      if (t.kind === "keyword") {
        const words = ((t.config?.["keywords"] as string[] | undefined) ?? []).filter(Boolean);
        const shown = words.slice(0, 2).map((w) => `“${w}”`).join(", ");
        return words.length ? `Keyword ${shown}${words.length > 2 ? ` +${words.length - 2}` : ""}` : "Keyword";
      }
      return KIND_LABELS[t.kind] ?? t.kind.replace(/_/g, " ");
    });
}

const STATUS_BADGE: Record<FlowStatus, "success" | "muted" | "outline"> = {
  Published: "success",
  Off: "muted",
  Draft: "outline",
};

function StatusChip({ status }: { status: FlowStatus }) {
  return (
    <Badge variant={STATUS_BADGE[status]} className="rounded-full">
      {status}
    </Badge>
  );
}

export function ChatFlowsList({ organizationId }: { organizationId: string }) {
  const { can } = usePermissions();
  const canEdit = can("flows_v2.edit");
  // The Responses view needs contacts.view, same as inside the editor.
  const canViewResponses = can("contacts.view");
  const [counts, setCounts] = useState<Record<string, FlowResponseCount>>({});
  // Flows with a published version; null until read (or if the read fails).
  const [published, setPublished] = useState<Set<string> | null>(null);
  // Batch 42: what starts each flow, and its graph for the thumbnail (read only; missing = left out).
  const [triggers, setTriggers] = useState<Record<string, TriggerLite[]>>({});
  const [graphs, setGraphs] = useState<Record<string, FlowGraph>>({});
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  // Batch 35: deleted flows are hidden, except under the "Deleted flows" filter.
  const [showDeleted, setShowDeleted] = useState(false);
  const [deleted, setDeleted] = useState<Row[]>([]);
  const [deleting, setDeleting] = useState<Row | null>(null);

  // Batch 42: N starts a new chat flow, for whoever may create one.
  usePageShortcut("n", () => setOpen(true), canEdit && !open && !showDeleted);

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
      void Promise.resolve(
        aidwar.from("flow_triggers").select("flow_id, kind, config, is_enabled").eq("organization_id", organizationId).in("flow_id", ids),
      ).then(({ data: trs, error: te }) => {
        if (te) return;
        const map: Record<string, TriggerLite[]> = {};
        for (const t of (trs ?? []) as TriggerLite[]) (map[t.flow_id] ??= []).push(t);
        setTriggers(map);
      }, () => {});
      // The thumbnail draws what the editor opens: the draft, else the published version.
      void Promise.resolve(
        aidwar.from("flow_versions").select("flow_id, status, graph").eq("organization_id", organizationId).in("status", ["draft", "published"]).in("flow_id", ids),
      ).then(({ data: vers, error: ve }) => {
        if (ve) return;
        const map: Record<string, FlowGraph> = {};
        const rank = (s: string) => (s === "draft" ? 0 : 1);
        const sorted = ((vers ?? []) as Array<{ flow_id: string; status: string; graph: FlowGraph }>).sort((a, b) => rank(a.status) - rank(b.status));
        for (const v of sorted) if (!map[v.flow_id] && v.graph) map[v.flow_id] = v.graph;
        setGraphs(map);
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

  const statusOf = useCallback((r: Row) => flowStatus(r.is_enabled, published ? published.has(r.id) : null), [published]);
  const tally = useMemo(() => {
    const t: Record<Filter, number> = { all: rows?.length ?? 0, Published: 0, Off: 0, Draft: 0 };
    for (const r of rows ?? []) t[statusOf(r)] += 1;
    return t;
  }, [rows, statusOf]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((r) => (filter === "all" || statusOf(r) === filter) && (!q || r.name.toLowerCase().includes(q)));
  }, [rows, filter, query, statusOf]);
  const starterGraphs = useMemo(() => Object.fromEntries(STARTERS.map((s) => [s.key, s.graph()])), []);

  if (error) return <ErrorState message="We couldn't load your chat flows. Refresh to try again." />;
  if (!rows) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading your chat flows">
        <Skeleton className="h-9 w-80 rounded-lg" />
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-0">
              <Skeleton className="h-14 w-24 rounded-lg" />
              <div className="flex-1 space-y-2"><Skeleton className="h-4 w-48" /><Skeleton className="h-3 w-72" /></div>
              <Skeleton className="h-5 w-20 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const newButton = canEdit && !showDeleted ? (
    <Button onClick={() => setOpen(true)}>
      <Plus className="h-4 w-4" /> New chat flow
      <Kbd className="ml-1 hidden border-primary-foreground/30 bg-primary-foreground/15 text-primary-foreground shadow-none sm:inline-flex">N</Kbd>
    </Button>
  ) : null;

  return (
    <div className="space-y-4">
      {showDeleted ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="ghost" size="sm" onClick={() => setShowDeleted(false)}>
            <ArrowLeft className="h-4 w-4" /> Back to your flows
          </Button>
          <p className="text-sm text-muted-foreground">Deleted flows stay here for {FLOW_RESTORE_DAYS} days, then they're gone.</p>
        </div>
      ) : rows.length > 0 ? (
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div role="group" aria-label="Show flows" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 lg:pb-0">
            {(["all", "Published", "Off", "Draft"] as const).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors duration-150",
                  filter === f ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {f === "all" ? "All" : f === "Draft" ? "Drafts" : f}
                <span className={cn("tabular text-xs", filter === f ? "opacity-70" : "text-faint")}>{tally[f]}</span>
              </button>
            ))}
          </div>
          <div className="relative min-w-0 lg:ml-2 lg:w-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-faint" aria-hidden="true" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search flows" aria-label="Search chat flows" className="h-9 pl-9" />
          </div>
          <div className="flex items-center gap-2 lg:ml-auto">
            {deleted.length > 0 ? (
              <Button variant="ghost" size="sm" onClick={() => setShowDeleted(true)}>
                <Trash2 className="h-4 w-4" /> {`Deleted flows (${deleted.length})`}
              </Button>
            ) : null}
            {newButton}
          </div>
        </div>
      ) : deleted.length > 0 ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setShowDeleted(true)}>
            <Trash2 className="h-4 w-4" /> {`Deleted flows (${deleted.length})`}
          </Button>
        </div>
      ) : null}

      {showDeleted ? (
        deleted.length === 0 ? (
          <EmptyState icon={Trash2} title="No deleted flows" description="Flows you delete stay here for 30 days, then they're gone." />
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border bg-card shadow-xs" data-testid="deleted-flows">
            {deleted.map((r) => {
              const left = restoreDaysLeft(r);
              return (
                <li key={r.id} className="flex items-center gap-4 border-b border-border px-4 py-3.5 last:border-0">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <Workflow className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-foreground">{r.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      Deleted {relativeTime(flowDeletedAt(r)!)} · {left} day{left === 1 ? "" : "s"} left to restore
                    </span>
                    <span className="mt-1.5 block h-1 w-40 max-w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                      <span className="block h-full rounded-full bg-warning" style={{ width: `${Math.round((left / FLOW_RESTORE_DAYS) * 100)}%` }} />
                    </span>
                  </span>
                  {canEdit ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(r)}>
                      <ArchiveRestore className="h-4 w-4" /> Restore
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : rows.length === 0 ? (
        <EmptyState icon={Workflow} title="No chat flows yet" description="Build menus, questions and hand-offs that run on their own — no AI needed." action={canEdit ? <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Create your first flow</Button> : undefined} />
      ) : visible.length === 0 ? (
        <EmptyState
          variant="plain"
          icon={Search}
          title="No flows match"
          description="Try another word, or show every flow."
          action={<Button variant="outline" size="sm" onClick={() => { setFilter("all"); setQuery(""); }}>Show all flows</Button>}
        />
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
          <li aria-hidden="true" className="hidden grid-cols-[6.5rem_minmax(0,1fr)_7rem_11rem_5.5rem] items-center gap-4 border-b border-border bg-subtle px-4 py-2 text-xs font-medium text-muted-foreground md:grid">
            <span>Flow</span><span /><span>Status</span><span>Runs</span><span />
          </li>
          {visible.map((r) => {
            const status = statusOf(r);
            const parts = triggerParts(triggers[r.id] ?? []);
            return (
              <li key={r.id} className="group relative grid grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border px-4 py-3.5 transition-colors duration-150 last:border-0 hover:bg-accent/50 md:grid-cols-[6.5rem_minmax(0,1fr)_7rem_11rem_5.5rem]">
                <FlowThumbnail graph={graphs[r.id]} className="row-span-2 h-12 w-20 md:row-span-1 md:h-14 md:w-[6.5rem]" />
                <div className="min-w-0">
                  <Link to="/app/flows/v2/$id" params={{ id: r.id }} className="block truncate font-medium text-foreground after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring">
                    {r.name}
                  </Link>
                  <p className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground">
                    <Zap className="h-3 w-3 shrink-0 text-faint" aria-hidden="true" />
                    {parts.length ? (
                      <>
                        {parts.slice(0, 2).map((p) => (
                          <span key={p} className="shrink-0 truncate rounded-md bg-muted px-1.5 py-0.5 text-foreground/80">{p}</span>
                        ))}
                        {parts.length > 2 ? <span className="shrink-0">+{parts.length - 2} more</span> : null}
                      </>
                    ) : (
                      <span className="truncate">No trigger yet — starts only from the inbox</span>
                    )}
                  </p>
                </div>
                <div className="md:order-none"><StatusChip status={status} /></div>
                <div className="col-start-2 text-xs text-muted-foreground md:col-start-auto md:text-sm">
                  {counts[r.id] ? (
                    counts[r.id]!.count ? (
                      <span className="flex flex-col">
                        <span className="tabular font-medium text-foreground">{counts[r.id]!.count.toLocaleString("en-IN")} {counts[r.id]!.count === 1 ? "response" : "responses"}</span>
                        {counts[r.id]!.last ? <span className="text-xs text-muted-foreground">Last {relativeTime(counts[r.id]!.last)}</span> : null}
                      </span>
                    ) : (
                      <span>{responsesLine(counts[r.id]!, relativeTime)}</span>
                    )
                  ) : (
                    <Skeleton className="inline-block h-3.5 w-28 align-middle" />
                  )}
                </div>
                <div className="relative z-10 col-start-3 row-start-2 flex items-center justify-end gap-1 md:col-start-auto md:row-start-auto">
                  {canViewResponses ? (
                    <Button asChild size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-foreground">
                      <Link to="/app/flows/v2/$id" params={{ id: r.id }} search={{ view: "responses" }} aria-label={`Responses for ${r.name}`} title="Responses">
                        <Table2 className="h-4 w-4" />
                      </Link>
                    </Button>
                  ) : null}
                  {canEdit ? (
                    <Button size="icon-sm" variant="ghost" className="text-muted-foreground hover:text-danger" aria-label={`Delete ${r.name}`} title="Delete flow" onClick={() => setDeleting(r)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
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
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Start from a template</DialogTitle>
            <DialogDescription>Pick the closest one — every step can be changed before you publish.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {STARTERS.map((s) => (
              <button
                key={s.key}
                type="button"
                disabled={busy}
                onClick={() => void create(s.key)}
                className="group flex flex-col rounded-xl border border-border bg-card p-3 text-left shadow-xs transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 motion-reduce:hover:translate-y-0"
              >
                <FlowThumbnail graph={starterGraphs[s.key]} className="h-20 w-full" />
                <p className="mt-3 font-semibold text-foreground">{s.name}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{s.description}</p>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
