import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, Settings2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { usePermissions } from "@/hooks/use-permissions";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { PermissionGate } from "@/components/permission-gate";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  MESSAGE_CLASS_CLASSES,
  MESSAGE_CLASS_LABELS,
  enableBlocker,
  messageClassOf,
  type FlowRow,
  type FlowStepRow,
  type TemplateLite,
} from "@/lib/flows";
import { NUMBER_COLUMNS, type WhatsAppNumber } from "@/lib/whatsapp-numbers";

type Summary = { sent: number; cancelled: number; skipped: number; scheduled: number };

const EMPTY: Summary = { sent: 0, cancelled: 0, skipped: 0, scheduled: 0 };

export function FlowsView({
  organizationId,
  onLoaded,
}: {
  organizationId: string;
  onLoaded?: (flows: FlowRow[]) => void;
}) {
  const { can } = usePermissions();
  const canManage = can("flows.manage");

  const [flows, setFlows] = useState<FlowRow[] | null>(null);
  const [steps, setSteps] = useState<FlowStepRow[]>([]);
  const [templates, setTemplates] = useState<TemplateLite[]>([]);
  const [numbers, setNumbers] = useState<WhatsAppNumber[]>([]);
  const [summary, setSummary] = useState<Record<string, Summary>>({});
  const [unknownContacts, setUnknownContacts] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const [flowRes, tplRes, numRes, sendRes, unknownRes] = await Promise.all([
      aidwar
        .from("flows")
        .select("id, organization_id, key, name, is_enabled, whatsapp_account_id, config")
        .eq("organization_id", organizationId)
        .order("key"),
      aidwar
        .from("message_templates")
        .select("id, name, language, status, waba_id")
        .eq("organization_id", organizationId),
      aidwar.from("whatsapp_accounts").select(NUMBER_COLUMNS).eq("organization_id", organizationId),
      aidwar
        .from("scheduled_sends")
        .select("flow_id, status")
        .eq("organization_id", organizationId)
        .gte("updated_at", since)
        .limit(5000),
      aidwar
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("opt_in_status", "unknown"),
    ]);

    if (flowRes.error) {
      setError("We couldn't load your flows. Please try again.");
      setFlows([]);
      return;
    }
    const flowRows = (flowRes.data as FlowRow[]) ?? [];
    setFlows(flowRows);
    onLoaded?.(flowRows);
    setTemplates((tplRes.data as TemplateLite[]) ?? []);
    setNumbers((numRes.data as unknown as WhatsAppNumber[]) ?? []);
    setUnknownContacts(unknownRes.count ?? 0);

    const map: Record<string, Summary> = {};
    for (const row of ((sendRes.data as { flow_id: string; status: keyof Summary }[]) ?? [])) {
      const bucket = (map[row.flow_id] ??= { ...EMPTY });
      if (row.status in bucket) bucket[row.status] += 1;
    }
    setSummary(map);

    if (flowRows.length) {
      const { data: stepRows } = await aidwar
        .from("flow_steps")
        .select("id, flow_id, step_order, delay_minutes, template_id, condition, is_enabled")
        .in("flow_id", flowRows.map((f) => f.id))
        .order("step_order");
      setSteps((stepRows as FlowStepRow[]) ?? []);
    } else {
      setSteps([]);
    }
  }, [organizationId, onLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  const wabaFor = useCallback(
    (flow: FlowRow) => {
      const acct = flow.whatsapp_account_id
        ? numbers.find((n) => n.id === flow.whatsapp_account_id)
        : (numbers.find((n) => n.is_default) ?? numbers[0]);
      return acct?.waba_id ?? null;
    },
    [numbers],
  );

  const marketingUnreachable = useMemo(
    () =>
      (flows ?? []).some((f) => f.is_enabled && messageClassOf(f) === "marketing") &&
      (unknownContacts ?? 0) > 0,
    [flows, unknownContacts],
  );

  async function toggle(flow: FlowRow, next: boolean) {
    if (next) {
      const waba = wabaFor(flow);
      const usable = templates.filter((t) => !waba || !t.waba_id || t.waba_id === waba);
      const blocker = enableBlocker(
        flow,
        steps.filter((s) => s.flow_id === flow.id),
        usable,
      );
      if (blocker) {
        toast.error(`${flow.name} can't be switched on yet`, { description: blocker });
        return;
      }
    }
    setFlows((prev) => (prev ?? []).map((f) => (f.id === flow.id ? { ...f, is_enabled: next } : f)));
    const { error: err } = await aidwar
      .from("flows")
      .update({ is_enabled: next })
      .eq("id", flow.id);
    if (err) {
      toast.error("We couldn't change this flow. Please try again.");
      void load();
      return;
    }
    void logActivity("flow_toggled", organizationId, { flow: flow.key, is_enabled: next });
    toast.success(next ? `${flow.name} is live.` : `${flow.name} paused.`);
  }

  if (error) return <ErrorState message={error} />;

  if (flows === null) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    );
  }

  if (flows.length === 0) {
    return (
      <EmptyState
        icon={Workflow}
        title="No flows yet"
        description="Flows turn store events into messages — an abandoned checkout nudge, an order confirmation. They appear here the moment your workspace is set up."
      />
    );
  }

  return (
    <div className="space-y-4">
      {marketingUnreachable ? (
        <ReachabilityWarning count={unknownContacts ?? 0} />
      ) : null}

      <div className="grid gap-4">
        {flows.map((flow) => {
          const cls = messageClassOf(flow);
          const stat = summary[flow.id] ?? EMPTY;
          const flowSteps = steps.filter((s) => s.flow_id === flow.id);
          return (
            <div
              key={flow.id}
              className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-all duration-200 hover:shadow-md sm:p-6"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-semibold text-foreground">{flow.name}</h3>
                    <span
                      className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${MESSAGE_CLASS_CLASSES[cls]}`}
                    >
                      {MESSAGE_CLASS_LABELS[cls]}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {flowSteps.filter((s) => s.is_enabled).length} of {flowSteps.length} steps
                    enabled · {flow.is_enabled ? "Live" : "Paused"}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <PermissionGate
                    allowed={canManage}
                    reason='You need the "Manage flows" permission to switch a flow on or off.'
                  >
                    <Switch
                      checked={flow.is_enabled}
                      onCheckedChange={(v) => void toggle(flow, v)}
                      aria-label={`Enable ${flow.name}`}
                    />
                  </PermissionGate>
                  <Button asChild variant="outline" size="sm" className="rounded-full">
                    <Link to="/app/flows/$id" params={{ id: flow.id }}>
                      Open <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Sent · 7 days" value={stat.sent} tone="good" />
                <Stat label="Scheduled" value={stat.scheduled} />
                <Stat label="Skipped · 7 days" value={stat.skipped} tone="warn" />
                <Stat label="Cancelled · 7 days" value={stat.cancelled} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between rounded-2xl border border-border/70 bg-muted/30 px-5 py-4">
        <div className="flex items-start gap-3">
          <Settings2 className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Quiet hours, timezone and marketing frequency caps live in Settings → Sending.
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="rounded-full">
          <Link to="/app/settings">Open sending settings</Link>
        </Button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "good" | "warn";
}) {
  const toneClass =
    tone === "good" ? "text-emerald-600 dark:text-emerald-400" : tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-foreground";
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
      <p className={`text-xl font-bold tracking-tight ${toneClass}`}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

/**
 * Contacts synced from a store arrive without a marketing opt-in, so a
 * merchant's marketing flow reaches far fewer people than their contact count
 * suggests. Saying so up front prevents "why did only 40 send?".
 */
export function ReachabilityWarning({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/5 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <p className="text-sm font-semibold text-foreground">
            {count.toLocaleString()} contacts can't receive marketing messages
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Their opt-in status is still unknown — contacts synced from your store arrive that way.
            Marketing flows skip them with the reason “no marketing opt-in”. Transactional flows
            still reach them.
          </p>
        </div>
      </div>
      <Button asChild variant="outline" size="sm" className="shrink-0 rounded-full">
        <Link to="/app/contacts" search={{ opt_in: "unknown" }}>
          Review contacts
        </Link>
      </Button>
    </div>
  );
}
