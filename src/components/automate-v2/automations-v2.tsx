import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  Clock,
  Lock,
  MessageSquareReply,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Workflow,
} from "lucide-react";
import { toast } from "sonner";
import { AutomationDrawer } from "@/components/automations/automation-drawer";
import { StickyAction, WhatsAppBubble } from "@/components/design-v2";
import { EmptyState, ErrorState, PageHeader, PageSkeleton } from "@/components/empty-state";
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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { usePermissions } from "@/hooks/use-permissions";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import {
  describeConfig,
  normalizeConfig,
  type AutomationRow,
  type TriggerType,
} from "@/lib/automations";
import { formatDate } from "@/lib/contacts";
import { useOrg } from "@/lib/org-context";
import { cn } from "@/lib/utils";
import { automationsCopy as t } from "./copy";

const GROUPS: Array<{ type: TriggerType; title: string; line: string; icon: typeof Sparkles }> = [
  { type: "welcome", ...t.groups.welcome, icon: Sparkles },
  { type: "keyword", ...t.groups.keyword, icon: MessageSquareReply },
  { type: "away", ...t.groups.away, icon: Clock },
];

/**
 * Batch 49: Automate > Automations in the new design. The classic
 * AutomationsView's reads (automations by priority, the latest sent run per
 * automation) and its writes, line for line: the on/off switch (update
 * is_active + updated_at, logged as automation_toggled), delete (logged as
 * automation_deleted) and the AutomationDrawer for new and edit. Drawn by
 * kind, each with the reply the customer gets.
 */
export function NewAutomationsPage() {
  const { enabled, loading } = useFeatureFlag("automations");
  const { active } = useOrg();
  const { can } = usePermissions();
  const organizationId = active?.organization.id ?? null;
  const description = t.description;

  if (loading || !active || !organizationId) return <PageSkeleton />;
  if (!enabled) {
    return (
      <>
        <PageHeader title={t.title} description={description} />
        <EmptyState icon={Lock} title={t.notOn.title} description={t.notOn.description} />
      </>
    );
  }
  return (
    <>
      <PageHeader title={t.title} description={description} />
      <AutomationsV2 organizationId={organizationId} canManage={can("automations.manage")} />
    </>
  );
}

export function AutomationsV2({
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
      setError(t.loadError);
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
    for (const run of (runs as { automation_id: string; created_at: string }[]) ?? []) {
      if (!map[run.automation_id]) map[run.automation_id] = run.created_at;
    }
    setLastFired(map);
  }, [organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(row: AutomationRow, next: boolean) {
    setRows((prev) => (prev ?? []).map((r) => (r.id === row.id ? { ...r, is_active: next } : r)));
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

  const openNew = () => {
    setEditing(null);
    setDrawerOpen(true);
  };

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (rows === null) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true" aria-label={t.loading}>
        <Skeleton className="ml-auto h-[39px] w-44 rounded-[11px]" />
        <div className="grid gap-3 wide:grid-cols-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-44 rounded-[18px]" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex justify-end">
        {canManage ? (
          <StickyAction>
            <Button className="phone:h-11" onClick={openNew}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              {t.newAutomation}
            </Button>
          </StickyAction>
        ) : (
          <Button disabled onClick={openNew}>
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            {t.newAutomation}
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title={t.empty.title}
          description={t.empty.description}
          action={
            <Button className="phone:h-11" disabled={!canManage} onClick={openNew}>
              <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
              {t.empty.action}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-10">
          {GROUPS.map((g, gi) => {
            const mine = rows.filter((r) => r.trigger_type === g.type);
            if (!mine.length) return null;
            return (
              <section
                key={g.type}
                aria-labelledby={`auto-${g.type}`}
                style={{ "--d": gi } as CSSProperties}
                className="nd-rise flex flex-col gap-3"
              >
                <div className="flex items-center gap-3">
                  <span
                    aria-hidden="true"
                    className="grid h-9 w-9 place-items-center rounded-full bg-aiden-soft text-aiden-deep"
                  >
                    <g.icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <h2
                      id={`auto-${g.type}`}
                      className="m-0 font-display text-[1.25rem] font-semibold"
                    >
                      {g.title}
                    </h2>
                    <p className="m-0 text-sm text-muted-foreground">{g.line}</p>
                  </div>
                </div>
                <ul className="m-0 grid list-none gap-3 p-0 wide:grid-cols-2">
                  {mine.map((row) => (
                    <li
                      key={row.id}
                      className="flex flex-col gap-3 rounded-[18px] border border-line bg-surface p-4 shadow-md"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => {
                              setEditing(row);
                              setDrawerOpen(true);
                            }}
                            className="block max-w-full truncate rounded-md text-left text-body font-semibold text-foreground transition-[color] duration-200 hover:text-aiden-deep phone:py-2.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aiden"
                          >
                            {row.name}
                          </button>
                          <p className="m-0 text-sm text-muted-foreground">
                            {describeConfig(row).replace(" · ", ", ")}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <span
                            className={cn(
                              "text-[13px] font-semibold",
                              row.is_active ? "text-aiden-deep" : "text-muted-foreground",
                            )}
                          >
                            {row.is_active ? t.on : t.off}
                          </span>
                          <Switch
                            checked={row.is_active}
                            disabled={!canManage}
                            onCheckedChange={(v) => void toggle(row, v)}
                            aria-label={t.switchLabel(row.is_active, row.name)}
                          />
                        </div>
                      </div>
                      {row.message_body?.trim() ? (
                        <div className="nd-wall flex flex-col rounded-[14px] p-3">
                          <WhatsAppBubble
                            from="out"
                            sender={t.replyLabel}
                            className="text-sm wide:max-w-[85%]"
                          >
                            <span className="whitespace-pre-wrap">{row.message_body}</span>
                          </WhatsAppBubble>
                        </div>
                      ) : null}
                      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                        <p className="m-0 text-sm text-muted-foreground">
                          {lastFired[row.id]
                            ? t.lastSent(formatDate(lastFired[row.id]!))
                            : t.notSent}
                          {t.priority(row.priority)}
                        </p>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="phone:h-11 phone:w-11"
                            onClick={() => {
                              setEditing(row);
                              setDrawerOpen(true);
                            }}
                            aria-label={t.edit(row.name)}
                          >
                            <Pencil className="h-4 w-4" aria-hidden="true" />
                          </Button>
                          {canManage ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="phone:h-11 phone:w-11"
                              onClick={() => setPendingDelete(row)}
                              aria-label={t.delete(row.name)}
                            >
                              <Trash2
                                className="h-4 w-4 text-muted-foreground"
                                aria-hidden="true"
                              />
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      {/* Batch 57: room under the list for the pinned New automation button on a phone. */}
      {canManage ? <div aria-hidden="true" className="hidden h-16 phone:block" /> : null}

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
            <AlertDialogTitle>{t.confirm.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {t.confirm.body(pendingDelete?.name ?? "")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.confirm.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>
              {t.confirm.delete}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
