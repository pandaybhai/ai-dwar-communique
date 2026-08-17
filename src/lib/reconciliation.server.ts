import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Nightly event reconciliation.
 *
 * The reporting pages read analytics_events, but the source of truth for what
 * actually happened is scheduled_sends (a send reached WhatsApp) and
 * short_links (a customer opened a link). If those two disagree, a number on
 * the Receipts page is quietly wrong. This job compares them per organization
 * for a window and writes an alert row to activity_log when they don't match,
 * so the gap is visible instead of silent.
 *
 * It never changes data — it only observes and reports.
 */

export type ReconcileRow = {
  organization_id: string;
  sends_actual: number;
  sends_recorded: number;
  sends_delta: number;
  clicks_actual: number;
  clicks_recorded: number;
  clicks_delta: number;
  mismatch: boolean;
};

export type ReconcileResult = {
  from: string;
  to: string;
  organizations: number;
  mismatches: number;
  rows: ReconcileRow[];
};

/** Tolerance, in events, before a difference is treated as a real problem. */
const TOLERANCE = 0;

type Counter = Map<string, number>;

const bump = (map: Counter, key: string | null | undefined, by = 1) => {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + by);
};

export async function reconcileEvents(
  supabase: SupabaseClient,
  options: { hours?: number } = {},
): Promise<ReconcileResult> {
  const hours = options.hours ?? 24;
  const to = new Date();
  const from = new Date(to.getTime() - hours * 3_600_000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  // What really happened.
  const sendsActual: Counter = new Map();
  const sentIds = new Set<string>();
  const { data: sends, error: sendsError } = await supabase
    .from("scheduled_sends")
    .select("id, organization_id, updated_at")
    .eq("status", "sent")
    .gte("updated_at", fromIso)
    .lt("updated_at", toIso)
    .limit(20_000);
  if (sendsError) throw new Error(`scheduled_sends read failed: ${sendsError.message}`);
  for (const row of sends ?? []) {
    bump(sendsActual, row.organization_id as string);
    sentIds.add(row.id as string);
  }

  const clicksActual: Counter = new Map();
  const { data: links, error: linksError } = await supabase
    .from("short_links")
    .select("organization_id, click_count, first_clicked_at, last_clicked_at")
    .gte("last_clicked_at", fromIso)
    .lt("last_clicked_at", toIso)
    .limit(20_000);
  if (linksError) throw new Error(`short_links read failed: ${linksError.message}`);
  for (const row of links ?? []) {
    // A link first clicked inside the window contributes all of its clicks;
    // one clicked earlier contributes at least the click that lands here.
    const firstInWindow = (row.first_clicked_at as string | null) ?? "";
    const count = firstInWindow >= fromIso ? Number(row.click_count) || 0 : 1;
    bump(clicksActual, row.organization_id as string, count);
  }

  // What we recorded.
  const sendsRecorded: Counter = new Map();
  const clicksRecorded: Counter = new Map();
  const { data: events, error: eventsError } = await supabase
    .from("analytics_events")
    .select("organization_id, event_type, properties, occurred_at")
    .in("event_type", ["flow.sent", "flow.clicked"])
    .gte("occurred_at", fromIso)
    .lt("occurred_at", toIso)
    .limit(50_000);
  if (eventsError) throw new Error(`analytics_events read failed: ${eventsError.message}`);

  const seenSendEvent = new Set<string>();
  for (const row of events ?? []) {
    const org = row.organization_id as string;
    const props = (row.properties ?? {}) as Record<string, unknown>;
    if (row.event_type === "flow.sent") {
      const sendId = typeof props["scheduled_send_id"] === "string"
        ? (props["scheduled_send_id"] as string)
        : null;
      // Count each send once, even if a retry emitted twice.
      if (sendId) {
        if (seenSendEvent.has(sendId)) continue;
        seenSendEvent.add(sendId);
      }
      bump(sendsRecorded, org);
    } else {
      bump(clicksRecorded, org);
    }
  }

  const orgIds = new Set<string>([
    ...sendsActual.keys(),
    ...sendsRecorded.keys(),
    ...clicksActual.keys(),
    ...clicksRecorded.keys(),
  ]);

  const rows: ReconcileRow[] = [];
  for (const organization_id of orgIds) {
    const sends_actual = sendsActual.get(organization_id) ?? 0;
    const sends_recorded = sendsRecorded.get(organization_id) ?? 0;
    const clicks_actual = clicksActual.get(organization_id) ?? 0;
    const clicks_recorded = clicksRecorded.get(organization_id) ?? 0;
    const sends_delta = sends_recorded - sends_actual;
    const clicks_delta = clicks_recorded - clicks_actual;
    rows.push({
      organization_id,
      sends_actual,
      sends_recorded,
      sends_delta,
      clicks_actual,
      clicks_recorded,
      clicks_delta,
      mismatch: Math.abs(sends_delta) > TOLERANCE || Math.abs(clicks_delta) > TOLERANCE,
    });
  }

  const mismatched = rows.filter((r) => r.mismatch);
  if (mismatched.length > 0) {
    const alerts = mismatched.map((r) => ({
      organization_id: r.organization_id,
      user_id: null,
      action: "reconciliation_mismatch",
      details: {
        window_from: fromIso,
        window_to: toIso,
        sends_actual: r.sends_actual,
        sends_recorded: r.sends_recorded,
        sends_delta: r.sends_delta,
        clicks_actual: r.clicks_actual,
        clicks_recorded: r.clicks_recorded,
        clicks_delta: r.clicks_delta,
      },
    }));
    const { error: logError } = await supabase.from("activity_log").insert(alerts);
    if (logError) {
      console.error("[reconcile] could not write alert rows", logError.message);
    }
    for (const r of mismatched) {
      console.warn(
        `[reconcile] org=${r.organization_id} sends recorded ${r.sends_recorded} vs actual ${r.sends_actual}, clicks recorded ${r.clicks_recorded} vs actual ${r.clicks_actual}`,
      );
    }
  }

  return {
    from: fromIso,
    to: toIso,
    organizations: rows.length,
    mismatches: mismatched.length,
    rows,
  };
}
