import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, CheckCircle2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { usePermissions } from "@/hooks/use-permissions";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { PermissionGate } from "@/components/permission-gate";
import { SendsLog } from "@/components/flows/sends-log";
import { ReachabilityWarning } from "@/components/flows/flows-view";
import { MessageBubble } from "@/components/flows/message-bubble";
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
  DELAY_CHOICES,
  MESSAGE_CLASS_CLASSES,
  MESSAGE_CLASS_HINTS,
  MESSAGE_CLASS_LABELS,
  enableBlocker,
  flowPromise,
  flowTitle,
  flowTrigger,
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
  const [announcement, setAnnouncement] = useState("");
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
        .select("id, name, language, status, waba_id, components")
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
      setError("We couldn't find this. It may have been removed.");
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

  /** Only messages approved on the number this flow sends from. */
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
      toast.error("We couldn't save that. Please try again.");
      void load();
      return;
    }
    setAnnouncement("Saved.");
    void logActivity("flow_step_updated", organizationId, {
      flow: flow?.key,
      step_order: step.step_order,
      fields: Object.keys(patch),
    });
  }

  async function toggleFlow(next: boolean) {
    if (!flow) return;
    const title = flowTitle(flow);
    if (next && blocker) {
      toast.error(`“${title}” can't be turned on yet`, { description: blocker });
      setAnnouncement(`${title} could not be turned on. ${blocker}`);
      return;
    }
    setFlow({ ...flow, is_enabled: next });
    const { error: err } = await aidwar.from("flows").update({ is_enabled: next }).eq("id", flow.id);
    if (err) {
      toast.error("We couldn't change this. Please try again.");
      void load();
      return;
    }
    void logActivity("flow_toggled", organizationId, { flow: flow.key, is_enabled: next });
    const msg = next ? `${title} is on. Messages will start going out.` : `${title} is off.`;
    toast.success(msg);
    setAnnouncement(msg);
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
      <div className="space-y-4" aria-busy="true">
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
        title="Not found"
        description="This no longer exists in your workspace."
      />
    );
  }

  const cls = messageClassOf(flow);
  const title = flowTitle(flow);

  return (
    <div className="space-y-6">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <Link
        to="/app/flows"
        className="-ml-2 inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Back to all flows
      </Link>

      <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">{title}</h1>
          <span
            className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${MESSAGE_CLASS_CLASSES[cls]}`}
          >
            {MESSAGE_CLASS_LABELS[cls]}
          </span>
        </div>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-foreground">
          {flowPromise(flow)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {MESSAGE_CLASS_HINTS[cls]}
          {account ? ` Sent from ${numberLabel(account)}.` : " No number connected yet."}
        </p>

        <div className="mt-4 rounded-xl border border-border/60 bg-muted/30 p-3">
          <label
            htmlFor="flow-toggle"
            className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-foreground"
          >
            <PermissionGate
              allowed={canManage}
              reason="Ask the shop owner to give you permission to turn flows on and off."
            >
              <Switch
                id="flow-toggle"
                checked={flow.is_enabled}
                onCheckedChange={(v) => void toggleFlow(v)}
              />
            </PermissionGate>
            <span>{flow.is_enabled ? "On — messages are going out" : "Off — nothing is sent"}</span>
          </label>
        </div>
      </div>

      {!flow.is_enabled && blocker ? (
        <div className="rounded-2xl border border-amber-600/40 bg-amber-500/5 p-5 text-sm text-foreground">
          <span className="font-semibold">You can't turn this on yet.</span> {blocker}
        </div>
      ) : null}

      {flow.is_enabled && cls === "marketing" ? (
        <ReachabilityWarning count={unknownContacts} />
      ) : null}

      <Tabs defaultValue="steps">
        <TabsList className="mb-6">
          <TabsTrigger value="steps">The messages</TabsTrigger>
          <TabsTrigger value="log">What was sent</TabsTrigger>
        </TabsList>

        <TabsContent value="steps" className="space-y-4">
          {numbers.length > 1 ? (
            <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm">
              <Label htmlFor="flow-number" className="text-sm font-semibold">
                Send from this number
              </Label>
              <p className="mt-1 text-sm text-muted-foreground">
                You can only pick messages that WhatsApp approved for this number.
              </p>
              <div className="mt-3 max-w-sm">
                <Select
                  value={flow.whatsapp_account_id ?? NO_TEMPLATE}
                  onValueChange={(v) => void setAccount(v)}
                  disabled={!canManage}
                >
                  <SelectTrigger id="flow-number" className="min-h-11">
                    <SelectValue placeholder="Main number" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_TEMPLATE}>Main number</SelectItem>
                    {numbers.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {numberLabel(n)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {!canManage ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  You can look, but only an owner or admin can change this.
                </p>
              ) : null}
            </div>
          ) : null}

          {steps.length === 0 ? (
            <EmptyState
              icon={Workflow}
              title="No messages here yet"
              description="Messages are created together with the flow. If none show up, your shop setup isn't finished — reach out to us and we'll help."
            />
          ) : (
            <div className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6">
              <ol className="list-none space-y-0 p-0">
                <TimelineRow first dot="filled">
                  <p className="text-sm font-semibold text-foreground">{flowTrigger(flow)}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    This is what starts the messages.
                  </p>
                </TimelineRow>

                {steps.map((step) => (
                  <TimelineRow key={step.id} dot={step.is_enabled ? "filled" : "hollow"}>
                    <StepBlock
                      flowKey={flow.key}
                      step={step}
                      templates={selectableTemplates}
                      canManage={canManage}
                      onChange={(patch) => void updateStep(step, patch)}
                    />
                  </TimelineRow>
                ))}

                <TimelineRow last dot="check">
                  <p className="text-sm font-medium text-foreground">
                    If they buy, we stop messaging automatically.
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    Nobody gets a reminder for something they already paid for.
                  </p>
                </TimelineRow>
              </ol>
            </div>
          )}
        </TabsContent>

        <TabsContent value="log">
          <SendsLog organizationId={organizationId} flowId={flow.id} timezone={timezone} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TimelineRow({
  children,
  dot,
  first,
  last,
}: {
  children: React.ReactNode;
  dot: "filled" | "hollow" | "check";
  first?: boolean;
  last?: boolean;
}) {
  return (
    <li className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3 pb-6 last:pb-0 sm:gap-4">
      <div className="relative flex justify-center">
        {!first ? (
          <span className="absolute -top-6 bottom-1/2 w-px bg-border" aria-hidden="true" />
        ) : null}
        {!last ? (
          <span className="absolute top-4 bottom-0 w-px bg-border" aria-hidden="true" />
        ) : null}
        {dot === "check" ? (
          <CheckCircle2 className="relative mt-1 h-4 w-4 text-primary" aria-hidden="true" />
        ) : (
          <span
            className={`relative mt-1.5 h-3 w-3 rounded-full border-2 border-primary ${dot === "filled" ? "bg-primary" : "bg-background"}`}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </li>
  );
}

function StepBlock({
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
  const [editing, setEditing] = useState(false);
  const label = stepLabel(flowKey, step);
  const selected = templates.find((t) => t.id === step.template_id) ?? null;
  const pending = selected && selected.status.toUpperCase() !== "APPROVED";

  const delayChoices = Array.from(new Set([...DELAY_CHOICES, step.delay_minutes])).sort(
    (a, b) => a - b,
  );

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="text-sm font-semibold text-foreground">
          {formatDelay(step.delay_minutes)}
        </h3>
        <p className="text-sm text-muted-foreground">
          we send “{selected ? selected.name.replace(/_/g, " ") : "nothing yet"}” ({label})
        </p>
      </div>

      {!step.is_enabled ? (
        <p className="mt-2 text-sm text-muted-foreground">
          This message is switched off, so it won't be sent.
        </p>
      ) : (
        <div className="mt-3">
          <MessageBubble
            components={selected?.components}
            emptyHint="No message chosen yet — pick one below so this can be sent."
          />
          {pending ? (
            <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
              WhatsApp hasn't approved this message yet, so it can't be sent.
            </p>
          ) : null}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PermissionGate
          allowed={canManage}
          reason="Ask the shop owner to give you permission to change these messages."
        >
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            aria-expanded={editing}
            className="inline-flex min-h-11 items-center rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {editing ? "Done" : "Change"}
            <span className="sr-only"> the {label} message</span>
          </button>
        </PermissionGate>
        <label
          htmlFor={`step-on-${step.id}`}
          className="flex min-h-11 cursor-pointer items-center gap-2 px-1 text-sm text-foreground"
        >
          <PermissionGate
            allowed={canManage}
            reason="Ask the shop owner to give you permission to change these messages."
          >
            <Switch
              id={`step-on-${step.id}`}
              checked={step.is_enabled}
              onCheckedChange={(v) => onChange({ is_enabled: v })}
            />
          </PermissionGate>
          <span>{step.is_enabled ? "On" : "Off"}</span>
        </label>
      </div>

      {editing ? (
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor={`tpl-${step.id}`}>Which message to send</Label>
            <Select
              value={step.template_id ?? NO_TEMPLATE}
              onValueChange={(v) => onChange({ template_id: v === NO_TEMPLATE ? null : v })}
              disabled={!canManage}
            >
              <SelectTrigger id={`tpl-${step.id}`} className="min-h-11">
                <SelectValue placeholder="Choose a message" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEMPLATE}>No message chosen</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name.replace(/_/g, " ")}
                    {t.status.toUpperCase() === "APPROVED" ? "" : " (waiting for approval)"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {templates.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                You haven't written any messages for this number yet. Create one under Templates
                first.
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor={`delay-${step.id}`}>How long after</Label>
            <Select
              value={String(step.delay_minutes)}
              onValueChange={(v) => onChange({ delay_minutes: Number(v) })}
              disabled={!canManage}
            >
              <SelectTrigger id={`delay-${step.id}`} className="min-h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {delayChoices.map((m) => (
                  <SelectItem key={m} value={String(m)}>
                    {formatDelay(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Counted from the moment it starts. Quiet hours can push it a little later.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
