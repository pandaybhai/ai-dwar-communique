import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowRight,
  Banknote,
  ClipboardCheck,
  MessageSquare,
  MoonStar,
  PackageCheck,
  Repeat,
  RotateCcw,
  ShoppingCart,
  Sparkles,
  Star,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { usePermissions } from "@/hooks/use-permissions";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { PermissionGate } from "@/components/permission-gate";
import { CodPanel } from "@/components/flows/cod-panel";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  DEFAULT_SEND_SETTINGS,
  MESSAGE_CLASS_CLASSES,
  MESSAGE_CLASS_HINTS,
  MESSAGE_CLASS_LABELS,
  enableBlocker,
  flowPromise,
  flowStepsLabel,
  flowTitle,
  flowTrigger,
  hour12,
  messageClassOf,
  type FlowRow,
  type FlowStepRow,
  type SendSettingsRow,
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
  const { enabled: formsEnabled } = useFeatureFlag("wa_forms");

  const [flows, setFlows] = useState<FlowRow[] | null>(null);
  const [steps, setSteps] = useState<FlowStepRow[]>([]);
  const [templates, setTemplates] = useState<TemplateLite[]>([]);
  const [numbers, setNumbers] = useState<WhatsAppNumber[]>([]);
  const [summary, setSummary] = useState<Record<string, Summary>>({});
  const [unknownContacts, setUnknownContacts] = useState<number | null>(null);
  const [settings, setSettings] = useState<Omit<SendSettingsRow, "organization_id">>(
    DEFAULT_SEND_SETTINGS,
  );
  const [announcement, setAnnouncement] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const since = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    const [flowRes, tplRes, numRes, sendRes, unknownRes, setRes] = await Promise.all([
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
      aidwar
        .from("organization_send_settings")
        .select(
          "quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_exempt_transactional, marketing_cap_per_day, marketing_cap_per_week",
        )
        .eq("organization_id", organizationId)
        .maybeSingle(),
    ]);

    if (flowRes.error) {
      setError("We couldn't load your flows. Please try again.");
      setFlows([]);
      return;
    }
    // The form follow-up flow disappears cleanly when forms are switched off.
    const flowRows = ((flowRes.data as FlowRow[]) ?? []).filter(
      (f) => !f.key.startsWith("v2:") && (f.key !== "form_followup" || formsEnabled),
    );
    setFlows(flowRows);
    onLoaded?.(flowRows);
    setTemplates((tplRes.data as TemplateLite[]) ?? []);
    setNumbers((numRes.data as unknown as WhatsAppNumber[]) ?? []);
    setUnknownContacts(unknownRes.count ?? 0);
    setSettings(
      (setRes.data as Omit<SendSettingsRow, "organization_id">) ?? DEFAULT_SEND_SETTINGS,
    );

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
  }, [organizationId, onLoaded, formsEnabled]);

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
    const title = flowTitle(flow);
    if (next) {
      const waba = wabaFor(flow);
      const usable = templates.filter((t) => !waba || !t.waba_id || t.waba_id === waba);
      const blocker = enableBlocker(
        flow,
        steps.filter((s) => s.flow_id === flow.id),
        usable,
      );
      if (blocker) {
        toast.error(`“${title}” can't be turned on yet`, { description: blocker });
        setAnnouncement(`${title} could not be turned on. ${blocker}`);
        return;
      }
    }
    setFlows((prev) => (prev ?? []).map((f) => (f.id === flow.id ? { ...f, is_enabled: next } : f)));
    const { error: err } = await aidwar
      .from("flows")
      .update({ is_enabled: next })
      .eq("id", flow.id);
    if (err) {
      toast.error("We couldn't change this. Please try again.");
      setAnnouncement("We couldn't change this. Please try again.");
      void load();
      return;
    }
    void logActivity("flow_toggled", organizationId, { flow: flow.key, is_enabled: next });
    const msg = next ? `${title} is on. Messages will start going out.` : `${title} is off.`;
    toast.success(msg);
    setAnnouncement(msg);
  }

  if (error) return <ErrorState message={error} />;

  if (flows === null) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading your flows">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-4 rounded-xl border border-border bg-card p-5 shadow-xs">
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div className="flex-1 space-y-2.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-full max-w-lg" />
              <Skeleton className="h-8 w-full max-w-md rounded-lg" />
            </div>
            <Skeleton className="h-6 w-11 rounded-full" />
          </div>
        ))}
      </div>
    );
  }

  if (flows.length === 0) {
    return (
      <EmptyState
        icon={Workflow}
        title="Nothing set up yet"
        description="Flows send WhatsApp messages for you — a reminder when someone leaves items in their cart, an update when an order ships. They appear here as soon as your shop is connected."
        action={
          <Button asChild>
            <Link to="/app/settings">Connect your shop</Link>
          </Button>
        }
      />
    );
  }

  const noneOn = flows.every((f) => !f.is_enabled);

  return (
    <div className="space-y-4">
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {noneOn ? (
        <div className="flex items-start gap-3 rounded-xl border border-info-border bg-info-soft p-4">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-info-soft-foreground" aria-hidden="true" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">Nothing is switched on yet</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Read what each one does below, then turn on the one you want. You can turn it off again
              at any time.
            </p>
          </div>
        </div>
      ) : null}

      {marketingUnreachable ? <ReachabilityWarning count={unknownContacts ?? 0} /> : null}

      <ul className="grid list-none gap-3 p-0">
        {flows.map((flow) => {
          const cls = messageClassOf(flow);
          const stat = summary[flow.id] ?? EMPTY;
          const flowSteps = steps.filter((s) => s.flow_id === flow.id);
          const title = flowTitle(flow);
          const Icon = FLOW_ICONS[flow.key] ?? Workflow;
          return (
            <li
              key={flow.id}
              className={cn(
                "rounded-xl border bg-card p-4 shadow-xs transition-[box-shadow,border-color] duration-200 hover:shadow-sm motion-reduce:transition-none sm:p-5",
                flow.is_enabled ? "border-border" : "border-border/70",
              )}
            >
              <div className="flex items-start gap-4">
                <span
                  className={cn(
                    "hidden h-10 w-10 shrink-0 items-center justify-center rounded-lg sm:flex",
                    flow.is_enabled ? "bg-success-soft text-success-soft-foreground" : "bg-muted text-muted-foreground",
                  )}
                >
                  <Icon className="h-5 w-5" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="type-heading text-foreground">{title}</h2>
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${MESSAGE_CLASS_CLASSES[cls]}`}
                        >
                          {MESSAGE_CLASS_LABELS[cls]}
                        </span>
                      </div>
                      <p className="mt-1 max-w-prose text-sm leading-relaxed text-muted-foreground">
                        {flowPromise(flow)}
                      </p>
                    </div>
                    <label
                      htmlFor={`flow-toggle-${flow.id}`}
                      className="flex min-h-11 shrink-0 cursor-pointer items-center gap-3 rounded-lg text-sm font-medium text-foreground"
                    >
                      <span className={flow.is_enabled ? "text-success-soft-foreground" : "text-muted-foreground"}>
                        {flow.is_enabled ? "On — messages are going out" : "Off — nothing is sent"}
                      </span>
                      <PermissionGate
                        allowed={canManage}
                        reason="Ask the shop owner to give you permission to turn flows on and off."
                      >
                        <Switch
                          id={`flow-toggle-${flow.id}`}
                          checked={flow.is_enabled}
                          onCheckedChange={(v) => void toggle(flow, v)}
                        />
                      </PermissionGate>
                    </label>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-subtle px-3 py-2">
                    <StepsPath trigger={flowTrigger(flow)} steps={flowSteps} on={flow.is_enabled} />
                    <span className="text-xs text-muted-foreground">
                      {flowStepsLabel(flow.is_enabled, flowSteps.filter((s) => s.is_enabled).length, flowSteps.length)}
                    </span>
                  </div>

                  <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:flex-wrap">
                      <Stat label="Sent in the last 7 days" value={stat.sent} tone="good" />
                      <Stat label="Waiting to send" value={stat.scheduled} />
                      <Stat label="Skipped in the last 7 days" value={stat.skipped} tone="warn" />
                      <Stat label="Not sent in the last 7 days" value={stat.cancelled} />
                    </dl>
                    <Link
                      to="/app/flows/$id"
                      params={{ id: flow.id }}
                      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 self-start rounded-lg px-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:self-auto"
                    >
                      See the messages
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="sr-only">for {title}</span>
                    </Link>
                  </div>
                  <p className="mt-2 text-xs text-faint">{MESSAGE_CLASS_HINTS[cls]}</p>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-subtle p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <MoonStar className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-foreground">
            {settings.quiet_hours_enabled
              ? `We won't message between ${hour12(settings.quiet_hours_start)} and ${hour12(settings.quiet_hours_end)}, and the same customer gets at most ${settings.marketing_cap_per_day} promotional message a day.`
              : `Messages can go out at any hour, and the same customer gets at most ${settings.marketing_cap_per_day} promotional message a day.`}
          </p>
        </div>
        <Button asChild variant="outline" size="sm" className="shrink-0 self-start sm:self-auto">
          <Link to="/app/settings">
            Change
            <span className="sr-only"> sending times and limits</span>
          </Link>
        </Button>
      </div>

      {flows.some((f) => f.key === "cod_confirmation") ? (
        <CodPanel organizationId={organizationId} timezone="Asia/Kolkata" />
      ) : null}

    </div>

  );
}

/** Batch 42: a store flow drawn as its path — what starts it, then each message and its wait. */
function StepsPath({ trigger, steps, on }: { trigger: string; steps: FlowStepRow[]; on: boolean }) {
  const ordered = [...steps].sort((a, b) => a.step_order - b.step_order);
  return (
    <ol className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs" aria-label="How this flow runs">
      <li className="inline-flex items-center gap-1.5 rounded-md bg-card px-2 py-1 font-medium text-foreground shadow-xs">
        <Zap className={cn("h-3 w-3", on ? "text-chart-3" : "text-faint")} aria-hidden="true" />
        {trigger}
      </li>
      {ordered.map((s, i) => (
        <li key={s.id} className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="h-px w-3 bg-border-strong" />
          <span className="text-faint">{waitLabel(s.delay_minutes)}</span>
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium",
              s.is_enabled ? "bg-chart-1/12 text-success-soft-foreground" : "bg-muted text-muted-foreground line-through",
            )}
          >
            <MessageSquare className="h-3 w-3" aria-hidden="true" />
            <span className="sr-only">Message </span>
            {i + 1}
          </span>
        </li>
      ))}
    </ol>
  );
}

function waitLabel(minutes: number): string {
  if (!minutes) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

const FLOW_ICONS: Record<string, LucideIcon> = {
  abandoned_checkout: ShoppingCart,
  order_lifecycle: PackageCheck,
  winback: RotateCcw,
  reorder: Repeat,
  form_followup: ClipboardCheck,
  review_request: Star,
  cod_confirmation: Banknote,
};

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
    tone === "good" && value > 0
      ? "text-success-soft-foreground"
      : tone === "warn" && value > 0
        ? "text-warning-soft-foreground"
        : "text-foreground";
  return (
    <div className="flex items-baseline gap-1.5">
      <dd className={`tabular text-base font-semibold ${toneClass}`}>{value.toLocaleString("en-IN")}</dd>
      <dt className="text-xs text-muted-foreground">{label}</dt>
    </div>
  );
}

/**
 * Contacts synced from a shop arrive without permission for promotional
 * messages, so a promotional flow reaches far fewer people than the contact
 * count suggests. Saying so up front prevents "why did only 40 send?".
 */
export function ReachabilityWarning({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-warning-border bg-warning-soft p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-warning-soft-foreground"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold text-foreground">
            {count.toLocaleString()} customers won't get promotional messages
          </p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            They haven't agreed to promotional messages yet — customers brought in from your shop
            start out that way. They will still get order updates.
          </p>
        </div>
      </div>
      <Button asChild variant="outline" size="sm" className="shrink-0 self-start sm:self-auto">
        <Link to="/app/contacts" search={{ opt_in: "unknown" }}>
          See these customers
        </Link>
      </Button>
    </div>
  );
}
