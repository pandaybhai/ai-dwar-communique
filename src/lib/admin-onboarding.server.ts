/**
 * Batch 40: the admin "Onboarding funnel" — sign-ups that started the
 * first-run journey in the last N days, step by step, and where each one
 * stopped. Read from analytics_events (onboarding.<step>, once per
 * workspace), paged so PostgREST's 1,000-row cap never cuts it short.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FUNNEL_STEPS,
  JOURNEY_MARKS,
  funnelEventType,
  furthestFunnelStep,
  summariseFunnel,
  type FunnelStep,
  type FunnelSummary,
} from "@/lib/onboarding-journey";

const PAGE = 1000;

export type FunnelSignup = {
  organizationId: string;
  name: string;
  startedAt: string;
  lastAt: string;
  furthest: FunnelStep;
  steps: string[];
  callbackRequested: boolean;
  skippedConnect: boolean;
};

export type FunnelReport = {
  days: number;
  since: string;
  summary: FunnelSummary;
  signups: FunnelSignup[];
  linkTemplateStatus: string | null;
};

async function pagedEvents(
  supabase: SupabaseClient,
  build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null }>,
  cap = 20_000,
): Promise<Array<{ organization_id: string; event_type: string; occurred_at: string }>> {
  const out: Array<{ organization_id: string; event_type: string; occurred_at: string }> = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data } = await build(from, from + PAGE - 1);
    const rows = (data ?? []) as Array<{ organization_id: string; event_type: string; occurred_at: string }>;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export async function loadOnboardingFunnel(supabase: SupabaseClient, days = 30): Promise<FunnelReport> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const starts = await pagedEvents(supabase, (from, to) =>
    supabase
      .from("analytics_events")
      .select("organization_id, event_type, occurred_at")
      .eq("event_type", funnelEventType("started"))
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .range(from, to),
  );
  const orgIds = Array.from(new Set(starts.map((s) => s.organization_id)));

  const types = [...FUNNEL_STEPS, ...JOURNEY_MARKS].map((s) => funnelEventType(s));
  const events: Array<{ organization_id: string; event_type: string; occurred_at: string }> = [];
  for (let i = 0; i < orgIds.length; i += 200) {
    const chunk = orgIds.slice(i, i + 200);
    events.push(
      ...(await pagedEvents(supabase, (from, to) =>
        supabase
          .from("analytics_events")
          .select("organization_id, event_type, occurred_at")
          .in("organization_id", chunk)
          .in("event_type", types)
          .order("occurred_at", { ascending: true })
          .range(from, to),
      )),
    );
  }

  const names = new Map<string, string>();
  for (let i = 0; i < orgIds.length; i += 200) {
    const { data } = await supabase.from("organizations").select("id, name").in("id", orgIds.slice(i, i + 200));
    for (const row of (data ?? []) as Array<{ id: string; name: string | null }>) names.set(row.id, row.name ?? "");
  }

  const byOrg = new Map<string, { steps: Set<string>; startedAt: string; lastAt: string }>();
  for (const s of starts) byOrg.set(s.organization_id, { steps: new Set(["started"]), startedAt: s.occurred_at, lastAt: s.occurred_at });
  for (const e of events) {
    const row = byOrg.get(e.organization_id);
    if (!row) continue;
    row.steps.add(e.event_type.replace(/^onboarding\./, ""));
    if (e.occurred_at > row.lastAt) row.lastAt = e.occurred_at;
  }

  const signups: FunnelSignup[] = Array.from(byOrg.entries())
    .map(([organizationId, row]) => {
      const steps = Array.from(row.steps);
      return {
        organizationId,
        name: names.get(organizationId) || "Unnamed workspace",
        startedAt: row.startedAt,
        lastAt: row.lastAt,
        furthest: furthestFunnelStep(steps) ?? "started",
        steps,
        callbackRequested: row.steps.has("callback_requested"),
        skippedConnect: row.steps.has("connect_skipped"),
      };
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));

  const { resolvePlatformOrg } = await import("@/lib/billing-notify.server");
  const { RESUME_LINK_TEMPLATE_NAME } = await import("@/lib/onboarding-nudges.server");
  const platformOrgId = await resolvePlatformOrg(supabase);
  let linkTemplateStatus: string | null = null;
  if (platformOrgId) {
    const { data } = await supabase
      .from("message_templates")
      .select("status")
      .eq("organization_id", platformOrgId)
      .eq("name", RESUME_LINK_TEMPLATE_NAME)
      .eq("language", "en_US")
      .maybeSingle();
    linkTemplateStatus = (data as { status?: string | null } | null)?.status ?? null;
  }

  return {
    days,
    since,
    summary: summariseFunnel(signups.map((s) => ({ organizationId: s.organizationId, steps: s.steps, startedAt: s.startedAt }))),
    signups,
    linkTemplateStatus,
  };
}
