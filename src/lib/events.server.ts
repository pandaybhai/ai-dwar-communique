import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalyticsEventInput, EventProperties, UsageRecordInput } from "@/lib/events";

/**
 * Capture that actually lands.
 *
 * These used to be fire-and-forget: `void insertEvent(...)`. On the serverless
 * runtime the request context is torn down the moment the handler returns its
 * response, and any promise still in flight is discarded — silently. That is
 * why `flow.clicked` never appeared once (the redirect returns immediately) and
 * why `flow.sent` under-recorded (whichever insert lost the race to the
 * response was dropped). It is the same class of defect as a discarded upsert
 * error: the action succeeded, the record of it did not.
 *
 * So emission is now awaited. It still never throws and never fails the
 * operation it describes — errors are logged, not propagated — but the caller
 * holds the response open until the row is written. `feature-registry.check.ts`
 * fails the build on any un-awaited emission, so this cannot regress.
 */

/**
 * A dimensionless event can't be filtered in any chart, and the gap is only
 * ever noticed weeks later. Warn loudly at emission instead. Outbound message
 * events and flow events additionally have a required dimension set — that's
 * what revenue attribution, cost reporting and per-source reporting join on.
 */
const REQUIRED_MESSAGE_DIMENSIONS = [
  "contact_id",
  "whatsapp_account_id",
  "template_name",
  "message_class",
] as const;

/**
 * Every flow event must be joinable back to the scheduled_sends row it
 * describes. Pre-schedule skips have no row yet, so the key may be null — but
 * it must be present, because an absent key is indistinguishable from a bug.
 */
const REQUIRED_FLOW_DIMENSIONS = ["scheduled_send_id", "flow_id", "contact_id"] as const;

/** flow.clicked is the one flow event that must also carry campaign_id. */
const REQUIRED_CLICK_DIMENSIONS = [
  "scheduled_send_id",
  "flow_id",
  "flow_step_id",
  "contact_id",
  "campaign_id",
] as const;

function missingDimensions(input: AnalyticsEventInput): string[] {
  const props = (input.properties ?? {}) as Record<string, unknown>;
  if (Object.keys(props).length === 0) return ["*"];
  if (input.eventType === "flow.clicked") {
    return REQUIRED_CLICK_DIMENSIONS.filter((k) => !(k in props));
  }
  if (input.eventType.startsWith("flow.")) {
    return REQUIRED_FLOW_DIMENSIONS.filter((k) => !(k in props));
  }
  if (input.eventType.startsWith("message.")) {
    return REQUIRED_MESSAGE_DIMENSIONS.filter((k) => !(k in props));
  }
  return [];
}

function warnIfDimensionless(input: AnalyticsEventInput): void {
  const missing = missingDimensions(input);
  if (missing.length > 0) {
    console.warn(
      JSON.stringify({
        scope: "events",
        stage: "empty_properties",
        missing,
        event_type: input.eventType,
        entity_type: input.entityType,
        entity_id: input.entityId ?? null,
        organization_id: input.organizationId,
      }),
    );
  }
}

function rowFor(input: AnalyticsEventInput) {
  return {
    organization_id: input.organizationId,
    whatsapp_account_id: input.whatsappAccountId ?? null,
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    actor_user_id: input.actorUserId ?? null,
    properties: (input.properties ?? {}) as EventProperties,
    ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
  };
}

/**
 * Writes one event. Awaited by every caller — a dropped await is a build error.
 * Never throws.
 */
export async function emitEvent(
  supabase: SupabaseClient,
  eventType: string,
  input: Omit<AnalyticsEventInput, "eventType">,
): Promise<void> {
  const event: AnalyticsEventInput = { ...input, eventType };
  try {
    warnIfDimensionless(event);
    const { error } = await supabase.from("analytics_events").insert(rowFor(event));
    if (error) {
      console.log(
        JSON.stringify({
          scope: "events",
          stage: "insert_failed",
          event_type: eventType,
          error: error.message,
        }),
      );
    }
  } catch (caught) {
    // capture must never break the operation it describes
    console.log(
      JSON.stringify({
        scope: "events",
        stage: "insert_threw",
        event_type: eventType,
        error: caught instanceof Error ? caught.message : String(caught),
      }),
    );
  }
}

/** Batch variant for paths that write many events at once. Never throws. */
export async function emitEvents(
  supabase: SupabaseClient,
  rows: AnalyticsEventInput[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    rows.forEach(warnIfDimensionless);
    const { error } = await supabase.from("analytics_events").insert(rows.map(rowFor));
    if (error) {
      console.log(
        JSON.stringify({ scope: "events", stage: "insert_failed", error: error.message }),
      );
    }
  } catch (caught) {
    console.log(
      JSON.stringify({
        scope: "events",
        stage: "insert_threw",
        error: caught instanceof Error ? caught.message : String(caught),
      }),
    );
  }
}

/**
 * Usage meters. Billing doesn't exist yet, but usage can't be backfilled, so
 * the records start accumulating now. Awaited for the same reason as events.
 */
export async function recordUsage(
  supabase: SupabaseClient,
  meterKey: string,
  input: Omit<UsageRecordInput, "meterKey">,
): Promise<void> {
  try {
    const { error } = await supabase.from("usage_records").insert({
      organization_id: input.organizationId,
      meter_key: meterKey,
      quantity: input.quantity ?? 1,
      metadata: input.metadata ?? {},
      ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
    });
    if (error) {
      console.log(
        JSON.stringify({ scope: "usage", stage: "insert_failed", meter: meterKey, error: error.message }),
      );
    }
  } catch (caught) {
    // metering must never break the operation it describes
    console.log(
      JSON.stringify({
        scope: "usage",
        stage: "insert_threw",
        meter: meterKey,
        error: caught instanceof Error ? caught.message : String(caught),
      }),
    );
  }
}
