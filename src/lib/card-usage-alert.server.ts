import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Card usage alarm. Every real card render is recorded on ai_usage as
 * "card_render" (never charged — pricing is pending). When one workspace
 * passes CARD_RENDER_ALERT_AT renders in a calendar month (UTC, the same
 * months ai_usage.usage_date uses), the platform owner is told once for that
 * workspace and month, through the provider-alert path: an activity_log row
 * and a WhatsApp notice to the billing admin number (billing_notifications,
 * template admin_ai_provider_alert). Nothing is charged and nothing is
 * stopped. Never throws.
 */
export const CARD_RENDER_ALERT_AT = 5000;
export const CARD_USAGE_ALERT_ACTION = "card_usage_alert";

// One check per workspace per 5 minutes on this server: the count is a read,
// and a few minutes' delay on a once-a-month alert costs nothing.
const CHECK_EVERY_MS = 5 * 60_000;
const lastCheck = new Map<string, number>();
// Workspace+month already alerted from this server.
const alerted = new Set<string>();

/** Only for tests. */
export function resetCardUsageAlarm(): void {
  lastCheck.clear();
  alerted.clear();
}

function monthStart(now: Date): { day: string; iso: string; label: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    day: start.toISOString().slice(0, 10),
    iso: start.toISOString(),
    label: start.toISOString().slice(0, 7),
  };
}

export async function checkCardUsageAlarm(
  supabase: SupabaseClient,
  organizationId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const month = monthStart(now);
    const key = `${organizationId}:${month.label}`;
    if (alerted.has(key)) return false;
    const last = lastCheck.get(organizationId) ?? 0;
    if (now.getTime() - last < CHECK_EVERY_MS) return false;
    lastCheck.set(organizationId, now.getTime());

    const { data: usage } = await supabase
      .from("ai_usage")
      .select("runs")
      .eq("organization_id", organizationId)
      .eq("task", "card_render")
      .gte("usage_date", month.day);
    const renders = ((usage ?? []) as Array<{ runs: number | null }>).reduce((n, r) => n + Number(r.runs ?? 0), 0);
    if (renders <= CARD_RENDER_ALERT_AT) return false;

    // Already raised this month (by this or another server)?
    const { data: earlier } = await supabase
      .from("activity_log")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("action", CARD_USAGE_ALERT_ACTION)
      .gte("created_at", month.iso)
      .limit(1);
    alerted.add(key);
    if (Array.isArray(earlier) && earlier.length > 0) return false;

    const { data: org } = await supabase.from("organizations").select("name").eq("id", organizationId).maybeSingle();
    const name = String((org as { name?: string | null } | null)?.name ?? "").trim() || "A workspace";
    const count = new Intl.NumberFormat("en-IN").format(renders);
    const headline = `${name} has drawn ${count} customer cards this month (over ${new Intl.NumberFormat("en-IN").format(CARD_RENDER_ALERT_AT)})`;
    const detail = "cards are not charged, so nothing was billed or stopped";
    const link = "https://aidwar.in/admin/organizations";
    await supabase.from("activity_log").insert({
      organization_id: organizationId,
      action: CARD_USAGE_ALERT_ACTION,
      details: { month: month.label, renders, threshold: CARD_RENDER_ALERT_AT, headline, detail },
    });
    await supabase.from("billing_notifications").insert({
      organization_id: organizationId,
      audience: "admin",
      kind: CARD_USAGE_ALERT_ACTION,
      channel: "whatsapp",
      payload: { headline, detail, link },
    });
    return true;
  } catch (error) {
    console.error("[card-usage-alert]", error instanceof Error ? error.message : String(error));
    return false;
  }
}
