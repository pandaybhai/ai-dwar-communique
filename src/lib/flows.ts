/**
 * Client-side shapes and presentation helpers for the scheduled messaging
 * engine. The server-side rules live in src/lib/flows.server.ts — this module
 * is pure data and formatting so the UI never re-implements a decision.
 */

export type MessageClass = "marketing" | "transactional";

export type FlowRow = {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  is_enabled: boolean;
  whatsapp_account_id: string | null;
  config: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
};

export type FlowStepRow = {
  id: string;
  flow_id: string;
  step_order: number;
  delay_minutes: number;
  template_id: string | null;
  condition: Record<string, unknown> | null;
  is_enabled: boolean;
};

export type SendStatus = "scheduled" | "sent" | "cancelled" | "failed" | "skipped";

export type ScheduledSendRow = {
  id: string;
  organization_id: string;
  flow_id: string;
  flow_step_id: string;
  contact_id: string | null;
  trigger_type: string;
  send_after: string;
  status: SendStatus;
  cancel_reason: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  contacts?: { name: string | null; phone: string } | null;
  flows?: { key: string; name: string } | null;
  flow_steps?: { step_order: number; condition: Record<string, unknown> | null } | null;
};

export type SendSettingsRow = {
  organization_id: string;
  quiet_hours_enabled: boolean;
  quiet_hours_start: number;
  quiet_hours_end: number;
  quiet_hours_exempt_transactional: boolean;
  marketing_cap_per_day: number;
  marketing_cap_per_week: number;
};

export const DEFAULT_SEND_SETTINGS: Omit<SendSettingsRow, "organization_id"> = {
  quiet_hours_enabled: true,
  quiet_hours_start: 21,
  quiet_hours_end: 9,
  quiet_hours_exempt_transactional: false,
  marketing_cap_per_day: 1,
  marketing_cap_per_week: 3,
};

export function messageClassOf(flow: Pick<FlowRow, "config">): MessageClass {
  const declared = String((flow.config ?? {})["message_class"] ?? "").toLowerCase();
  return declared === "transactional" ? "transactional" : "marketing";
}

export const MESSAGE_CLASS_LABELS: Record<MessageClass, string> = {
  marketing: "Marketing",
  transactional: "Transactional",
};

export const MESSAGE_CLASS_CLASSES: Record<MessageClass, string> = {
  marketing: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  transactional: "border-primary/25 bg-primary/10 text-primary",
};

export const STATUS_LABELS: Record<SendStatus, string> = {
  scheduled: "Scheduled",
  sent: "Sent",
  cancelled: "Cancelled",
  failed: "Failed",
  skipped: "Skipped",
};

export const STATUS_CLASSES: Record<SendStatus, string> = {
  scheduled: "border-border bg-muted text-muted-foreground",
  sent: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  cancelled: "border-border bg-muted text-muted-foreground",
  failed: "border-destructive/25 bg-destructive/10 text-destructive",
  skipped: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
};

/** Every reason the engine writes, in the merchant's words. */
export const CANCEL_REASON_LABELS: Record<string, string> = {
  recovered: "Checkout was recovered",
  order_cancelled: "Order was cancelled",
  no_marketing_optin: "Contact hasn't opted in to marketing",
  opted_out: "Contact opted out",
  frequency_cap: "Frequency cap reached",
  flow_disabled: "Flow was switched off",
  step_disabled: "Step was switched off",
  no_template: "No approved template on the step",
  trigger_gone: "The order or checkout no longer qualifies",
  contact_missing: "Contact no longer exists",
};

export function cancelReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return CANCEL_REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

/** Human names for the steps the seeded flows ship with. */
export function stepLabel(flowKey: string, step: FlowStepRow): string {
  const event = String((step.condition ?? {})["event"] ?? "");
  const byEvent: Record<string, string> = {
    order_created: "Order confirmed",
    order_fulfilled: "Order shipped",
    order_delivered: "Order delivered",
  };
  if (byEvent[event]) return byEvent[event] as string;
  if (flowKey === "abandoned_checkout") return `Reminder ${step.step_order}`;
  return `Step ${step.step_order}`;
}

export function formatDelay(minutes: number): string {
  if (minutes <= 0) return "Immediately";
  if (minutes < 60) return `After ${minutes} min`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `After ${days} day${days === 1 ? "" : "s"}`;
  }
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `After ${hours} hour${hours === 1 ? "" : "s"}`;
}

export type TemplateLite = {
  id: string;
  name: string;
  language: string;
  status: string;
  waba_id: string | null;
};

/**
 * The enable guard. A flow may only go live when every enabled step points at
 * an approved template — and the answer names the step that is blocking it.
 */
export function enableBlocker(
  flow: Pick<FlowRow, "key">,
  steps: FlowStepRow[],
  templates: TemplateLite[],
): string | null {
  const enabled = steps.filter((s) => s.is_enabled);
  if (enabled.length === 0) {
    return "This flow has no enabled steps, so there is nothing to send. Enable at least one step first.";
  }
  const byId = new Map(templates.map((t) => [t.id, t]));
  for (const step of enabled.sort((a, b) => a.step_order - b.step_order)) {
    const label = stepLabel(flow.key, step);
    const tpl = step.template_id ? byId.get(step.template_id) : undefined;
    if (!step.template_id) return `“${label}” has no template selected yet.`;
    if (!tpl) {
      return `The template on “${label}” isn't available on this number any more. Pick another one.`;
    }
    if (tpl.status.toUpperCase() !== "APPROVED") {
      return `The template on “${label}” (${tpl.name}) is ${tpl.status.toLowerCase()}, not approved yet.`;
    }
  }
  return null;
}

export function formatDateTime(value: string | null | undefined, timezone?: string): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone || undefined,
  });
}
