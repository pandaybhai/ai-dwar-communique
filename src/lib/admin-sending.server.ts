import type { SupabaseClient } from "@supabase/supabase-js";
import type { SendingNow, SendingRow } from "@/lib/admin-sending";

export type { SendingNow, SendingRow };

/**
 * Super-admin live view of campaigns sending now (Batch 12): for each
 * running, paused or scheduled-and-due campaign, how fast it is going
 * (messages Meta accepted in the last minute), how many are sent and left,
 * and when it should finish at the current speed. Recently finished
 * campaigns are listed with their average speed.
 */

const WINDOW_SECONDS = 60;
const RECENT_MINUTES = 60;

type CampaignRow = {
  id: string;
  name: string | null;
  status: string;
  organization_id: string;
  whatsapp_account_id: string | null;
  total_recipients: number | null;
  sent_count: number | null;
  failed_count: number | null;
  delivered_count: number | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  organizations: { name?: string | null } | null;
};

export function etaSeconds(remaining: number | null, ratePerSec: number | null): number | null {
  if (remaining === null || !ratePerSec || ratePerSec <= 0) return null;
  return Math.round(remaining / ratePerSec);
}

export async function adminSendingNow(
  supabase: SupabaseClient,
  now = Date.now(),
): Promise<SendingNow> {
  const since = new Date(now - WINDOW_SECONDS * 1000).toISOString();
  const recentSince = new Date(now - RECENT_MINUTES * 60_000).toISOString();
  const columns =
    "id, name, status, organization_id, whatsapp_account_id, total_recipients, sent_count, failed_count, delivered_count, scheduled_at, started_at, completed_at, organizations(name)";

  const [{ data: live }, { data: done }] = await Promise.all([
    supabase
      .from("campaigns")
      .select(columns)
      .in("status", ["sending", "paused", "scheduled"])
      .order("started_at", { ascending: true, nullsFirst: false })
      .limit(100),
    supabase
      .from("campaigns")
      .select(columns)
      .in("status", ["completed", "cancelled"])
      .gte("completed_at", recentSince)
      .order("completed_at", { ascending: false })
      .limit(25),
  ]);

  const liveRows = ((live ?? []) as unknown as CampaignRow[]).filter(
    // Scheduled ones only once they are due (the worker starts them next run).
    (c) =>
      c.status !== "scheduled" || (c.scheduled_at !== null && Date.parse(c.scheduled_at) <= now),
  );

  const active = await Promise.all(
    liveRows.map(async (c): Promise<SendingRow> => {
      const [{ count: remaining }, { count: lastMinute }] = await Promise.all([
        supabase
          .from("campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("campaign_id", c.id)
          .in("status", ["queued", "sending"]),
        c.status === "sending"
          ? supabase
              .from("messages")
              .select("id", { count: "exact", head: true })
              .eq("campaign_id", c.id)
              .gte("created_at", since)
              .not("meta_message_id", "is", null)
          : Promise.resolve({ count: 0 }),
      ]);
      const rate = c.status === "sending" ? (lastMinute ?? 0) / WINDOW_SECONDS : 0;
      return toRow(c, remaining ?? null, rate, etaSeconds(remaining ?? null, rate));
    }),
  );

  const recent = ((done ?? []) as unknown as CampaignRow[]).map((c) => {
    const ms =
      c.started_at && c.completed_at ? Date.parse(c.completed_at) - Date.parse(c.started_at) : 0;
    const rate = ms > 0 ? Number(c.sent_count ?? 0) / (ms / 1000) : null;
    return toRow(c, 0, rate, null);
  });

  return {
    generated_at: new Date(now).toISOString(),
    window_seconds: WINDOW_SECONDS,
    total_rate_per_sec: Math.round(active.reduce((s, r) => s + (r.rate_per_sec ?? 0), 0) * 10) / 10,
    active,
    recent,
  };
}

function toRow(
  c: CampaignRow,
  remaining: number | null,
  rate: number | null,
  eta: number | null,
): SendingRow {
  return {
    id: c.id,
    name: c.name ?? "Campaign",
    workspace: c.organizations?.name ?? c.organization_id,
    status: c.status,
    number_id: c.whatsapp_account_id,
    total: Number(c.total_recipients ?? 0),
    sent: Number(c.sent_count ?? 0),
    failed: Number(c.failed_count ?? 0),
    delivered: Number(c.delivered_count ?? 0),
    remaining,
    rate_per_sec: rate === null ? null : Math.round(rate * 10) / 10,
    eta_seconds: eta,
    started_at: c.started_at,
    completed_at: c.completed_at,
  };
}
