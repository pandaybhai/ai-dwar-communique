import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Scheduled messaging engine.
 *
 * Shopify events schedule rows in `scheduled_sends`; the flow worker
 * (/api/internal/flow-worker) claims them a minute at a time and dispatches
 * them. Everything that decides whether a message may go out — opt-in basis,
 * quiet hours, frequency caps, cancellation — is re-checked at dispatch time,
 * because the world changes between scheduling and sending (an abandoned
 * checkout gets recovered, a contact opts out, an earlier marketing message
 * eats the daily cap).
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

export type SendSettings = {
  quietHoursEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  quietExemptTransactional: boolean;
  capPerDay: number;
  capPerWeek: number;
  /** Days of silence after which a customer is worth winning back. */
  winbackAfterDays: number;
  /** Days after an order at which a reorder nudge makes sense. */
  reorderAfterDays: number;
  timezone: string;
};

const DEFAULT_SETTINGS: Omit<SendSettings, "timezone"> = {
  quietHoursEnabled: true,
  quietStart: 21,
  quietEnd: 9,
  quietExemptTransactional: false,
  capPerDay: 1,
  capPerWeek: 3,
  winbackAfterDays: 90,
  reorderAfterDays: 45,
};


/** A flow declares the class of everything it sends; nothing infers it. */
export function messageClassOf(flow: FlowRow): MessageClass {
  const declared = String((flow.config ?? {})["message_class"] ?? "").toLowerCase();
  return declared === "transactional" ? "transactional" : "marketing";
}

export async function loadSendSettings(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<SendSettings> {
  const [{ data: settings }, { data: org }] = await Promise.all([
    supabase
      .from("organization_send_settings")
      .select(
        "quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_exempt_transactional, marketing_cap_per_day, marketing_cap_per_week, winback_after_days, reorder_after_days",
      )

      .eq("organization_id", organizationId)
      .maybeSingle(),
    supabase.from("organizations").select("timezone").eq("id", organizationId).maybeSingle(),
  ]);

  const s = (settings ?? {}) as Record<string, unknown>;
  const num = (key: string, fallback: number) =>
    typeof s[key] === "number" ? (s[key] as number) : fallback;
  const bool = (key: string, fallback: boolean) =>
    typeof s[key] === "boolean" ? (s[key] as boolean) : fallback;

  return {
    quietHoursEnabled: bool("quiet_hours_enabled", DEFAULT_SETTINGS.quietHoursEnabled),
    quietStart: num("quiet_hours_start", DEFAULT_SETTINGS.quietStart),
    quietEnd: num("quiet_hours_end", DEFAULT_SETTINGS.quietEnd),
    quietExemptTransactional: bool(
      "quiet_hours_exempt_transactional",
      DEFAULT_SETTINGS.quietExemptTransactional,
    ),
    capPerDay: num("marketing_cap_per_day", DEFAULT_SETTINGS.capPerDay),
    capPerWeek: num("marketing_cap_per_week", DEFAULT_SETTINGS.capPerWeek),
    winbackAfterDays: num("winback_after_days", DEFAULT_SETTINGS.winbackAfterDays),
    reorderAfterDays: num("reorder_after_days", DEFAULT_SETTINGS.reorderAfterDays),
    timezone: (org?.["timezone"] as string | undefined) || "Asia/Kolkata",

  };
}

/** Local wall-clock parts of an instant in the organization's timezone. */
function zoned(date: Date, timeZone: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    return { hour: get("hour") % 24, minute: get("minute") };
  } catch {
    return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
  }
}

function insideQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  // 21 -> 9 wraps midnight; 9 -> 21 does not.
  return start > end ? hour >= start || hour < end : hour >= start && hour < end;
}

/**
 * A send that lands inside quiet hours is deferred to the next window open —
 * never dropped. Returns the instant the send may go out.
 */
export function applyQuietHours(
  at: Date,
  settings: SendSettings,
  messageClass: MessageClass,
): Date {
  if (!settings.quietHoursEnabled) return at;
  if (messageClass === "transactional" && settings.quietExemptTransactional) return at;

  let candidate = at;
  // Step forward in whole hours until the local clock leaves the window. At most
  // 24 iterations, so a misconfigured window can't loop.
  for (let i = 0; i < 24; i += 1) {
    const { hour, minute } = zoned(candidate, settings.timezone);
    if (!insideQuietHours(hour, settings.quietStart, settings.quietEnd)) return candidate;
    const minutesToNextHour = 60 - minute;
    candidate = new Date(candidate.getTime() + minutesToNextHour * 60_000);
  }
  return candidate;
}

/**
 * Marketing frequency cap. Transactional messages neither count toward the cap
 * nor are limited by it.
 */
export async function frequencyCapReached(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  settings: SendSettings,
): Promise<boolean> {
  // Only marketing flows count, so resolve those flow ids first rather than
  // filtering through an embedded jsonb path.
  const { data: flowRows } = await supabase
    .from("flows")
    .select("id, config")
    .eq("organization_id", organizationId);
  const marketingFlowIds = ((flowRows as FlowRow[]) ?? [])
    .filter((f) => messageClassOf(f) === "marketing")
    .map((f) => f.id);
  if (marketingFlowIds.length === 0) return false;

  const now = Date.now();
  const countSince = async (since: string) => {
    const { count } = await supabase
      .from("scheduled_sends")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", contactId)
      .eq("status", "sent")
      .in("flow_id", marketingFlowIds)
      .gte("updated_at", since);
    return count ?? 0;
  };

  const dayAgo = new Date(now - 24 * 3600_000).toISOString();
  const weekAgo = new Date(now - 7 * 24 * 3600_000).toISOString();
  if (settings.capPerDay >= 0 && (await countSince(dayAgo)) >= settings.capPerDay) return true;
  if (settings.capPerWeek >= 0 && (await countSince(weekAgo)) >= settings.capPerWeek) return true;
  return false;
}


export async function loadFlow(
  supabase: SupabaseClient,
  organizationId: string,
  key: string,
): Promise<{ flow: FlowRow | null; steps: FlowStepRow[] }> {
  const { data: flow } = await supabase
    .from("flows")
    .select("id, organization_id, key, name, is_enabled, whatsapp_account_id, config")
    .eq("organization_id", organizationId)
    .eq("key", key)
    .maybeSingle();
  if (!flow) return { flow: null, steps: [] };

  const { data: steps } = await supabase
    .from("flow_steps")
    .select("id, flow_id, step_order, delay_minutes, template_id, condition, is_enabled")
    .eq("flow_id", (flow as FlowRow).id)
    .eq("is_enabled", true)
    .order("step_order", { ascending: true });

  return { flow: flow as FlowRow, steps: (steps as FlowStepRow[]) ?? [] };
}

export type ScheduleInput = {
  organizationId: string;
  flowKey: string;
  contactId: string | null;
  triggerType: string;
  triggerId: string;
  /** Only schedule steps whose condition.event matches, when given. */
  event?: string;
  /** Clock the delays run from; defaults to now. */
  baseAt?: Date;
};

/**
 * Schedules the enabled steps of a flow for one trigger row.
 *
 * A step that already has a row for this trigger — pending or already sent — is
 * never scheduled twice, so re-delivered Shopify webhooks are harmless.
 */
export async function scheduleFlow(
  supabase: SupabaseClient,
  input: ScheduleInput,
): Promise<{ scheduled: number; reason?: string }> {
  const { emitEvents } = await import("@/lib/events.server");

  // A flow that declines must never look like a flow that was never asked.
  const skip = async (
    reason: string,
    flow?: FlowRow | null,
    extra: Record<string, unknown> = {},
  ) => {
    await emitEvents(supabase, [{
      eventType: "flow.skipped",
      organizationId: input.organizationId,
      entityType: "flow_trigger",
      entityId: input.triggerId,
      ...(flow?.whatsapp_account_id ? { whatsappAccountId: flow.whatsapp_account_id } : {}),
      properties: {
        flow_key: input.flowKey,
        flow_id: flow?.id ?? null,
        // No row exists yet on a pre-schedule skip, but the key is always
        // present so an absent key can only ever mean a bug.
        scheduled_send_id: null,
        message_class: flow ? messageClassOf(flow) : null,
        contact_id: input.contactId,
        trigger_type: input.triggerType,
        trigger_id: input.triggerId,
        event: input.event ?? null,
        reason,
        ...extra,
      },
    }]);
    return { scheduled: 0, reason };
  };

  if (!input.contactId) return await skip("no_contact");

  const { flow, steps } = await loadFlow(supabase, input.organizationId, input.flowKey);
  if (!flow) return await skip("no_flow");
  if (!flow.is_enabled) return await skip("flow_disabled", flow);
  if (steps.length === 0) return await skip("no_enabled_steps", flow);

  const { data: contact } = await supabase
    .from("contacts")
    .select("opt_in_status")
    .eq("id", input.contactId)
    .maybeSingle();
  if ((contact as { opt_in_status?: string } | null)?.opt_in_status === "opted_out") {
    return await skip("contact_opted_out", flow);
  }

  const settings = await loadSendSettings(supabase, input.organizationId);
  const cls = messageClassOf(flow);
  const base = input.baseAt ?? new Date();

  const matched = input.event
    ? steps.filter((s) => String((s.condition ?? {})["event"] ?? "") === input.event)
    : steps.filter((s) => !(s.condition ?? {})["event"]);
  if (matched.length === 0) return await skip("no_matching_step", flow);

  const wanted = matched.filter((s) => s.template_id);
  if (wanted.length === 0) return await skip("no_template", flow);

  const { data: existing } = await supabase
    .from("scheduled_sends")
    .select("flow_step_id, status")
    .eq("trigger_id", input.triggerId)
    .in(
      "flow_step_id",
      wanted.map((s) => s.id),
    );
  const taken = new Set(
    ((existing as Array<{ flow_step_id: string; status: string }>) ?? [])
      .filter((row) => row.status !== "cancelled")
      .map((row) => row.flow_step_id),
  );

  const pending = wanted.filter((step) => !taken.has(step.id));
  if (pending.length === 0) return await skip("already_scheduled", flow);

  // Inserted one at a time: the only unique index is partial
  // (status = 'scheduled'), which Postgres cannot infer for ON CONFLICT, and a
  // single duplicate must not sink the whole batch.
  const created: Array<{ id: string; flow_step_id: string }> = [];
  for (const step of pending) {
    const row = {
      organization_id: input.organizationId,
      flow_id: flow.id,
      flow_step_id: step.id,
      contact_id: input.contactId,
      trigger_type: input.triggerType,
      trigger_id: input.triggerId,
      send_after: applyQuietHours(
        new Date(base.getTime() + Math.max(0, step.delay_minutes) * 60_000),
        settings,
        cls,
      ).toISOString(),
      status: "scheduled",
    };
    const { data: inserted, error } = await supabase
      .from("scheduled_sends")
      .insert(row)
      .select("id, flow_step_id")
      .maybeSingle();

    if (error) {
      // 23505 = the race guard did its job; anything else is a real failure.
      if (error.code === "23505") {
        await skip("already_scheduled", flow, { step_order: step.step_order });
        continue;
      }
      console.error("[flows] schedule insert failed", {
        flow_key: flow.key,
        step_id: step.id,
        trigger_id: input.triggerId,
        code: error.code,
        message: error.message,
      });
      await emitEvents(supabase, [{
        eventType: "flow.failed",
        organizationId: input.organizationId,
        entityType: "flow_trigger",
        entityId: input.triggerId,
        ...(flow.whatsapp_account_id ? { whatsappAccountId: flow.whatsapp_account_id } : {}),
        properties: {
          flow_key: flow.key,
          flow_id: flow.id,
          scheduled_send_id: null,
          step_order: step.step_order,
          message_class: cls,
          contact_id: input.contactId,
          trigger_type: input.triggerType,
          trigger_id: input.triggerId,
          reason: "schedule_insert_failed",
          error_detail: error.message,
        },
      }]);
      continue;
    }
    if (inserted) created.push(inserted as { id: string; flow_step_id: string });
  }

  await emitEvents(
    supabase,
    created.map((row) => ({
      organizationId: input.organizationId,
      eventType: "flow.scheduled",
      entityType: "scheduled_send",
      entityId: row.id,
      whatsappAccountId: flow.whatsapp_account_id,
      properties: {
        flow_key: flow.key,
        flow_id: flow.id,
        scheduled_send_id: row.id,
        step_order: wanted.find((s) => s.id === row.flow_step_id)?.step_order ?? null,
        message_class: cls,
        contact_id: input.contactId,
        trigger_type: input.triggerType,
        trigger_id: input.triggerId,
        reason: null,
      },
    })),
  );

  return { scheduled: created.length };
}


/** Cancels every pending send for a trigger row (recovery, cancellation, …). */
export async function cancelScheduledSends(
  supabase: SupabaseClient,
  triggerId: string,
  reason: string,
): Promise<number> {
  const { data } = await supabase
    .from("scheduled_sends")
    .update({ status: "cancelled", cancel_reason: reason })
    .eq("trigger_id", triggerId)
    .eq("status", "scheduled")
    .select("id, organization_id, flow_id, flow_step_id, contact_id, trigger_type");

  const rows =
    (data as Array<{
      id: string;
      organization_id: string;
      flow_id: string;
      flow_step_id: string;
      contact_id: string | null;
      trigger_type: string;
    }>) ?? [];
  if (rows.length === 0) return 0;

  const { emitEvents } = await import("@/lib/events.server");
  const { data: flow } = await supabase
    .from("flows")
    .select("key")
    .eq("id", rows[0]!.flow_id)
    .maybeSingle();

  await emitEvents(
    supabase,
    rows.map((row) => ({
      organizationId: row.organization_id,
      eventType: "flow.cancelled",
      entityType: "scheduled_send",
      entityId: row.id,
      properties: {
        flow_key: (flow?.["key"] as string | undefined) ?? null,
        flow_id: row.flow_id,
        scheduled_send_id: row.id,
        step_order: null,
        reason,
        contact_id: row.contact_id,
        trigger_type: row.trigger_type,
        trigger_id: triggerId,
      },
    })),
  );
  return rows.length;
}

/**
 * Recovery check used both on order ingest and again in the worker immediately
 * before dispatch: a checkout that has been recovered must never send.
 */
export async function cancelRecoveredCheckouts(
  supabase: SupabaseClient,
  organizationId: string,
  match: { contactId?: string | null; externalCustomerId?: string | null },
): Promise<number> {
  const pending = await supabase
    .from("scheduled_sends")
    .select("trigger_id")
    .eq("organization_id", organizationId)
    .eq("trigger_type", "abandoned_checkout")
    .eq("status", "scheduled");
  const triggerIds = Array.from(
    new Set(
      ((pending.data as Array<{ trigger_id: string | null }>) ?? [])
        .map((r) => r.trigger_id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  if (triggerIds.length === 0) return 0;

  const { data: recovered } = await supabase
    .from("abandoned_checkouts")
    .select("id, contact_id, raw")
    .in("id", triggerIds)
    .not("recovered_at", "is", null);

  const rows = (recovered as Array<{ id: string; contact_id: string | null; raw: Record<string, unknown> | null }>) ?? [];
  const matched = rows.filter((row) => {
    if (match.contactId && row.contact_id === match.contactId) return true;
    if (!match.externalCustomerId) return false;
    const customer = (row.raw?.["customer"] as Record<string, unknown> | undefined) ?? {};
    return String(customer["id"] ?? "") === String(match.externalCustomerId);
  });

  let cancelled = 0;
  for (const row of matched) {
    cancelled += await cancelScheduledSends(supabase, row.id, "recovered");
  }
  return cancelled;
}


/** True when the checkout behind a pending send has since been recovered. */
export async function triggerStillValid(
  supabase: SupabaseClient,
  triggerType: string,
  triggerId: string | null,
): Promise<{ valid: boolean; reason?: string }> {
  if (!triggerId) return { valid: true };
  if (triggerType === "abandoned_checkout") {
    const { data } = await supabase
      .from("abandoned_checkouts")
      .select("recovered_at")
      .eq("id", triggerId)
      .maybeSingle();
    if (!data) return { valid: false, reason: "trigger_missing" };
    if (data["recovered_at"]) return { valid: false, reason: "recovered" };
  }
  if (triggerType === "order") {
    const { data } = await supabase
      .from("orders")
      .select("cancelled_at")
      .eq("id", triggerId)
      .maybeSingle();
    if (!data) return { valid: false, reason: "trigger_missing" };
    if (data["cancelled_at"]) return { valid: false, reason: "order_cancelled" };
  }
  // The time-based flows key their trigger to an order too, but a newer order
  // means the customer already came back — a winback or reorder nudge then has
  // nothing to say, so it is cancelled rather than sent.
  if (triggerType === "winback" || triggerType === "reorder" || triggerType === "review_request") {
    const { data } = await supabase
      .from("orders")
      .select("contact_id, cancelled_at, placed_at")
      .eq("id", triggerId)
      .maybeSingle();
    const order = data as
      | { contact_id: string | null; cancelled_at: string | null; placed_at: string | null }
      | null;
    if (!order) return { valid: false, reason: "trigger_missing" };
    if (order.cancelled_at) return { valid: false, reason: "order_cancelled" };
    if (triggerType !== "review_request" && order.contact_id && order.placed_at) {
      const { count } = await supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("contact_id", order.contact_id)
        .is("cancelled_at", null)
        .gt("placed_at", order.placed_at);
      if ((count ?? 0) > 0) return { valid: false, reason: "customer_returned" };
    }
  }
  return { valid: true };
}


/**
 * Opt-in basis. Transactional messages reach unknown contacts because the
 * customer initiated the purchase; marketing needs explicit opt-in. Opted-out
 * contacts are unreachable under every class.
 */
export function optInAllows(
  optInStatus: string | null | undefined,
  messageClass: MessageClass,
): { allowed: boolean; reason?: string } {
  const status = String(optInStatus ?? "unknown").toLowerCase();
  if (status === "opted_out") return { allowed: false, reason: "opted_out" };
  if (messageClass === "transactional") return { allowed: true };
  if (status === "opted_in") return { allowed: true };
  return { allowed: false, reason: "no_marketing_optin" };
}

/**
 * Template variables for a flow message. V1 fills the body placeholders in a
 * fixed order per trigger type; a merchant-configurable mapping comes later.
 */
export async function resolveFlowVariables(
  supabase: SupabaseClient,
  triggerType: string,
  triggerId: string | null,
  contact: { name: string | null } | null,
): Promise<Record<string, string>> {
  const name = contact?.name?.trim() || "there";
  if (!triggerId) return { "1": name };

  if (triggerType === "abandoned_checkout") {
    const { data } = await supabase
      .from("abandoned_checkouts")
      .select("total, currency, organization_id")
      .eq("id", triggerId)
      .maybeSingle();
    // {{2}} is the store's own name — the cart link now lives on the button.
    const orgId = (data?.["organization_id"] as string | null) ?? null;
    const { data: org } = orgId
      ? await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle()
      : { data: null };
    return {
      "1": name,
      "2": (org?.["name"] as string | null) ?? "our store",
      "3": data?.["total"] != null ? `${data["currency"] ?? ""} ${data["total"]}`.trim() : "",
    };
  }

  if (triggerType === "order") {
    const { data } = await supabase
      .from("orders")
      .select("order_number, total, currency, organization_id")
      .eq("id", triggerId)
      .maybeSingle();
    // {{4}} is the shop's own name — the COD ask says who is calling.
    const orgId = (data?.["organization_id"] as string | null) ?? null;
    const { data: org } = orgId
      ? await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle()
      : { data: null };
    return {
      "1": name,
      "2": (data?.["order_number"] as string | null) ?? "",
      "3": data?.["total"] != null ? `${data["currency"] ?? ""} ${data["total"]}`.trim() : "",
      "4": (org?.["name"] as string | null) ?? "",
    };
  }


  // Time-based flows all hang off an order row, but each says a different
  // thing, so the variables are resolved per flow rather than per table.
  if (triggerType === "winback" || triggerType === "reorder" || triggerType === "review_request") {
    const { data } = await supabase
      .from("orders")
      .select("order_number, organization_id")
      .eq("id", triggerId)
      .maybeSingle();
    const orgId = (data?.["organization_id"] as string | null) ?? null;
    const { data: org } = orgId
      ? await supabase.from("organizations").select("name").eq("id", orgId).maybeSingle()
      : { data: null };
    const storeName = (org?.["name"] as string | null) ?? "our store";

    if (triggerType === "winback") return { "1": name, "2": storeName };
    if (triggerType === "review_request") {
      return { "1": name, "2": (data?.["order_number"] as string | null) ?? "" };
    }

    const { data: items } = await supabase
      .from("order_items")
      .select("title")
      .eq("order_id", triggerId)
      .limit(1);
    const product =
      ((items as Array<{ title: string | null }> | null)?.[0]?.title ?? "").trim() ||
      "your last order";
    return { "1": name, "2": product, "3": storeName };
  }

  return { "1": name };

}

/**
 * Post-ingest assertion.
 *
 * If an organization has an enabled flow and an ingest produced neither a
 * scheduled send nor a deliberate skip, the scheduler was never reached —
 * exactly the silent nothing that let three orders pass unnoticed. Log it.
 */
export async function warnIfFlowSilent(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    flowKey: string;
    triggerId: string;
    outcomes: Array<{ scheduled: number; reason?: string }>;
  },
): Promise<void> {
  const acted = args.outcomes.some((o) => o.scheduled > 0 || o.reason);
  if (acted) return;
  const { data: flow } = await supabase
    .from("flows")
    .select("id, is_enabled")
    .eq("organization_id", args.organizationId)
    .eq("key", args.flowKey)
    .maybeSingle();
  if (!(flow as { is_enabled?: boolean } | null)?.is_enabled) return;
  console.warn(
    JSON.stringify({
      scope: "flows",
      stage: "silent_ingest",
      organization_id: args.organizationId,
      flow_key: args.flowKey,
      trigger_id: args.triggerId,
    }),
  );
}

/**
 * Extra gates a step can declare in its condition, re-checked at dispatch time.
 *
 * `cod_only` — send only for cash-on-delivery orders.
 * `requires: cod_pending` — send only while the customer still owes an answer,
 * so a reminder can never chase someone who already replied.
 */
export async function stepGateAllows(
  supabase: SupabaseClient,
  condition: Record<string, unknown> | null,
  trigger: { type: string; id: string | null },
): Promise<{ allowed: boolean; reason?: string }> {
  const cond = condition ?? {};

  if (cond["cod_only"] === true) {
    if (trigger.type !== "order" || !trigger.id) return { allowed: false, reason: "not_cod" };
    const { data } = await supabase
      .from("orders")
      .select("is_cod")
      .eq("id", trigger.id)
      .maybeSingle();
    if (!(data as { is_cod?: boolean } | null)?.is_cod) return { allowed: false, reason: "not_cod" };
  }

  if (String(cond["requires"] ?? "") === "cod_pending") {
    if (!trigger.id) return { allowed: false, reason: "cod_answered" };
    const { codStillPending } = await import("@/lib/cod.server");
    if (!(await codStillPending(supabase, trigger.id))) {
      return { allowed: false, reason: "cod_answered" };
    }
  }

  return { allowed: true };
}

/**
 * Where a template's link button should take the customer for this trigger.
 * Returned raw — the sender shortens it and counts the click.
 */
export async function flowLinkTarget(
  supabase: SupabaseClient,
  triggerType: string,
  triggerId: string | null,
): Promise<string | null> {
  if (!triggerId) return null;

  if (triggerType === "abandoned_checkout") {
    const { data } = await supabase
      .from("abandoned_checkouts")
      .select("checkout_url")
      .eq("id", triggerId)
      .maybeSingle();
    return (data?.["checkout_url"] as string | null) ?? null;
  }

  if (triggerType === "order") {
    const { data } = await supabase
      .from("orders")
      .select("raw")
      .eq("id", triggerId)
      .maybeSingle();
    const raw = (data?.["raw"] ?? {}) as Record<string, unknown>;
    const url = raw["order_status_url"];
    return typeof url === "string" && url ? url : null;
  }

  if (triggerType === "winback" || triggerType === "reorder" || triggerType === "review_request") {
    const { data } = await supabase
      .from("orders")
      .select("organization_id, raw")
      .eq("id", triggerId)
      .maybeSingle();
    const orgId = (data?.["organization_id"] as string | null) ?? null;
    const shopUrl = orgId ? await storefrontUrl(supabase, orgId) : null;
    if (triggerType === "winback") return shopUrl;

    // Reorder and review both point at the product the customer bought, and
    // fall back to somewhere useful rather than sending no link at all.
    const { data: items } = await supabase
      .from("order_items")
      .select("external_product_id")
      .eq("order_id", triggerId)
      .limit(1);
    const externalProductId =
      (items as Array<{ external_product_id: string | null }> | null)?.[0]?.external_product_id ??
      null;
    if (externalProductId && orgId) {
      const { data: product } = await supabase
        .from("products")
        .select("product_url")
        .eq("organization_id", orgId)
        .eq("external_id", externalProductId)
        .not("product_url", "is", null)
        .limit(1)
        .maybeSingle();
      const url = product?.["product_url"] as string | null | undefined;
      if (url) return url;
    }
    const raw = (data?.["raw"] ?? {}) as Record<string, unknown>;
    const statusUrl = raw["order_status_url"];
    if (triggerType === "review_request" && typeof statusUrl === "string" && statusUrl) {
      return statusUrl;
    }
    return shopUrl;
  }



  return null;
}

/** The shop's own storefront — where a "see what's new" button belongs. */
async function storefrontUrl(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("integrations")
    .select("shop_domain")
    .eq("organization_id", organizationId)
    .eq("provider", "shopify")
    .not("shop_domain", "is", null)
    .limit(1)
    .maybeSingle();
  const domain = (data?.["shop_domain"] as string | null) ?? null;
  return domain ? `https://${domain}` : null;
}

/**
 * Daily scan for the flows that trigger on elapsed time rather than an event.
 *
 * Winback and reorder both hang their trigger off an order id, so the existing
 * partial unique index on scheduled_sends is the whole idempotency story: one
 * winback per "most recent order" (it can only repeat once the customer buys
 * again), one reorder per order. No enrolment table needed.
 */
export async function scanTimeBasedFlows(
  supabase: SupabaseClient,
): Promise<{ organizations: number; winback: number; reorder: number }> {
  const { data: flowRows } = await supabase
    .from("flows")
    .select("id, organization_id, key, is_enabled")
    .in("key", ["winback", "reorder"])
    .eq("is_enabled", true);

  const enabled = new Map<string, Map<string, string>>();
  for (const row of ((flowRows as Array<{ id: string; organization_id: string; key: string }>) ??
    [])) {
    const byKey = enabled.get(row.organization_id) ?? new Map<string, string>();
    byKey.set(row.key, row.id);
    enabled.set(row.organization_id, byKey);
  }


  let winback = 0;
  let reorder = 0;

  for (const [organizationId, keys] of enabled) {
    const settings = await loadSendSettings(supabase, organizationId);

    // The most recent live order per contact. Everything both flows need is
    // decided from that one row.
    const { data: orderRows } = await supabase
      .from("orders")
      .select("id, contact_id, placed_at")
      .eq("organization_id", organizationId)
      .is("cancelled_at", null)
      .not("contact_id", "is", null)
      .not("placed_at", "is", null)
      .order("placed_at", { ascending: false })
      .limit(5000);

    const latest = new Map<string, { id: string; placedAt: number }>();
    for (const row of ((orderRows as Array<{
      id: string;
      contact_id: string | null;
      placed_at: string | null;
    }>) ?? [])) {
      const contactId = row.contact_id;
      if (!contactId || latest.has(contactId)) continue;
      const placedAt = new Date(row.placed_at as string).getTime();
      if (Number.isNaN(placedAt)) continue;
      latest.set(contactId, { id: row.id, placedAt });
    }

    // Orders these flows have already acted on. Filtering them out here keeps
    // the scan quiet: a daily re-run of the same eligible customer must not
    // write an "already scheduled" skip every night for the rest of time.
    const flowIds = Array.from(keys.values());
    const { data: doneRows } = await supabase
      .from("scheduled_sends")
      .select("flow_id, trigger_id")
      .in("flow_id", flowIds)
      .neq("status", "cancelled")
      .limit(20000);
    const done = new Set(
      ((doneRows as Array<{ flow_id: string; trigger_id: string | null }>) ?? []).map(
        (row) => `${row.flow_id}:${row.trigger_id ?? ""}`,
      ),
    );

    const now = Date.now();
    for (const [contactId, order] of latest) {
      const ageDays = (now - order.placedAt) / 86_400_000;

      const run = async (key: "winback" | "reorder", afterDays: number) => {
        const flowId = keys.get(key);
        if (!flowId || ageDays < afterDays) return 0;
        if (done.has(`${flowId}:${order.id}`)) return 0;
        const outcome = await scheduleFlow(supabase, {
          organizationId,
          flowKey: key,
          contactId,
          triggerType: key,
          triggerId: order.id,
        });
        return outcome.scheduled;
      };

      winback += await run("winback", settings.winbackAfterDays);
      reorder += await run("reorder", settings.reorderAfterDays);
    }

  }

  return { organizations: enabled.size, winback, reorder };
}

