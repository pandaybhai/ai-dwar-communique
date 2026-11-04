import type { SupabaseClient } from "@supabase/supabase-js";
import { failureReason } from "@/lib/wa-reachability";
import { sendSourceOf, SEND_SOURCE_LABEL } from "@/lib/template-sends";

/**
 * Batch 63 (B): one daily summary of the template messages that failed in
 * the last 24 hours (API, campaign, flow, Inbox), to the workspace's owner /
 * admins — only on a day with failures, and never when the workspace turned
 * it off (organizations.branding.send_failure_summary === false; anything
 * else, missing included, is on).
 *
 * It is queued through the existing notice path, notify() →
 * billing_notifications (kind "send_failures", audience "client", channel
 * "email"), and sent by the existing email drain (drainEmailNotices, wording
 * from sendFailuresEmail below) with its retries, 48-hour expiry and claim.
 * No new channel. WhatsApp: the notice drain only sends an approved platform
 * template, and there is none for this yet (see the PR) — so the email goes,
 * and the Home "Needs attention" item shows the same failures in the app.
 *
 * Run by the billing sweep (every 30 minutes); the summary goes once per
 * workspace per India day, from 09:00 IST.
 */

export const DIGEST_KIND = "send_failures";
export const DIGEST_FROM_HOUR_IST = 9;
const IST_OFFSET_MS = 5.5 * 3600_000;
const MAX_LINES = 25;
const MAX_ROWS = 2000;

/** The start of today in India, as a UTC instant. */
export function istDayStart(now: number): number {
  const ist = now + IST_OFFSET_MS;
  return ist - (ist % 864e5) - IST_OFFSET_MS;
}

export function istHour(now: number): number {
  return Math.floor(((now + IST_OFFSET_MS) % 864e5) / 3600_000);
}

export type DigestLine = {
  at: string;
  number: string;
  template: string;
  source: string;
  reason: string;
  copy: boolean;
};

type FailedRow = {
  id: string;
  organization_id: string;
  template_name: string | null;
  error_detail: unknown;
  metadata: Record<string, unknown> | null;
  campaign_id: string | null;
  flow_id: string | null;
  sent_by: string | null;
  created_at: string;
  conversations?: { contacts?: { phone?: string | null; name?: string | null } | null } | null;
};

/** One line per failed send, newest first. */
export function digestLines(rows: FailedRow[]): DigestLine[] {
  return [...rows]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((r) => ({
      at: r.created_at,
      number:
        String(r.conversations?.contacts?.phone ?? r.metadata?.["to"] ?? "").trim() ||
        "unknown number",
      template: r.template_name ?? "template",
      source: SEND_SOURCE_LABEL[sendSourceOf(r)],
      reason: failureReason(r.error_detail),
      copy: r.metadata?.["copy"] === true,
    }));
}

export function summaryOn(branding: unknown): boolean {
  return ((branding ?? {}) as Record<string, unknown>)["send_failure_summary"] !== false;
}

/** Who gets it: the hand-off alert email, else the owners' and admins' emails (≤ 3). */
async function recipients(supabase: SupabaseClient, organizationId: string): Promise<string[]> {
  const { data: ai } = await supabase
    .from("organization_ai_settings")
    .select("handoff_alert_email")
    .eq("organization_id", organizationId)
    .maybeSingle();
  const alertEmail = String(
    (ai as { handoff_alert_email?: string | null } | null)?.handoff_alert_email ?? "",
  ).trim();
  if (alertEmail) return [alertEmail];
  const { data: members } = await supabase
    .from("organization_members")
    .select("user_id, role")
    .eq("organization_id", organizationId)
    .in("role", ["owner", "admin"]);
  const ids = ((members ?? []) as Array<{ user_id: string; role: string }>)
    .sort((a, b) => (a.role === b.role ? 0 : a.role === "owner" ? -1 : 1))
    .map((m) => m.user_id);
  if (!ids.length) return [];
  const { data: profiles } = await supabase.from("profiles").select("id, email").in("id", ids);
  const byId = new Map(
    ((profiles ?? []) as Array<{ id: string; email: string | null }>).map((p) => [p.id, p.email]),
  );
  return [
    ...new Set(
      ids
        .map((id) => String(byId.get(id) ?? "").trim())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)),
    ),
  ].slice(0, 3);
}

export type DigestCounts = {
  workspaces: number;
  queued: number;
  skipped_off: number;
  skipped_sent: number;
};

export async function runSendFailureDigest(
  supabase: SupabaseClient,
  now = Date.now(),
): Promise<DigestCounts> {
  const counts: DigestCounts = { workspaces: 0, queued: 0, skipped_off: 0, skipped_sent: 0 };
  if (istHour(now) < DIGEST_FROM_HOUR_IST) return counts;
  const since = new Date(now - 864e5).toISOString();
  const { data, error } = await supabase
    .from("messages")
    .select(
      "id, organization_id, template_name, error_detail, metadata, campaign_id, flow_id, sent_by, created_at, conversations(contacts(phone, name))",
    )
    .eq("direction", "outbound")
    .eq("type", "template")
    .eq("status", "failed")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) throw new Error(error.message);
  const byOrg = new Map<string, FailedRow[]>();
  for (const r of (data ?? []) as FailedRow[]) {
    const list = byOrg.get(r.organization_id) ?? [];
    list.push(r);
    byOrg.set(r.organization_id, list);
  }
  const today = new Date(istDayStart(now)).toISOString();
  const { notify } = await import("@/lib/billing.server");
  for (const [organizationId, rows] of byOrg) {
    counts.workspaces += 1;
    const { data: org } = await supabase
      .from("organizations")
      .select("name, branding")
      .eq("id", organizationId)
      .maybeSingle();
    const o = (org ?? {}) as { name?: string | null; branding?: unknown };
    if (!summaryOn(o.branding)) {
      counts.skipped_off += 1;
      continue;
    }
    // Once a day: a summary already queued today (any status) is enough.
    const { data: already, error: alreadyError } = await supabase
      .from("billing_notifications")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("kind", DIGEST_KIND)
      .gte("created_at", today)
      .limit(1);
    if (alreadyError || (already as unknown[] | null)?.length) {
      counts.skipped_sent += 1;
      continue;
    }
    const lines = digestLines(rows);
    const payload = {
      workspace: String(o.name ?? "").trim() || "your workspace",
      day: today,
      total: lines.length,
      copies: lines.filter((l) => l.copy).length,
      lines: lines.slice(0, MAX_LINES),
      link: "https://aidwar.in/app/templates",
    };
    for (const to of await recipients(supabase, organizationId)) {
      await notify(supabase, {
        organizationId,
        audience: "client",
        kind: DIGEST_KIND,
        channel: "email",
        recipient: to,
        payload,
      });
      counts.queued += 1;
    }
  }
  return counts;
}

/** The email's words (drainEmailNotices → emailNoticeContent). */
export function sendFailuresEmail(payload: Record<string, unknown>): {
  subject: string;
  body: string;
  attachmentUrl: null;
  attachmentName: null;
} {
  const total = Number(payload["total"] ?? 0);
  const workspace = String(payload["workspace"] ?? "your workspace");
  const lines = (Array.isArray(payload["lines"]) ? payload["lines"] : []) as DigestLine[];
  const when = (at: string) =>
    new Date(at).toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Kolkata",
    });
  const list = lines
    .map(
      (l) =>
        `• ${when(l.at)} — ${l.number} — ${l.template}${l.copy ? " (copy)" : ""} — ${l.source} — ${l.reason}`,
    )
    .join("\n");
  const more = total > lines.length ? `\n…and ${total - lines.length} more.` : "";
  return {
    subject: `${total} WhatsApp message${total === 1 ? "" : "s"} couldn't be delivered — ${workspace}`,
    body:
      `Hello — in the last 24 hours ${total} template message${total === 1 ? "" : "s"} from ${workspace} couldn't be delivered:\n\n` +
      `${list}${more}\n\n` +
      `A number WhatsApp says isn't on WhatsApp is marked "Not on WhatsApp" on the customer until a message to it is delivered. ` +
      `See every send of a template, with its status, under Templates → Sent: ${String(payload["link"] ?? "https://aidwar.in/app/templates")}\n\n` +
      `You can turn this daily summary off in Settings → Notifications.`,
    attachmentUrl: null,
    attachmentName: null,
  };
}
