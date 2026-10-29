/**
 * Batch 40: the first-run journey's server side — where a workspace is in it
 * (worked out from facts, never stored), the funnel (analytics_events
 * "onboarding.<step>", once per workspace per step) and what Aiden has
 * learned so far, for the Meet Aiden screen.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  FUNNEL_STEPS,
  JOURNEY_MARKS,
  funnelEventType,
  resumeStep,
  type FunnelStep,
  type JourneyFacts,
  type JourneyMark,
  type JourneyPosition,
} from "@/lib/onboarding-journey";

const ALL_MARKS = [...FUNNEL_STEPS, ...JOURNEY_MARKS] as const;

/** The onboarding steps this workspace has recorded, as their short names. */
export async function recordedSteps(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("analytics_events")
    .select("event_type")
    .eq("organization_id", organizationId)
    .in(
      "event_type",
      ALL_MARKS.map((s) => funnelEventType(s)),
    )
    .limit(100);
  return new Set(
    ((data ?? []) as Array<{ event_type: string }>).map((r) =>
      r.event_type.replace(/^onboarding\./, ""),
    ),
  );
}

/**
 * Records one onboarding step, once per workspace: a step already there is
 * left alone (and the unique index in 20261170, once applied, makes a race
 * harmless too). Awaited by every caller; never throws. True when written.
 */
export async function recordFunnelStep(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    userId?: string | null;
    step: FunnelStep | JourneyMark;
    properties?: Record<string, string | number | boolean | null>;
  },
): Promise<boolean> {
  try {
    const eventType = funnelEventType(args.step);
    const { data: prior } = await supabase
      .from("analytics_events")
      .select("id")
      .eq("organization_id", args.organizationId)
      .eq("event_type", eventType)
      .limit(1)
      .maybeSingle();
    if (prior) return false;
    const { emitEvent } = await import("@/lib/events.server");
    await emitEvent(supabase, eventType, {
      organizationId: args.organizationId,
      actorUserId: args.userId ?? null,
      entityType: "onboarding",
      entityId: args.organizationId,
      properties: { step: args.step, ...(args.properties ?? {}) },
    });
    return true;
  } catch (error) {
    console.error(
      "[onboarding-journey] record failed",
      args.step,
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

export type JourneyWebsite = {
  sourceId: string;
  host: string;
  url: string | null;
  status: string;
  itemCount: number;
  lastError: string | null;
};

export type JourneyState = {
  step: JourneyPosition;
  facts: JourneyFacts;
  recorded: string[];
  business: {
    name: string;
    logoUrl: string | null;
    color: string | null;
  };
  website: JourneyWebsite | null;
  number: { display: string | null; name: string | null } | null;
  mode: string;
  /** The journey was started in this workspace and isn't finished or dismissed. */
  active: boolean;
};

export async function loadJourneyState(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<JourneyState> {
  const [recorded, org, sources, accounts, agent, tests] = await Promise.all([
    recordedSteps(supabase, organizationId),
    supabase.from("organizations").select("name, branding").eq("id", organizationId).maybeSingle(),
    supabase
      .from("knowledge_sources")
      .select("id, type, name, status, item_count, config, last_error, created_at")
      .eq("organization_id", organizationId)
      .neq("status", "disabled")
      .order("created_at", { ascending: true })
      .limit(20),
    supabase
      .from("whatsapp_accounts")
      .select("display_phone_number, verified_name, status")
      .eq("organization_id", organizationId)
      .eq("status", "active")
      .limit(1),
    supabase
      .from("ai_agents")
      .select("mode")
      .eq("organization_id", organizationId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("ai_runs")
      .select("id")
      .eq("organization_id", organizationId)
      .eq("task", "agent_reply")
      .is("conversation_id", null)
      .eq("status", "ok")
      .limit(1),
  ]);

  const orgRow = (org.data ?? {}) as {
    name?: string | null;
    branding?: Record<string, unknown> | null;
  };
  const branding = orgRow.branding ?? {};
  const pick = (key: string) =>
    typeof branding[key] === "string" ? String(branding[key]).trim() || null : null;

  const sourceRows = (sources.data ?? []) as Array<{
    id: string;
    type: string;
    name: string | null;
    status: string;
    item_count: number | null;
    config: Record<string, unknown> | null;
    last_error: string | null;
  }>;
  const site = sourceRows.find((s) => s.type === "website" && !s.config?.["deleted_at"]) ?? null;
  const account =
    (
      (accounts.data ?? []) as Array<{
        display_phone_number: string | null;
        verified_name: string | null;
      }>
    )[0] ?? null;
  const mode = String((agent.data as { mode?: string } | null)?.mode ?? "off");

  const facts: JourneyFacts = {
    hasOrg: true,
    hasMaterial: sourceRows.some((s) => !s.config?.["deleted_at"]),
    connected: Boolean(account),
    connectSkipped: recorded.has("connect_skipped"),
    tested: recorded.has("aiden_tested") || ((tests.data ?? []) as unknown[]).length > 0,
    wentLive: recorded.has("went_live") || mode === "draft" || mode === "replying",
  };
  const step = resumeStep(facts);

  return {
    step,
    facts,
    recorded: Array.from(recorded),
    business: {
      name: String(orgRow.name ?? "").trim(),
      logoUrl: pick("brand_logo_url") ?? pick("logo_url"),
      color: pick("brand_primary"),
    },
    website: site
      ? {
          sourceId: site.id,
          host: site.name ?? "",
          url: typeof site.config?.["url"] === "string" ? String(site.config["url"]) : null,
          status: site.status,
          itemCount: Number(site.item_count ?? 0),
          lastError: site.last_error,
        }
      : null,
    number: account ? { display: account.display_phone_number, name: account.verified_name } : null,
    mode,
    active: recorded.has("started") && !recorded.has("dismissed") && step !== "done",
  };
}

export type LearnedItem = {
  id: string;
  kind: "product" | "page" | "fact";
  title: string;
  detail: string | null;
};

function priceText(price: number | null, currency: string | null): string | null {
  if (price == null || !Number.isFinite(Number(price))) return null;
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: currency || "INR",
      maximumFractionDigits: 2,
    }).format(Number(price));
  } catch {
    return `${currency ?? ""} ${price}`.trim();
  }
}

/**
 * What Aiden knows so far, oldest first so the screen can add the newest at
 * the bottom as they arrive: products (with prices) the reader found, the
 * pages it read, and anything written or sent. Bounded; read-only.
 */
export async function learnedSoFar(
  supabase: SupabaseClient,
  organizationId: string,
  limit = 40,
): Promise<LearnedItem[]> {
  const [products, docs, sources] = await Promise.all([
    supabase
      .from("products")
      .select("id, title, price, currency, synced_at")
      .eq("organization_id", organizationId)
      .eq("is_visible", true)
      .order("synced_at", { ascending: true })
      .limit(limit),
    supabase
      .from("knowledge_documents")
      .select("id, title, source_id, created_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true })
      .limit(limit),
    supabase
      .from("knowledge_sources")
      .select("id, type")
      .eq("organization_id", organizationId)
      .limit(50),
  ]);
  const typeOf = new Map(
    ((sources.data ?? []) as Array<{ id: string; type: string }>).map(
      (s) => [s.id, s.type] as const,
    ),
  );
  const items: LearnedItem[] = [];
  for (const p of (products.data ?? []) as Array<{
    id: string;
    title: string | null;
    price: number | null;
    currency: string | null;
  }>) {
    const title = String(p.title ?? "").trim();
    if (title)
      items.push({
        id: `p:${p.id}`,
        kind: "product",
        title: title.slice(0, 90),
        detail: priceText(p.price, p.currency),
      });
  }
  const seen = new Set<string>();
  for (const d of (docs.data ?? []) as Array<{
    id: string;
    title: string | null;
    source_id: string | null;
  }>) {
    const title =
      String(d.title ?? "")
        .split(/\s+[|–—]\s+/)[0]
        ?.trim() ?? "";
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    const kind = typeOf.get(String(d.source_id ?? "")) === "website" ? "page" : "fact";
    items.push({ id: `d:${d.id}`, kind, title: title.slice(0, 90), detail: null });
  }
  return items.slice(0, limit * 2);
}

/**
 * The onboarding test answers Aiden gave this workspace in the last day —
 * bounds what the platform pays for on the Meet Aiden screen.
 */
export const TESTS_PER_DAY = 30;

export async function testsToday(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<number> {
  const { count } = await supabase
    .from("ai_runs")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("metadata->>purpose", "onboarding_test")
    .gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
  return count ?? 0;
}

/** The worker finished a read: the funnel's website_read, once, for a read that found something. */
export async function recordWebsiteRead(
  supabase: SupabaseClient,
  sourceId: string,
  result: { ok: boolean; itemCount: number },
): Promise<boolean> {
  if (!result.ok || result.itemCount <= 0) return false;
  const { data } = await supabase
    .from("knowledge_sources")
    .select("organization_id, type")
    .eq("id", sourceId)
    .maybeSingle();
  const row = data as { organization_id?: string; type?: string } | null;
  if (!row?.organization_id || row.type !== "website") return false;
  return recordFunnelStep(supabase, {
    organizationId: row.organization_id,
    step: "website_read",
    properties: { source_id: sourceId, pages: result.itemCount },
  });
}
