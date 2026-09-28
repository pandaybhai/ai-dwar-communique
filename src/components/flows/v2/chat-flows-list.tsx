import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Plus, Workflow } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { callApi } from "@/lib/whatsapp-client";
import { usePermissions } from "@/hooks/use-permissions";
import { STARTERS } from "@/lib/flow-starters";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Row = { id: string; name: string; is_enabled: boolean; updated_at: string };

export function ChatFlowsList({ organizationId }: { organizationId: string }) {
  const { can } = usePermissions();
  const canEdit = can("ai.configure");
  const navigate = useNavigate();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error: e } = await aidwar.from("flows").select("id, name, is_enabled, updated_at").eq("organization_id", organizationId).like("key", "v2:%").order("updated_at", { ascending: false });
    if (e) { setError(true); return; }
    setRows((data ?? []) as Row[]);
  }, [organizationId]);
  useEffect(() => { void load(); }, [load]);

  const create = async (key: string) => {
    const s = STARTERS.find((x) => x.key === key)!;
    setBusy(true);
    const { data, error: e } = await callApi<{ flow_id: string }>("/api/flows/v2", { body: { action: "create", organization_id: organizationId, name: s.name, graph: s.graph() } });
    setBusy(false);
    if (e || !data) { toast.error(e ?? "Couldn't create the flow."); return; }
    void navigate({ to: "/app/flows/v2/$id", params: { id: data.flow_id } });
  };

  if (error) return <ErrorState title="Couldn't load chat flows" description="Please try again." onRetry={() => void load()} />;
  if (!rows) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}</div>;

  return (
    <div className="space-y-4">
      {canEdit && <div className="flex justify-end"><Button onClick={() => setOpen(true)}><Plus className="mr-1 h-4 w-4" /> New chat flow</Button></div>}
      {rows.length === 0 ? (
        <EmptyState icon={Workflow} title="No chat flows yet" description="Build menus, questions and hand-offs that run on their own — no AI needed." action={canEdit ? { label: "Create your first flow", onClick: () => setOpen(true) } : undefined} />
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
          {rows.map((r) => (
            <li key={r.id}>
              <Link to="/app/flows/v2/$id" params={{ id: r.id }} className="flex items-center justify-between px-4 py-3 transition hover:bg-muted/50">
                <span className="font-medium">{r.name}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${r.is_enabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}>{r.is_enabled ? "Published" : "Draft"}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
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
