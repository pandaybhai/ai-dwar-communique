import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, ArrowRight, MoonStar, Workflow } from "lucide-react";
import { toast } from "sonner";
import { aidwar } from "@/integrations/aidwar/client";
import { logActivity } from "@/lib/activity";
import { usePermissions } from "@/hooks/use-permissions";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { PermissionGate } from "@/components/permission-gate";
import { CodPanel } from "@/components/flows/cod-panel";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_SEND_SETTINGS,
  MESSAGE_CLASS_CLASSES,
  MESSAGE_CLASS_HINTS,
  MESSAGE_CLASS_LABELS,
  enableBlocker,
  flowPromise,
  flowTitle,
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
    const flowRows = (flowRes.data as FlowRow[]) ?? [];
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
      <div className="space-y-4" aria-busy="true" aria-label="Loading your flows">
        <Skeleton className="h-44 w-full rounded-2xl" />
        <Skeleton className="h-44 w-full rounded-2xl" />
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
          <Button asChild className="min-h-11 rounded-full">
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
        <div className="rounded-2xl border border-primary/25 bg-primary/5 p-5">
          <h2 className="text-sm font-semibold text-foreground">
            Nothing is switched on yet
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Read what each one does below, then turn on the one you want. You can turn it off again
            at any time.
          </p>
        </div>
      ) : null}

      {marketingUnreachable ? <ReachabilityWarning count={unknownContacts ?? 0} /> : null}

      <ul className="grid list-none gap-4 p-0">
        {flows.map((flow) => {
          const cls = messageClassOf(flow);
          const stat = summary[flow.id] ?? EMPTY;
          const flowSteps = steps.filter((s) => s.flow_id === flow.id);
          const title = flowTitle(flow);
          return (
            <li
              key={flow.id}
              className="rounded-2xl border border-border/70 bg-card p-5 shadow-sm transition-shadow duration-200 hover:shadow-md motion-reduce:transition-none sm:p-6"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-foreground">{title}</h2>
                <span
                  className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium ${MESSAGE_CLASS_CLASSES[cls]}`}
                >
                  {MESSAGE_CLASS_LABELS[cls]}
                </span>
              </div>

              <p className="mt-2 max-w-prose text-sm leading-relaxed text-foreground">
                {flowPromise(flow)}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{MESSAGE_CLASS_HINTS[cls]}</p>

              <div className="mt-4 flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
                <label
                  htmlFor={`flow-toggle-${flow.id}`}
                  className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-foreground"
                >
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
                  <span>
                    {flow.is_enabled ? "On — messages are going out" : "Off — nothing is sent"}
                  </span>
                </label>

                <Link
                  to="/app/flows/$id"
                  params={{ id: flow.id }}
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  See the messages
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  <span className="sr-only">for {title}</span>
                </Link>
              </div>

              <p className="mt-3 text-sm text-muted-foreground">
                {flowSteps.filter((s) => s.is_enabled).length} of {flowSteps.length} messages
                switched on
              </p>

              <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Sent in the last 7 days" value={stat.sent} tone="good" />
                <Stat label="Waiting to send" value={stat.scheduled} />
                <Stat label="Skipped in the last 7 days" value={stat.skipped} tone="warn" />
                <Stat label="Not sent in the last 7 days" value={stat.cancelled} />
              </dl>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-muted/30 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <MoonStar className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-foreground">
            {settings.quiet_hours_enabled
              ? `We won't message between ${hour12(settings.quiet_hours_start)} and ${hour12(settings.quiet_hours_end)}, and the same customer gets at most ${settings.marketing_cap_per_day} promotional message a day.`
              : `Messages can go out at any hour, and the same customer gets at most ${settings.marketing_cap_per_day} promotional message a day.`}
          </p>
        </div>
        <Link
          to="/app/settings"
          className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 text-sm font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          Change
          <span className="sr-only"> sending times and limits</span>
        </Link>
      </div>

      {flows.some((f) => f.key === "cod_confirmation") ? (
        <CodPanel organizationId={organizationId} timezone="Asia/Kolkata" />
      ) : null}

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
    tone === "good"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-700 dark:text-amber-400"
        : "text-foreground";
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-3">
      <dd className={`text-xl font-bold tracking-tight ${toneClass}`}>{value}</dd>
      <dt className="mt-0.5 text-xs text-muted-foreground">{label}</dt>
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
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-600/40 bg-amber-500/5 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400"
          aria-hidden="true"
        />
        <div>
          <p className="text-sm font-semibold text-foreground">
            {count.toLocaleString()} customers won't get promotional messages
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            They haven't agreed to promotional messages yet — customers brought in from your shop
            start out that way. They will still get order updates.
          </p>
        </div>
      </div>
      <Link
        to="/app/contacts"
        search={{ opt_in: "unknown" }}
        className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        See these customers
      </Link>
    </div>
  );
}
