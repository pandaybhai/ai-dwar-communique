import type { SupabaseClient } from "@supabase/supabase-js";
import type { AnalyticsEventInput, EventProperties, UsageRecordInput } from "@/lib/events";

/**
 * Fire-and-forget capture.
 *
 * Emission is never allowed to fail or slow the operation that triggered it:
 * every write is wrapped, errors are swallowed after a console line, and
 * callers `void` the promise. Writes need the service-role client — the table
 * only grants insert to service_role.
 */
/**
 * A dimensionless event can't be filtered in any chart, and the gap is only
 * ever noticed weeks later. Warn loudly at emission instead.
 */
function warnIfDimensionless(input: AnalyticsEventInput): void {
  const props = input.properties ?? {};
  if (Object.keys(props).length === 0) {
    console.warn(
      JSON.stringify({
        scope: "events",
        stage: "empty_properties",
        event_type: input.eventType,
        entity_type: input.entityType,
        entity_id: input.entityId ?? null,
        organization_id: input.organizationId,
      }),
    );
  }
}

async function insertEvent(supabase: SupabaseClient, input: AnalyticsEventInput): Promise<void> {
  warnIfDimensionless(input);
  const { error } = await supabase.from("analytics_events").insert({
    organization_id: input.organizationId,
    whatsapp_account_id: input.whatsappAccountId ?? null,
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    actor_user_id: input.actorUserId ?? null,
    properties: input.properties ?? {},
    ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
  });
  if (error) console.log(JSON.stringify({ scope: "events", stage: "insert_failed", error: error.message }));
}

export function emitEvent(
  supabase: SupabaseClient,
  eventType: string,
  input: Omit<AnalyticsEventInput, "eventType">,
): void {
  try {
    void insertEvent(supabase, { ...input, eventType }).catch(() => {});
  } catch {
    // capture must never break the operation it describes
  }
}

/** Awaitable variant for paths that batch many events in one insert. */
export async function emitEvents(
  supabase: SupabaseClient,
  rows: AnalyticsEventInput[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await supabase.from("analytics_events").insert(
      rows.map((input) => ({
        organization_id: input.organizationId,
        whatsapp_account_id: input.whatsappAccountId ?? null,
        event_type: input.eventType,
        entity_type: input.entityType,
        entity_id: input.entityId ?? null,
        actor_user_id: input.actorUserId ?? null,
        properties: (input.properties ?? {}) as EventProperties,
        ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
      })),
    );
  } catch {
    // capture must never break the operation it describes
  }
}

/**
 * Usage meters. Billing doesn't exist yet, but usage can't be backfilled, so
 * the records start accumulating now.
 */
export function recordUsage(
  supabase: SupabaseClient,
  meterKey: string,
  input: Omit<UsageRecordInput, "meterKey">,
): void {
  try {
    void (async () => {
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
    })().catch(() => {});
  } catch {
    // metering must never break the operation it describes
  }
}
