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
  /** How long after a promotional message a sale still counts as coming from it. */
  attribution_window_hours: number;
  /** India-specific tax added on top of what Meta bills, shown on Receipts. */
  gst_percent: number;
  /** Days of silence after which we try to win a customer back. */
  winback_after_days: number;
  /** Days after an order at which we suggest buying again. */
  reorder_after_days: number;
};

export const DEFAULT_SEND_SETTINGS: Omit<SendSettingsRow, "organization_id"> = {
  quiet_hours_enabled: true,
  quiet_hours_start: 21,
  quiet_hours_end: 9,
  quiet_hours_exempt_transactional: false,
  marketing_cap_per_day: 1,
  marketing_cap_per_week: 3,
  attribution_window_hours: 72,
  gst_percent: 18,
  winback_after_days: 90,
  reorder_after_days: 45,
};


export function messageClassOf(flow: Pick<FlowRow, "config">): MessageClass {
  const declared = String((flow.config ?? {})["message_class"] ?? "").toLowerCase();
  return declared === "transactional" ? "transactional" : "marketing";
}

export const MESSAGE_CLASS_LABELS: Record<MessageClass, string> = {
  marketing: "Promotional",
  transactional: "Order updates",
};

export const MESSAGE_CLASS_CLASSES: Record<MessageClass, string> = {
  marketing: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  transactional: "border-primary/40 bg-primary/10 text-primary",
};

/** One plain sentence per message class, for people new to automation. */
export const MESSAGE_CLASS_HINTS: Record<MessageClass, string> = {
  marketing: "Only sent to customers who agreed to promotional messages.",
  transactional: "Sent to every customer — these are updates about their own order.",
};

/** The merchant-facing name and promise of each flow we ship. */
export const FLOW_COPY: Record<string, { title: string; promise: string; trigger: string }> = {
  abandoned_checkout: {
    title: "Left items in cart",
    promise:
      "When someone adds items but doesn't buy, we'll remind them on WhatsApp. Most shops recover about 1 in 10 carts this way.",
    trigger: "Customer leaves items in cart",
  },
  order_lifecycle: {
    title: "Order updates",
    promise:
      "Automatically tell customers when their order is confirmed, shipped and delivered — so they stop asking.",
    trigger: "Customer places an order",
  },
  winback: {
    title: "Win back quiet customers",
    promise:
      "When a customer hasn't ordered for a while, we'll send one friendly message inviting them back. You choose how long \u201Ca while\u201D is in Settings.",
    trigger: "A customer hasn't ordered in a long time",
  },
  reorder: {
    title: "Time to reorder",
    promise:
      "For things people buy again \u2014 when an order is old enough that they may be running low, we'll offer them a one-tap reorder.",
    trigger: "An order is old enough to be running out",
  },
  review_request: {
    title: "Ask for a review",
    promise:
      "Three days after an order is delivered, we'll ask the customer how it went. Reviews help the next shopper decide.",
    trigger: "An order is delivered",
  },
};


export function flowTitle(flow: Pick<FlowRow, "key" | "name">): string {
  return FLOW_COPY[flow.key]?.title ?? flow.name;
}

export function flowPromise(flow: Pick<FlowRow, "key">): string {
  return (
    FLOW_COPY[flow.key]?.promise ??
    "This flow sends WhatsApp messages automatically when something happens in your store."
  );
}

export function flowTrigger(flow: Pick<FlowRow, "key">): string {
  return FLOW_COPY[flow.key]?.trigger ?? "Something happens in your store";
}

export const STATUS_LABELS: Record<SendStatus, string> = {
  scheduled: "Waiting to send",
  sent: "Sent",
  cancelled: "Not sent",
  failed: "Didn't go through",
  skipped: "Skipped",
};

export const STATUS_CLASSES: Record<SendStatus, string> = {
  scheduled: "border-border bg-muted text-foreground",
  sent: "border-emerald-600/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  cancelled: "border-border bg-muted text-foreground",
  failed: "border-destructive/40 bg-destructive/10 text-destructive",
  skipped: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
};

/** Every reason the engine writes, as a sentence a shop owner understands. */
export const CANCEL_REASON_LABELS: Record<string, string> = {
  recovered: "Not sent — they completed their order",
  order_cancelled: "Not sent — the order was cancelled",
  no_marketing_optin: "Not sent — customer hasn't agreed to promotional messages",
  opted_out: "Not sent — customer asked to stop receiving messages",
  frequency_cap: "Skipped — this customer already got a message today",
  flow_disabled: "Not sent — you turned this off",
  step_disabled: "Not sent — this message was turned off",
  no_template: "Not sent — no message was chosen for this step",
  trigger_gone: "Not sent — the order or cart no longer applies",
  contact_missing: "Not sent — this customer was removed",
  customer_returned: "Not sent — they placed a new order in the meantime",
};

export function cancelReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return CANCEL_REASON_LABELS[reason] ?? reason.replace(/_/g, " ");
}

/** Human names for the steps the seeded flows ship with. */
export function stepLabel(flowKey: string, step: FlowStepRow): string {
  const byFlow: Record<string, string> = {
    winback: "Come back message",
    reorder: "Reorder nudge",
    review_request: "Review request",
  };
  if (byFlow[flowKey]) return byFlow[flowKey] as string;
  const event = String((step.condition ?? {})["event"] ?? "");
  const byEvent: Record<string, string> = {
    order_created: "Order confirmed",
    order_fulfilled: "Order shipped",
    order_delivered: "Order delivered",
  };
  if (byEvent[event]) return byEvent[event] as string;
  if (flowKey === "abandoned_checkout") {
    return step.step_order === 1 ? "First reminder" : `Reminder ${step.step_order}`;
  }
  return `Message ${step.step_order}`;
}


/** "1 hour later", "1 day later" — never a number of minutes. */
export function formatDelay(minutes: number): string {
  if (minutes <= 0) return "Straight away";
  if (minutes < 60) return `${minutes} minutes later`;
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return days === 1 ? "1 day later" : `${days} days later`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "1 hour later" : `${hours} hours later`;
  }
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} hours later`;
}

/** The choices we offer for "how long after". */
export const DELAY_CHOICES = [0, 15, 30, 60, 120, 240, 360, 720, 1440, 2880, 4320];

export type TemplateLite = {
  id: string;
  name: string;
  language: string;
  status: string;
  waba_id: string | null;
  components?: unknown;
};

/**
 * The enable guard. A flow may only go live when every message that is switched
 * on has an approved message chosen — and the answer names the blocking step.
 */
export function enableBlocker(
  flow: Pick<FlowRow, "key">,
  steps: FlowStepRow[],
  templates: TemplateLite[],
): string | null {
  const enabled = steps.filter((s) => s.is_enabled);
  if (enabled.length === 0) {
    return "Every message in this flow is switched off, so there is nothing to send. Switch one on first.";
  }
  const byId = new Map(templates.map((t) => [t.id, t]));
  for (const step of enabled.sort((a, b) => a.step_order - b.step_order)) {
    const label = stepLabel(flow.key, step);
    const tpl = step.template_id ? byId.get(step.template_id) : undefined;
    if (!step.template_id) return `Choose the message to send for “${label}”.`;
    if (!tpl) {
      return `The message chosen for “${label}” isn't available on this number any more. Pick another one.`;
    }
    if (tpl.status.toUpperCase() !== "APPROVED") {
      return `The message for “${label}” is still waiting for WhatsApp approval, so it can't be sent yet.`;
    }
  }
  return null;
}

/** "We won't message between 9pm and 9am" — quiet hours as a sentence. */
export function hour12(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const suffix = h < 12 ? "am" : "pm";
  const base = h % 12 === 0 ? 12 : h % 12;
  return `${base}${suffix}`;
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
