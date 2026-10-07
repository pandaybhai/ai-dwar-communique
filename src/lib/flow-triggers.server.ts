import type { SupabaseClient } from "@supabase/supabase-js";
import type { InboundExtras } from "@/lib/flow-engine.server";

/**
 * Flows v2 triggers. One matcher per kind; every match ends in startRun()
 * from the engine, so there is exactly one sending path. Legacy flows
 * (graph.meta.legacy) are never started here — startRun already refuses them.
 */

type Trigger = {
  id: string;
  flow_id: string;
  kind: string;
  config: Record<string, unknown>;
};

async function enabledTriggersAll(
  supabase: SupabaseClient,
  organizationId: string,
  kind: string,
): Promise<Trigger[]> {
  const { data } = await supabase
    .from("flow_triggers")
    .select("id, flow_id, kind, config")
    .eq("organization_id", organizationId)
    .eq("kind", kind)
    .eq("is_enabled", true);
  return (data ?? []) as Trigger[];
}

type PublishedVersion = Awaited<ReturnType<typeof import("@/lib/flow-engine.server").readPublishedVersion>>;

/** Starts the run; the engine records the fire (trigger, flow, contact, run). */
async function fire(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    trigger: Trigger;
    contactId: string;
    conversationId?: string | null;
    detail?: Record<string, unknown>;
    fromCustomerMessage?: boolean;
    extras?: InboundExtras;
    /**
     * Whether a teammate owns `conversationId`, as the webhook read it with
     * the conversation (speed). Absent: read here, as always.
     */
    teammateOwns?: boolean;
    /** The flow's published version, read earlier by prefetchStartVersions (speed). */
    version?: Promise<PublishedVersion>;
  },
): Promise<{ runId: string | null; active: boolean }> {
  // The flow's published version is read alongside the ownership check (one
  // round trip, not two); it is only used when no teammate owns the thread.
  const { startRun, readPublishedVersion } = await import("@/lib/flow-engine.server");
  const version = args.version ?? readPublishedVersion(supabase, args.organizationId, args.trigger.flow_id);
  // A conversation a teammate has taken over is theirs: no trigger starts a
  // flow in it (the same rule the AI follows — see ai-agent.server.ts).
  const owned =
    args.teammateOwns !== undefined && args.conversationId
      ? args.teammateOwns
      : await humanOwnsConversation(supabase, args.organizationId, args.contactId, args.conversationId ?? null);
  if (owned) return { runId: null, active: false };
  const { runId, reason } = await startRun(supabase, {
    version,
    ...(args.extras ? { extras: args.extras } : {}),
    organizationId: args.organizationId,
    flowId: args.trigger.flow_id,
    contactId: args.contactId,
    conversationId: args.conversationId ?? null,
    trigger: { kind: args.trigger.kind, trigger_id: args.trigger.id, ...(args.detail ?? {}) },
    fromCustomerMessage: Boolean(args.fromCustomerMessage),
  });
  // already_running: a duplicate "menu" raced the first one — the flow owns it.
  return { runId, active: Boolean(runId) || reason === "already_running" };
}

/**
 * True when a teammate owns the conversation (conversations.assigned_to set).
 * With no conversation (tag, store event, form) any open conversation of the
 * contact that a teammate owns counts.
 */
export async function humanOwnsConversation(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
  conversationId: string | null,
): Promise<boolean> {
  let q = supabase
    .from("conversations")
    .select("id")
    .eq("organization_id", organizationId)
    .not("assigned_to", "is", null);
  q = conversationId ? q.eq("id", conversationId) : q.eq("contact_id", contactId).eq("status", "open");
  const { data } = await q.limit(1);
  return Boolean(data && data.length);
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

export function keywordMatches(config: Record<string, unknown>, body: string): boolean {
  const keywords = ((config["keywords"] as string[] | undefined) ?? []).map(norm).filter(Boolean);
  if (!keywords.length) return false;
  const text = norm(body);
  const mode = String(config["match"] ?? "contains");
  return keywords.some((k) => {
    // A keyword may itself be a /regex/ — kept simple: only plain text here,
    // regex lives in branch conditions. Hindi + English both work since we
    // compare normalized Unicode text.
    if (mode === "exact") return text === k;
    if (mode === "starts_with") return text.startsWith(k);
    return text.includes(k);
  });
}

/** The enabled inbound triggers (every inbound kind) with their flows' numbers. Read-only. */
export function readInboundTriggers(supabase: SupabaseClient, organizationId: string) {
  return Promise.resolve(
    supabase
      .from("flow_triggers")
      .select("id, flow_id, kind, config, flows(whatsapp_account_id)")
      .eq("organization_id", organizationId)
      .in("kind", ["first_message", "ctwa_ad", "campaign_button", "keyword"])
      .eq("is_enabled", true),
  ).then(
    (r) => ({ data: r.data as unknown[] | null }),
    () => ({ data: null as unknown[] | null }),
  );
}

type InboundTrigger = Trigger & { flows: { whatsapp_account_id: string | null } | null };

/** The triggers that may start on this number (see dispatchInboundTriggers). */
function onThisNumber(rows: unknown[] | null, accountId: string | null | undefined, onlyAccountId: string | null | undefined): InboundTrigger[] {
  return ((rows ?? []) as unknown as InboundTrigger[]).filter((t) => {
    const pinned = t.flows?.whatsapp_account_id ?? null;
    if (onlyAccountId) return pinned === onlyAccountId;
    return !pinned || !accountId || pinned === accountId;
  });
}

/** Keyword triggers this text matches, highest priority first. */
function keywordCandidates(all: InboundTrigger[], body: string): InboundTrigger[] {
  return all
    .filter((t) => t.kind === "keyword" && keywordMatches(t.config, body))
    .sort((x, y) => Number(y.config["priority"] ?? 0) - Number(x.config["priority"] ?? 0));
}

/**
 * Speed: as soon as the inbound triggers are read (while the message is still
 * being stored), the published version of the flow each kind would try first
 * is read too, so a start doesn't wait for it. Read-only; a message that
 * starts nothing just leaves the reads unused (none at all when no trigger
 * could match it).
 */
export function prefetchStartVersions(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    triggers: ReturnType<typeof readInboundTriggers>;
    body: string;
    isFirstMessageEver: boolean;
    isCtwa: boolean;
    accountId?: string | null;
    onlyAccountId?: string | null;
  },
): Promise<Map<string, Promise<PublishedVersion>>> {
  const read = args.triggers.then(async ({ data }) => {
    const all = onThisNumber(data, args.accountId, args.onlyAccountId);
    const flows = new Set<string>();
    if (args.isFirstMessageEver) {
      const t = all.find((x) => x.kind === "first_message");
      if (t) flows.add(t.flow_id);
    }
    if (args.isCtwa) {
      const t = all.find((x) => x.kind === "ctwa_ad");
      if (t) flows.add(t.flow_id);
    }
    if (args.body.trim()) {
      const t = keywordCandidates(all, args.body)[0];
      if (t) flows.add(t.flow_id);
    }
    const versions = new Map<string, Promise<PublishedVersion>>();
    if (flows.size === 0) return versions;
    const { readPublishedVersion } = await import("@/lib/flow-engine.server");
    for (const flowId of flows) versions.set(flowId, readPublishedVersion(supabase, args.organizationId, flowId));
    return versions;
  });
  read.catch(() => {});
  return read;
}

/**
 * Inbound customer message: first_message → ctwa_ad → campaign_button →
 * keyword, first match wins. Called only when no run is active for this
 * contact (the flow already owns the conversation then).
 *
 * Which number: a flow pinned to a number only starts on that number; an
 * unpinned flow starts on any number except the onboarding number
 * (`onlyAccountId`), where only flows pinned to it may run.
 * Keywords shared by several flows: the trigger with the highest
 * config.priority wins (the owner sets it in the Triggers panel).
 */
export async function dispatchInboundTriggers(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string;
    conversationId: string;
    body: string;
    isFirstMessageEver: boolean;
    isCtwa: boolean;
    campaignButton: { campaignId: string | null; button: string | null } | null;
    /** The number the message came in on. */
    accountId?: string | null;
    /** Only flows pinned to this number may start (used for the onboarding number). */
    onlyAccountId?: string | null;
    /**
     * The contact still has an active run (the message was released to normal
     * routing during a timer/payment wait): keywords must not start a flow.
     */
    skipKeywords?: boolean;
    /** readInboundTriggers() started earlier by the webhook (speed). */
    triggers?: ReturnType<typeof readInboundTriggers>;
    /** Timings, the window write and the message time (see InboundExtras). */
    extras?: InboundExtras;
    /** Whether a teammate owns conversationId, read with the conversation (speed). */
    teammateOwns?: boolean;
    /** prefetchStartVersions() started earlier by the webhook (speed). */
    versions?: ReturnType<typeof prefetchStartVersions>;
  },
): Promise<{ started: boolean; flowId?: string }> {
  const { flowsV2Enabled } = await import("@/lib/flow-engine.server");
  // One read for every inbound trigger kind, plus the flows' numbers.
  const [on, { data: trigRows }, versions] = await Promise.all([
    flowsV2Enabled(supabase, args.organizationId),
    args.triggers ?? readInboundTriggers(supabase, args.organizationId),
    args.versions ? args.versions.catch(() => null) : Promise.resolve(null),
  ]);
  if (!on) return { started: false };
  const all = onThisNumber(trigRows, args.accountId, args.onlyAccountId);
  const ofKind = (kind: string) => all.filter((t) => t.kind === kind);
  const base = {
    fromCustomerMessage: true,
    organizationId: args.organizationId,
    contactId: args.contactId,
    conversationId: args.conversationId,
    ...(args.extras ? { extras: args.extras } : {}),
    ...(args.teammateOwns !== undefined ? { teammateOwns: args.teammateOwns } : {}),
  };
  // A prefetched version is used once, by the first fire of its flow.
  const take = (flowId: string): { version?: Promise<PublishedVersion> } => {
    const v = versions?.get(flowId);
    if (!v) return {};
    versions!.delete(flowId);
    return { version: v };
  };
  const matched = () => args.extras?.timer?.mark("trigger_matched");

  if (args.isFirstMessageEver) {
    for (const t of ofKind("first_message")) {
      matched();
      if ((await fire(supabase, { ...base, ...take(t.flow_id), trigger: t })).active) return { started: true, flowId: t.flow_id };
    }
  }
  if (args.isCtwa) {
    for (const t of ofKind("ctwa_ad")) {
      matched();
      if ((await fire(supabase, { ...base, ...take(t.flow_id), trigger: t })).active) return { started: true, flowId: t.flow_id };
    }
  }
  if (args.campaignButton) {
    for (const t of ofKind("campaign_button")) {
      const cid = (t.config["campaign_id"] as string | null) ?? null;
      const btn = norm(String(t.config["button"] ?? ""));
      if (cid && cid !== args.campaignButton.campaignId) continue;
      if (btn && btn !== norm(args.campaignButton.button ?? "")) continue;
      matched();
      const r = await fire(supabase, { ...base, ...take(t.flow_id), trigger: t, detail: { campaign_id: args.campaignButton.campaignId, button: args.campaignButton.button } });
      if (r.active) return { started: true, flowId: t.flow_id };
    }
  }
  if (args.body.trim() && !args.skipKeywords) {
    const keyword = keywordCandidates(all, args.body);
    for (const t of keyword) {
      matched();
      const r = await fire(supabase, { ...base, ...take(t.flow_id), trigger: t, detail: { keyword_of: args.body.slice(0, 120) } });
      if (r.active) return { started: true, flowId: t.flow_id };
    }
  }
  return { started: false };
}

/** A WhatsApp form was submitted. */
export async function dispatchFormSubmitted(
  supabase: SupabaseClient,
  args: { organizationId: string; contactId: string; conversationId: string | null; formId: string | null },
): Promise<void> {
  const { flowsV2Enabled } = await import("@/lib/flow-engine.server");
  if (!(await flowsV2Enabled(supabase, args.organizationId))) return;
  for (const t of await enabledTriggersAll(supabase, args.organizationId, "form_submitted")) {
    const fid = (t.config["form_id"] as string | null) ?? null;
    if (fid && fid !== args.formId) continue;
    await fire(supabase, {
      organizationId: args.organizationId,
      trigger: t,
      contactId: args.contactId,
      conversationId: args.conversationId,
      detail: { form_id: args.formId },
    });
  }
}

/** A tag was added to a contact (any path: flow, AI tool, import, manual). */
export async function dispatchTagAdded(
  supabase: SupabaseClient,
  args: { organizationId: string; contactId: string; tag: string },
): Promise<void> {
  const { flowsV2Enabled } = await import("@/lib/flow-engine.server");
  if (!(await flowsV2Enabled(supabase, args.organizationId))) return;
  const tag = norm(args.tag);
  for (const t of await enabledTriggersAll(supabase, args.organizationId, "tag_added")) {
    if (norm(String(t.config["tag"] ?? "")) !== tag) continue;
    await fire(supabase, { organizationId: args.organizationId, trigger: t, contactId: args.contactId, detail: { tag: args.tag } });
  }
}

/**
 * A store event fired (abandoned checkout, order created, …). Legacy event
 * flows keep their own scheduler — this only starts v2 flows that explicitly
 * asked for the event.
 */
export async function dispatchStoreEvent(
  supabase: SupabaseClient,
  args: { organizationId: string; contactId: string; event: string; detail?: Record<string, unknown> },
): Promise<void> {
  const { flowsV2Enabled } = await import("@/lib/flow-engine.server");
  if (!(await flowsV2Enabled(supabase, args.organizationId))) return;
  for (const t of await enabledTriggersAll(supabase, args.organizationId, "store_event")) {
    if (String(t.config["event"] ?? "") !== args.event) continue;
    await fire(supabase, { organizationId: args.organizationId, trigger: t, contactId: args.contactId, detail: { event: args.event, ...(args.detail ?? {}) } });
  }
}

const NO_REPLY_PER_TICK = 25;
const NO_REPLY_PAGE = 200;
const NO_REPLY_MAX_PAGES = 5;
const NO_REPLY_MAX_ATTEMPTS = 100;

/**
 * Minute tick: "no reply for N days". A contact qualifies when they have
 * written to us at least once, their last inbound message is older than N
 * days, they have no active run, and this trigger has never fired for them.
 * Pages past contacts that already fired (or are busy) so the same few are
 * never re-picked every tick; at most 25 starts (100 attempts) per trigger per tick.
 */
export async function dispatchNoReply(
  supabase: SupabaseClient,
  options: { deadlineAt?: number } = {},
): Promise<{ started: number; deferred?: true }> {
  // Past the worker's deadline no new run is started; the next tick goes on.
  const pastDeadline = () => options.deadlineAt != null && Date.now() >= options.deadlineAt;
  const { data: triggers } = await supabase
    .from("flow_triggers")
    .select("id, organization_id, flow_id, kind, config")
    .eq("kind", "no_reply")
    .eq("is_enabled", true)
    .limit(50);
  let started = 0;
  for (const t of (triggers ?? []) as Array<Trigger & { organization_id: string }>) {
    if (pastDeadline()) return { started, deferred: true };
    const days = Math.min(Math.max(Number(t.config["days"] ?? 3), 1), 90);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const seen = new Set<string>();
    let picked = 0;
    let attempts = 0;
    const full = () => picked >= NO_REPLY_PER_TICK || attempts >= NO_REPLY_MAX_ATTEMPTS;
    for (let page = 0; page < NO_REPLY_MAX_PAGES && !full(); page += 1) {
      // Conversations gone quiet past the cutoff — only ones the customer wrote in.
      const { data: convs } = await supabase
        .from("conversations")
        .select("id, contact_id, last_customer_message_at")
        .eq("organization_id", t.organization_id)
        .not("contact_id", "is", null)
        .not("last_customer_message_at", "is", null)
        .lt("last_customer_message_at", cutoff)
        .order("last_customer_message_at", { ascending: true })
        .order("id", { ascending: true })
        .range(page * NO_REPLY_PAGE, page * NO_REPLY_PAGE + NO_REPLY_PAGE - 1);
      const rows = (convs ?? []) as Array<{ id: string; contact_id: string; last_customer_message_at: string | null }>;
      const fresh = rows.filter((c) => !seen.has(c.contact_id));
      for (const c of fresh) seen.add(c.contact_id);
      const contactIds = [...new Set(fresh.map((c) => c.contact_id))];
      if (contactIds.length) {
        // One read each for the whole page: already fired, or busy in a flow.
        const [{ data: firedRows }, { data: activeRows }] = await Promise.all([
          supabase.from("flow_trigger_fires").select("contact_id").eq("trigger_id", t.id).in("contact_id", contactIds),
          supabase
            .from("flow_runs")
            .select("contact_id")
            .eq("organization_id", t.organization_id)
            .in("contact_id", contactIds)
            .in("status", ["running", "waiting"]),
        ]);
        const skip = new Set(
          [...((firedRows ?? []) as Array<{ contact_id: string }>), ...((activeRows ?? []) as Array<{ contact_id: string }>)].map((r) => r.contact_id),
        );
        const done = new Set<string>();
        for (const c of fresh) {
          if (full()) break;
          if (pastDeadline()) return { started, deferred: true };
          if (skip.has(c.contact_id) || done.has(c.contact_id)) continue;
          done.add(c.contact_id);
          attempts += 1;
          const { runId } = await fire(supabase, {
            organizationId: t.organization_id,
            trigger: t,
            contactId: c.contact_id,
            conversationId: c.id,
            detail: { days },
          });
          if (runId) {
            started += 1;
            picked += 1;
          }
        }
      }
      if (rows.length < NO_REPLY_PAGE) break;
    }
  }
  return { started };
}
