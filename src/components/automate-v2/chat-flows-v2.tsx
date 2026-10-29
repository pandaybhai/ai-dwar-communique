import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArchiveRestore, Plus, Table2, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { DeleteFlowDialog } from "@/components/flows/v2/delete-flow-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { usePermissions } from "@/hooks/use-permissions";
import { aidwar } from "@/integrations/aidwar/client";
import { relativeTime } from "@/lib/catalog";
import { flowDeletedAt, restoreDaysLeft } from "@/lib/flow-delete";
import type { FlowGraph } from "@/lib/flow-graph";
import { responsesLine, type FlowResponseCount } from "@/lib/flow-responses";
import { STARTERS } from "@/lib/flow-starters";
import { flowStatus } from "@/lib/flow-status";
import { cn } from "@/lib/utils";
import { callApi } from "@/lib/whatsapp-client";
import { FlowThumbnail } from "./flow-thumbnail";
import { graphForCard, triggersLine, type TriggerRow } from "./flows-v2";
import { RunTimeline } from "./run-timeline";

type Row = { id: string; name: string; is_enabled: boolean; updated_at: string; config?: Record<string, unknown> | null };
type Version = { flow_id: string; status: string; version: number; graph: FlowGraph };

/** The classic list's counts: one head count and one newest-row read per flow, on the (flow_id, started_at) index. */
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

const STATUS_TONE = {
  Published: "bg-aiden-soft text-aiden-deep",
  Off: "bg-bubble-in text-muted-foreground",
  Draft: "bg-gold-bg text-gold-ink",
} as const;

/**
 * Batch 49: chat flows (Flows v2) on the new Flows page. The classic
 * ChatFlowsList's reads (flows "v2:%", published versions, run counts) plus
 * read-only extras for the card: each flow's graph for the mini map and its
 * triggers. Restore ("restore_flow"), create ("create" from a starter) and
 * delete (the Batch 35 DeleteFlowDialog) are the classic calls, unchanged.
 */
export function ChatFlowsV2({
  organizationId,
  createOpen,
  onCreateOpenChange,
}: {
  organizationId: string;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const { can } = usePermissions();
  const canEdit = can("flows_v2.edit");
  const canViewResponses = can("contacts.view");
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [counts, setCounts] = useState<Record<string, FlowResponseCount>>({});
  const [published, setPublished] = useState<Set<string> | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [triggers, setTriggers] = useState<TriggerRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [deleted, setDeleted] = useState<Row[]>([]);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const historyRef = useRef<HTMLElement>(null);

  const showHistory = (id: string) => {
    setHistoryFor(id);
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    requestAnimationFrame(() => historyRef.current?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" }));
  };

  const load = useCallback(async () => {
    const { data, error: e } = await aidwar.from("flows").select("id, name, is_enabled, updated_at, config").eq("organization_id", organizationId).like("key", "v2:%").order("updated_at", { ascending: false });
    if (e) {
      setError(true);
      return;
    }
    const all = (data ?? []) as Row[];
    const list = all.filter((r) => !flowDeletedAt(r));
    setDeleted(all.filter((r) => flowDeletedAt(r) && restoreDaysLeft(r) > 0));
    setRows(list);
    const ids = list.map((r) => r.id);
    if (!ids.length) return;
    // Published and draft versions (their graphs draw the mini map); a failed read leaves the map empty.
    void Promise.resolve(
      aidwar.from("flow_versions").select("flow_id, status, version, graph").eq("organization_id", organizationId).in("status", ["published", "draft"]).in("flow_id", ids),
    ).then(({ data: vers, error: ve }) => {
      if (ve) return;
      const v = (vers ?? []) as Version[];
      setVersions(v);
      setPublished(new Set(v.filter((x) => x.status === "published").map((x) => x.flow_id)));
    }, () => {});
    void Promise.resolve(
      aidwar.from("flow_triggers").select("flow_id, kind, config, is_enabled").eq("organization_id", organizationId).in("flow_id", ids),
    ).then(({ data: trig }) => setTriggers((trig ?? []) as TriggerRow[]), () => {});
    void loadResponseCounts(organizationId, ids).then(setCounts).catch(() => {});
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (rows?.length && (!historyFor || !rows.some((r) => r.id === historyFor))) setHistoryFor(rows[0]!.id);
  }, [rows, historyFor]);

  const restore = async (row: Row) => {
    setBusy(true);
    const { error: e } = await callApi("/api/flows/v2", { body: { action: "restore_flow", organization_id: organizationId, flow_id: row.id } });
    setBusy(false);
    if (e) {
      toast.error(e);
      return;
    }
    toast.success(`“${row.name}” is back. Publish it again if it was off.`);
    void load();
  };

  const create = async (key: string) => {
    const s = STARTERS.find((x) => x.key === key)!;
    setBusy(true);
    const { data, error: e } = await callApi<{ flow_id: string }>("/api/flows/v2", { body: { action: "create", organization_id: organizationId, name: s.name, graph: s.graph() } });
    setBusy(false);
    if (e || !data) {
      toast.error(e ?? "Couldn't create the flow.");
      return;
    }
    void navigate({ to: "/app/flows/v2/$id", params: { id: data.flow_id } });
  };

  if (error) return <ErrorState message="We couldn't load your chat flows. Refresh to try again." />;
  if (!rows) {
    return (
      <div className="grid gap-4 wide:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="h-64 animate-pulse rounded-[20px] bg-bubble-in motion-reduce:animate-none" />
        ))}
      </div>
    );
  }

  const history = rows.find((r) => r.id === historyFor) ?? null;

  return (
    <div className="flex flex-col gap-8">
      {deleted.length > 0 || showDeleted ? (
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setShowDeleted((v) => !v)}>
            {showDeleted ? "Back to your flows" : `Deleted flows (${deleted.length})`}
          </Button>
        </div>
      ) : null}

      {showDeleted ? (
        deleted.length === 0 ? (
          <EmptyState icon={Trash2} title="No deleted flows" description="Flows you delete stay here for 30 days, then they're gone." />
        ) : (
          <ul className="m-0 flex list-none flex-col rounded-[20px] border border-line bg-surface p-0 shadow-md" data-testid="deleted-flows">
            {deleted.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 border-b border-line px-4 py-3.5 last:border-b-0">
                <span className="min-w-0">
                  <span className="block truncate font-semibold">{r.name}</span>
                  <span className="block text-sm text-muted-foreground">
                    Deleted {relativeTime(flowDeletedAt(r)!)}, {restoreDaysLeft(r)} day{restoreDaysLeft(r) === 1 ? "" : "s"} left to restore
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
        <EmptyState
          icon={Workflow}
          title="No chat flows yet"
          description="Build menus, questions and hand-offs that run on their own, no AI needed."
          action={canEdit ? <Button onClick={() => onCreateOpenChange(true)}>Create your first flow</Button> : undefined}
        />
      ) : (
        <>
          <ul className="m-0 grid list-none gap-4 p-0 wide:grid-cols-2">
            {rows.map((r) => {
              const graph = graphForCard(versions, r.id);
              const status = flowStatus(r.is_enabled, published ? published.has(r.id) : null);
              const steps = (graph?.nodes ?? []).filter((n) => n.type !== "start" && n.type !== "note").length;
              return (
                <li key={r.id} className="flex flex-col gap-3.5 rounded-[20px] border border-line bg-surface p-4 shadow-md">
                  <Link
                    to="/app/flows/v2/$id"
                    params={{ id: r.id }}
                    className="group flex flex-col gap-3.5 rounded-[14px] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-aiden"
                  >
                    <FlowThumbnail graph={graph} className="transition-[border-color] duration-200 group-hover:border-aiden" />
                    <span className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block truncate font-display text-[1.125rem] font-semibold text-foreground">{r.name}</span>
                        <span className="block text-sm text-muted-foreground">
                          {steps} step{steps === 1 ? "" : "s"}, changed {relativeTime(r.updated_at)}
                        </span>
                      </span>
                      <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-[13px] font-semibold", STATUS_TONE[status])}>{status}</span>
                    </span>
                  </Link>
                  <dl className="m-0 grid gap-1 text-sm">
                    <div className="flex gap-1.5">
                      <dt className="sr-only">Trigger</dt>
                      <dd className="m-0 min-w-0 truncate text-foreground">{triggersLine(triggers.filter((t) => t.flow_id === r.id))}</dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt className="sr-only">Runs</dt>
                      <dd className="m-0 text-muted-foreground">{counts[r.id] ? responsesLine(counts[r.id]!, relativeTime).replace(" · ", ", ") : "Counting runs…"}</dd>
                    </div>
                  </dl>
                  <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                    <Button asChild size="sm">
                      <Link to="/app/flows/v2/$id" params={{ id: r.id }}>
                        {canEdit ? "Open builder" : "Open"}
                      </Link>
                    </Button>
                    <Button
                      size="sm"
                      variant={historyFor === r.id ? "soft" : "outline"}
                      aria-pressed={historyFor === r.id}
                      onClick={() => showHistory(r.id)}
                    >
                      Run history
                    </Button>
                    {canViewResponses ? (
                      <Button asChild size="sm" variant="ghost">
                        <Link to="/app/flows/v2/$id" params={{ id: r.id }} search={{ view: "responses" }}>
                          <Table2 className="mr-1 h-3.5 w-3.5" aria-hidden="true" /> Responses
                        </Link>
                      </Button>
                    ) : null}
                    {canEdit ? (
                      <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={`Delete ${r.name}`} title="Delete flow" onClick={() => setDeleting(r)}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          {history ? (
            <section ref={historyRef} aria-labelledby="run-history-heading" className="flex scroll-mt-24 flex-col gap-3">
              <div>
                <h2 id="run-history-heading" className="m-0 font-display text-[1.25rem] font-semibold">
                  Run history: {history.name}
                </h2>
                <p className="m-0 mt-1 text-sm text-muted-foreground">
                  The last 10 customers who went through this flow, step by step. Pick another flow&rsquo;s Run history to switch.
                </p>
              </div>
              <RunTimeline organizationId={organizationId} flowId={history.id} flowName={history.name} />
            </section>
          ) : null}
        </>
      )}

      <DeleteFlowDialog
        organizationId={organizationId}
        flow={deleting}
        open={Boolean(deleting)}
        onOpenChange={(v) => {
          if (!v) setDeleting(null);
        }}
        onDeleted={() => {
          setDeleting(null);
          void load();
        }}
      />
      <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Start from a template</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            {STARTERS.map((s) => (
              <button
                key={s.key}
                type="button"
                disabled={busy}
                onClick={() => void create(s.key)}
                className="rounded-[14px] border border-line p-4 text-left transition-[border-color,box-shadow] duration-200 hover:border-aiden hover:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden disabled:opacity-60"
              >
                <p className="m-0 font-semibold">{s.name}</p>
                <p className="m-0 text-sm text-muted-foreground">{s.description}</p>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function NewChatFlowButton({ onClick }: { onClick: () => void }) {
  return (
    <Button onClick={onClick}>
      <Plus className="mr-1 h-4 w-4" aria-hidden="true" /> New chat flow
    </Button>
  );
}
