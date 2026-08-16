import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeKeyword } from "@/lib/opt-out";
import { normalizeConfig, type AutomationRow, type TriggerType } from "@/lib/automations";
import { sendServiceText } from "@/lib/service-text.server";

type AnyRecord = Record<string, unknown>;

const AWAY_COOLDOWN_MS = 4 * 60 * 60 * 1000;

function log(stage: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ scope: "automation", stage, ...extra }));
}

/** Local weekday (0=Sun) and minutes-since-midnight in the org timezone. */
function localNow(timezone: string): { day: number; minutes: number } {
  const tz = timezone || "Asia/Kolkata";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
  } catch {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = Math.max(0, days.indexOf(get("weekday")));
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { day, minutes: hour * 60 + minute };
}

function toMinutes(value: string | undefined, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? "").trim());
  if (!m) return fallback;
  return (Number(m[1]) % 24) * 60 + (Number(m[2]) % 60);
}

/** True when "now" (org timezone) sits inside the away window, wrap-around aware. */
export function isWithinAwayWindow(
  config: { days?: number[]; start?: string; end?: string },
  timezone: string,
): boolean {
  const days = config.days ?? [];
  if (!days.length) return false;
  const { day, minutes } = localNow(timezone);
  const start = toMinutes(config.start, 18 * 60);
  const end = toMinutes(config.end, 9 * 60);

  if (start === end) return days.includes(day);
  if (start < end) return days.includes(day) && minutes >= start && minutes < end;
  // Overnight window: the evening part belongs to the selected day, the
  // early-morning part belongs to the day after a selected day.
  const previousDay = (day + 6) % 7;
  if (minutes >= start) return days.includes(day);
  if (minutes < end) return days.includes(previousDay);
  return false;
}

function keywordMatches(
  body: string | null,
  config: { keywords?: string[]; match?: string },
): string | null {
  const text = normalizeKeyword(body ?? "");
  if (!text) return null;
  const contains = config.match === "contains";
  for (const raw of config.keywords ?? []) {
    const k = normalizeKeyword(raw);
    if (!k) continue;
    if (contains ? text.includes(k) : text === k) return k;
  }
  return null;
}

async function recordRun(
  supabase: SupabaseClient,
  row: {
    organization_id: string;
    automation_id: string;
    contact_id: string;
    conversation_id: string;
    inbound_message_id: string;
    outbound_message_id?: string | null;
    status: "sent" | "skipped" | "failed";
    skip_reason?: string | null;
    error?: string | null;
  },
): Promise<boolean> {
  const { error } = await supabase.from("automation_runs").insert(row);
  if (error) {
    // Unique (automation_id, inbound_message_id) — a duplicate webhook delivery.
    log("skipped", {
      automation_id: row.automation_id,
      reason: "duplicate_delivery",
      detail: error.code ?? null,
    });
    return false;
  }
  return true;
}

/**
 * Evaluates the org's active automations for ONE inbound message and sends at
 * most one reply. Must run after applyOptKeywords, and must not run at all when
 * that matched an opt-out / opt-in keyword.
 */
export async function evaluateAutomations(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    phoneNumberId: string;
    conversationId: string;
    contactId: string;
    inboundMessageId: string;
    waId: string;
    body: string | null;
    optKeywordMatched: boolean;
    orgTimezone: string;
    automations: AutomationRow[];
  },
): Promise<void> {
  const base = {
    organization_id: args.organizationId,
    contact_id: args.contactId,
    conversation_id: args.conversationId,
    inbound_message_id: args.inboundMessageId,
  };

  // Rule 1 — opt-out always wins. A contact who typed STOP gets the
  // unsubscribe confirmation and nothing else.
  if (args.optKeywordMatched) {
    log("skipped", { automation_id: null, reason: "opt_keyword" });
    return;
  }
  if (!args.inboundMessageId) {
    log("skipped", { automation_id: null, reason: "missing_inbound_id" });
    return;
  }

  const active = args.automations
    .filter((a) => a.is_active)
    .sort((a, b) => a.priority - b.priority || a.created_at.localeCompare(b.created_at));
  if (!active.length) return;

  // Rule 2 — hard opt-out check, independent of rule 1.
  const { data: contact } = await supabase
    .from("contacts")
    .select("opt_in_status")
    .eq("id", args.contactId)
    .maybeSingle();
  if ((contact?.opt_in_status as string | undefined) === "opted_out") {
    log("skipped", { automation_id: active[0]!.id, reason: "contact_opted_out" });
    await recordRun(supabase, {
      ...base,
      automation_id: active[0]!.id,
      status: "skipped",
      skip_reason: "contact_opted_out",
    });
    return;
  }

  // Rule 3 — exactly one automation fires: stop at the first match.
  for (const automation of active) {
    const config = normalizeConfig(automation.trigger_type as TriggerType, automation.config);

    if (automation.trigger_type === "keyword") {
      if (!keywordMatches(args.body, config)) continue;
    } else if (automation.trigger_type === "away") {
      if (!isWithinAwayWindow(config, args.orgTimezone)) continue;
    }

    let skipReason: string | null = null;

    if (automation.trigger_type === "welcome") {
      const { count } = await supabase
        .from("automation_runs")
        .select("id", { count: "exact", head: true })
        .eq("automation_id", automation.id)
        .eq("contact_id", args.contactId);
      if ((count ?? 0) > 0) skipReason = "welcome_already_sent";
    }

    if (!skipReason && automation.trigger_type === "away") {
      const since = new Date(Date.now() - AWAY_COOLDOWN_MS).toISOString();
      const { count } = await supabase
        .from("automation_runs")
        .select("id", { count: "exact", head: true })
        .eq("automation_id", automation.id)
        .eq("contact_id", args.contactId)
        .eq("status", "sent")
        .gte("created_at", since);
      if ((count ?? 0) > 0) skipReason = "away_rate_limited";
    }

    if (!skipReason && !automation.message_body.trim()) skipReason = "empty_message";

    log("matched", { automation_id: automation.id, trigger: automation.trigger_type });

    if (skipReason) {
      log("skipped", { automation_id: automation.id, reason: skipReason });
      await recordRun(supabase, {
        ...base,
        automation_id: automation.id,
        status: "skipped",
        skip_reason: skipReason,
      });
      return;
    }

    // Rule 4 — claim this (automation, inbound message) pair BEFORE sending, so
    // a duplicate webhook delivery can never produce a second send.
    const claimed = await recordRun(supabase, {
      ...base,
      automation_id: automation.id,
      status: "skipped",
      skip_reason: "in_progress",
    });
    if (!claimed) return;

    const result = await sendServiceText(supabase, {
      organizationId: args.organizationId,
      phoneNumberId: args.phoneNumberId,
      conversationId: args.conversationId,
      to: args.waId,
      body: automation.message_body,
    });

    await supabase
      .from("automation_runs")
      .update(
        result.ok
          ? { status: "sent", skip_reason: null, outbound_message_id: result.messageId }
          : {
              status: result.error === "no_credentials" ? "skipped" : "failed",
              skip_reason: result.error === "no_credentials" ? "no_credentials" : null,
              error: result.error?.slice(0, 500) ?? "send_failed",
            },
      )
      .eq("automation_id", automation.id)
      .eq("inbound_message_id", args.inboundMessageId);

    log(result.ok ? "sent" : "failed", {
      automation_id: automation.id,
      reason: result.ok ? null : result.error,
    });
    return;
  }

  log("skipped", { automation_id: null, reason: "no_match" });
}

/** Active automations for one org, cached per webhook payload. */
export async function loadAutomations(
  supabase: SupabaseClient,
  organizationId: string,
  cache: Map<string, AutomationRow[]>,
): Promise<AutomationRow[]> {
  const cached = cache.get(organizationId);
  if (cached) return cached;
  const { data } = await supabase
    .from("automations")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("priority", { ascending: true });
  const rows = ((data as AutomationRow[] | null) ?? []).map((r) => ({
    ...r,
    config: (r.config ?? {}) as AnyRecord,
  })) as AutomationRow[];
  cache.set(organizationId, rows);
  return rows;
}

/** The org's timezone, cached per webhook payload. */
export async function loadOrgTimezone(
  supabase: SupabaseClient,
  organizationId: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(organizationId);
  if (cached) return cached;
  const { data } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", organizationId)
    .maybeSingle();
  const tz = (data?.timezone as string | undefined) || "Asia/Kolkata";
  cache.set(organizationId, tz);
  return tz;
}
