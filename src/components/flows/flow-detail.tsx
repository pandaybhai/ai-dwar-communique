import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Clock, Loader2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { usePermissions } from "@/hooks/use-permissions";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { PermissionGate } from "@/components/permission-gate";
import { SendsLog } from "@/components/flows/sends-log";
import { ReachabilityWarning } from "@/components/flows/flows-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MESSAGE_CLASS_CLASSES,
  MESSAGE_CLASS_LABELS,
  enableBlocker,
  formatDelay,
  messageClassOf,
  stepLabel,
  type FlowRow,
  type FlowStepRow,
  type TemplateLite,
} from "@/lib/flows";
import { NUMBER_COLUMNS, numberLabel, type WhatsAppNumber } from "@/lib/whatsapp-numbers";

const NO_TEMPLATE = "__none__";

export function FlowDetail({
  flowId,
  organizationId,
  timezone,
}: {
  flowId: string;
  organizationId: string;
  timezone: string;
}) {
  const { can } = usePermissions();
  const canManage = can("flows.manage");

  const [flow, setFlow] = useState<FlowRow | null>(null);
  const [steps, setSteps] = useState<FlowStepRow[]>([]);
  const [templates, setTemplates] = useState<TemplateLite[]>([]);
  const [numbers, setNumbers] = useState<WhatsAppNumber[]>([]);
  const [unknownContacts, setUnknownContacts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [flowRes, stepRes, tplRes, numRes, unknownRes] = await Promise.all([
      aidwar
        .from("flows")
        .select("id, organization_id, key, name, is_enabled, whatsapp_account_id, config")
        .eq("id", flowId)
        .maybeSingle(),
      aidwar
        .from("flow_steps")
        .select("id, flow_id, step_order, delay_minutes, template_id, condition, is_enabled")
        .eq("flow_id", flowId)
        .order("step_order"),
      aidwar
        .from("message_templates")
        .select("id, name, language, status, waba_id")
        .eq("organization_id", organizationId)
        .order("name"),
      aidwar.from("whatsapp_accounts").select(NUMBER_COLUMNS).eq("organization_id", organizationId),
      aidwar
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("opt_in_status", "unknown"),
    ]);
    setLoading(false);
    if (flowRes.error || !flowRes.data) {
      setError("We couldn't find this flow. It may have been removed.");
      return;
    }
    setFlow(flowRes.data as FlowRow);
    setSteps((stepRes.data as FlowStepRow[]) ?? []);
    setTemplates((tplRes.data as TemplateLite[]) ?? []);
    setNumbers((numRes.data as unknown as WhatsAppNumber[]) ?? []);
    setUnknownContacts(unknownRes.count ?? 0);
  }, [flowId, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const account = useMemo(() => {
    if (!flow) return null;
    return (
      (flow.whatsapp_account_id ? numbers.find((n) => n.id === flow.whatsapp_account_id) : null) ??
      numbers.find((n) => n.is_default) ??
      numbers[0] ??
      null
    );
  }, [flow, numbers]);

  /** Only templates approved on the number this flow sends from. */
  const usableTemplates = useMemo(() => {
    const waba = account?.waba_id ?? null;
    return templates.filter(
      (t) => (!waba || !t.waba_id || t.waba_id === waba) && t.status.toUpperCase() === "APPROVED",
    );
  }, [templates, account]);

  const selectableTemplates = useMemo(() => {
    const waba = account?.waba_id ?? null;
    return templates.filter((t) => !waba || !t.waba_id || t.waba_id === waba);
  }, [templates, account]);

  const blocker = flow ? enableBlocker(flow, steps, usableTemplates) : null;

  async function updateStep(step: FlowStepRow, patch: Partial<FlowStepRow>) {
    setSteps((prev) => prev.map((s) => (s.id === step.id ? { ...s, ...patch } : s)));
    const { error: err } = await aidwar.from("flow_steps").update(patch).eq("id", step.id);
    if (err) {
      toast.error("We couldn't save this step. Please try again.");
      void load();
      return;
    }
    void logActivity("flow_step_updated", organizationId, {
      flow: flow?.key,
      step_order: step.step_order,
      fields: Object.keys(patch),
    });
  }

  async function toggleFlow(next: boolean) {
    if (!flow) return;
    if (next && blocker) {
      toast.error(`${flow.name} can't be switched on yet`, { description: blocker });
      return;
    }
    setFlow({ ...flow, is_enabled: next });
    const { error: err } = await aidwar.from("flows").update({ is_enabled: next }).eq("id", flow.id);
    if (err) {
      toast.error("We couldn't change this flow. Please try again.");
      void load();
      return;
    }
    void logActivity("flow_toggled", organizationId, { flow: flow.key, is_enabled: next });
    toast.success(next ? `${flow.name} is live.` : `${flow.name} paused.`);
  }

  async function setAccount(accountId: string) {
    if (!flow) return;
    const next = accountId === NO_TEMPLATE ? null : accountId;
    setFlow({ ...flow, whatsapp_account_id: next });
    const { error: err } = await aidwar
      .from("flows")
      .update({ whatsapp_account_id: next })
      .eq("id", flow.id);
    if (err) {
      toast.error("We couldn't change the sending number.");
      void load();
      return;
    }
    void logActivity("flow_step_updated", organizationId, {
      flow: flow.key,
      fields: ["whatsapp_account_id"],
    });
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64 rounded-xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
      </div>
    );
  }
  if (error) return <ErrorState message={error} />;
  if (!flow) {
    return (
      <EmptyState
        icon={Workflow}
        title="Flow not found"
        description="This flow no longer exists in this workspace."
      />
    );
  }

  const cls = messageClassOf(flow);

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 rounded-full">
          <Link to="/app/flows">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" /> All flows
          </Link>
        </Button>
      </div>

      <div className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-6">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-foreground">{flow.name}</h1>
            <span
              className={`inline-flex rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${MESSAGE_CLASS_CLASSES[cls]}`}
            >
              {MESSAGE_CLASS_LABELS[cls]}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {flow.is_enabled ? "Live" : "Paused"}
            {account ? ` · sending from ${numberLabel(account)}` : " · no number connected yet"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{flow.is_enabled ? "On" : "Off"}</span>
          <PermissionGate
            allowed={canManage}
            reason='You need the "Manage flows" permission to switch a flow on or off.'
          >
            <Switch
              checked={flow.is_enabled}
              onCheckedChange={(v) => void toggleFlow(v)}
              aria-label="Enable flow"
            />
          </PermissionGate>
        </div>
      </div>

      {!flow.is_enabled && blocker ? (
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/5 p-5 text-sm text-foreground">
          <span className="font-semibold">Can't switch this flow on yet.</span> {blocker}
        </div>
      ) : null}

      {flow.is_enabled && cls === "marketing" ? (
        <ReachabilityWarning count={unknownContacts} />
      ) : null}

      <Tabs defaultValue="steps">
        <TabsList className="mb-6">
          <TabsTrigger value="steps">Steps</TabsTrigger>
          <TabsTrigger value="log">Sends log</TabsTrigger>
        </TabsList>

        <TabsContent value="steps" className="space-y-4">
          {numbers.length > 1 ? (
            <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
              <Label className="text-sm font-semibold">Sending number</Label>
              <p className="mt-1 text-sm text-muted-foreground">
                Templates below are the ones approved on this number.
              </p>
              <div className="mt-3 max-w-sm">
                <Select
                  value={flow.whatsapp_account_id ?? NO_TEMPLATE}
                  onValueChange={(v) => void setAccount(v)}
                  disabled={!canManage}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Default number" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEMPLATE}>Default number</SelectItem>
                    {numbers.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {numberLabel(n)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}

          {steps.length === 0 ? (
            <EmptyState
              icon={Workflow}
              title="This flow has no steps"
              description="Steps are created with the flow. If none appear, your workspace setup is incomplete — reach out to support."
            />
          ) : (
            steps.map((step) => (
              <StepCard
                key={step.id}
                flowKey={flow.key}
                step={step}
                templates={selectableTemplates}
                canManage={canManage}
                onChange={(patch) => void updateStep(step, patch)}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="log">
          <SendsLog organizationId={organizationId} flowId={flow.id} timezone={timezone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function StepCard({
  flowKey,
  step,
  templates,
  canManage,
  onChange,
}: {
  flowKey: string;
  step: FlowStepRow;
  templates: TemplateLite[];
  canManage: boolean;
  onChange: (patch: Partial<FlowStepRow>) => void;
}) {
  const [delay, setDelay] = useState(String(step.delay_minutes));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDelay(String(step.delay_minutes));
  }, [step.delay_minutes]);

  function commitDelay() {
    const next = Number(delay);
    if (!Number.isFinite(next) || next < 0) {
      toast.error("Delay must be zero or more minutes.");
      setDelay(String(step.delay_minutes));
      return;
    }
    if (next === step.delay_minutes) return;
    setSaving(true);
    onChange({ delay_minutes: Math.round(next) });
    setTimeout(() => setSaving(false), 400);
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">
            {stepLabel(flowKey, step)}
          </h3>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
            <Clock className="h-3.5 w-3.5" /> {formatDelay(step.delay_minutes)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            {step.is_enabled ? "Enabled" : "Disabled"}
          </span>
          <PermissionGate
            allowed={canManage}
            reason='You need the "Manage flows" permission to change steps.'
          >
            <Switch
              checked={step.is_enabled}
              onCheckedChange={(v) => onChange({ is_enabled: v })}
              aria-label={`Enable ${stepLabel(flowKey, step)}`}
            />
          </PermissionGate>
        </div>
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={`tpl-${step.id}`}>Template</Label>
          <Select
            value={step.template_id ?? NO_TEMPLATE}
            onValueChange={(v) => onChange({ template_id: v === NO_TEMPLATE ? null : v })}
            disabled={!canManage}
          >
            <SelectTrigger id={`tpl-${step.id}`}>
              <SelectValue placeholder="Choose a template" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_TEMPLATE}>No template selected</SelectItem>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name} · {t.language}
                  {t.status.toUpperCase() === "APPROVED" ? "" : ` (${t.status.toLowerCase()})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {templates.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No templates on this number yet — create one under Templates first.
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor={`delay-${step.id}`}>Delay (minutes)</Label>
          <div className="flex items-center gap-2">
            <Input
              id={`delay-${step.id}`}
              type="number"
              min={0}
              value={delay}
              disabled={!canManage}
              onChange={(e) => setDelay(e.target.value)}
              onBlur={commitDelay}
            />
            {saving ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Counted from the moment the flow is triggered. Quiet hours can push a send later.
          </p>
        </div>
      </div>
    </div>
  );
}
