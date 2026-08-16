import { useCallback, useEffect, useState } from "react";
import { Clock, MessageSquareReply, Pencil, Plus, Sparkles, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { formatDate } from "@/lib/contacts";
import {
  TRIGGER_LABELS,
  describeConfig,
  normalizeConfig,
  type AutomationRow,
  type TriggerType,
} from "@/lib/automations";
import { AutomationDrawer } from "@/components/automations/automation-drawer";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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

const TRIGGER_ICONS: Record<TriggerType, typeof Sparkles> = {
  welcome: Sparkles,
  keyword: MessageSquareReply,
  away: Clock,
};

export function AutomationsView({
  organizationId,
  canManage,
}: {
  organizationId: string;
  canManage: boolean;
}) {
  const [rows, setRows] = useState<AutomationRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFired, setLastFired] = useState<Record<string, string>>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<AutomationRow | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AutomationRow | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const { data, error: qErr } = await aidwar
      .from("automations")
      .select("*")
      .eq("organization_id", organizationId)
      .order("priority", { ascending: true })
      .order("created_at", { ascending: true });
    if (qErr) {
      setError("We couldn't load your automations. Please try again.");
      setRows([]);
      return;
    }
    const list = ((data as AutomationRow[]) ?? []).map((r) => ({
      ...r,
      config: normalizeConfig(r.trigger_type, r.config),
    }));
    setRows(list);

    const { data: runs } = await aidwar
      .from("automation_runs")
      .select("automation_id, created_at, status")
      .eq("organization_id", organizationId)
      .eq("status", "sent")
      .order("created_at", { ascending: false })
      .limit(200);
    const map: Record<string, string> = {};
    for (const run of ((runs as { automation_id: string; created_at: string }[]) ?? [])) {
      if (!map[run.automation_id]) map[run.automation_id] = run.created_at;
    }
    setLastFired(map);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(row: AutomationRow, next: boolean) {
    setRows((prev) =>
      (prev ?? []).map((r) => (r.id === row.id ? { ...r, is_active: next } : r)),
    );
    const { error: err } = await aidwar
      .from("automations")
      .update({ is_active: next, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    if (err) {
      toast.error("We couldn't update this automation.");
      void load();
      return;
    }
    void logActivity("automation_toggled", organizationId, { name: row.name, is_active: next });
    toast.success(next ? `${row.name} is live.` : `${row.name} paused.`);
  }

  async function confirmDelete() {
    const row = pendingDelete;
    if (!row) return;
    setPendingDelete(null);
    const { error: err } = await aidwar.from("automations").delete().eq("id", row.id);
    if (err) {
      toast.error("We couldn't delete this automation.");
      return;
    }
    void logActivity("automation_deleted", organizationId, { name: row.name });
    toast.success("Automation deleted.");
    void load();
  }

  if (error) return <ErrorState message={error} />;

  if (rows === null) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
        <Skeleton className="h-20 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex justify-end">
        <Button
          className="rounded-full"
          disabled={!canManage}
          onClick={() => {
            setEditing(null);
            setDrawerOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          New automation
        </Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No automations yet"
          description="Greet new customers, answer common questions by keyword and cover your off-hours — automatically."
          action={
            <Button
              className="rounded-full"
              disabled={!canManage}
              onClick={() => {
                setEditing(null);
                setDrawerOpen(true);
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              Create your first automation
            </Button>
          }
        />
      ) : (
        <ul className="space-y-3">
          {rows.map((row) => {
            const Icon = TRIGGER_ICONS[row.trigger_type] ?? Workflow;
            return (
              <li
                key={row.id}
                className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-all duration-200 hover:border-primary/30 hover:shadow-md sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-4">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(row);
                        setDrawerOpen(true);
                      }}
                      className="truncate text-left text-base font-semibold text-foreground transition-colors hover:text-primary"
                    >
                      {row.name}
                    </button>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      {TRIGGER_LABELS[row.trigger_type]} · {describeConfig(row)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {lastFired[row.id]
                        ? `Last fired ${formatDate(lastFired[row.id]!)}`
                        : "Never fired yet"}
                      {" · Priority "}
                      {row.priority}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 sm:gap-3">
                  <Switch
                    checked={row.is_active}
                    disabled={!canManage}
                    onCheckedChange={(v) => void toggle(row, v)}
                    aria-label={`${row.is_active ? "Pause" : "Activate"} ${row.name}`}
                  />
                  <span className="w-14 text-xs text-muted-foreground">
                    {row.is_active ? "Running" : "Paused"}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => {
                      setEditing(row);
                      setDrawerOpen(true);
                    }}
                    aria-label={`Edit ${row.name}`}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setPendingDelete(row)}
                      aria-label={`Delete ${row.name}`}
                    >
                      <Trash2 className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <AutomationDrawer
        open={drawerOpen}
        automation={editing}
        organizationId={organizationId}
        canManage={canManage}
        onClose={() => setDrawerOpen(false)}
        onSaved={() => void load()}
      />

      <AlertDialog open={Boolean(pendingDelete)} onOpenChange={(v) => !v && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this automation?</AlertDialogTitle>
            <AlertDialogDescription>
              “{pendingDelete?.name}” will stop replying immediately and its run history will be
              removed. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
