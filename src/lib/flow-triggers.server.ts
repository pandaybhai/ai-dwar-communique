import type { SupabaseClient } from "@supabase/supabase-js";

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

async function enabledTriggers(
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

async function fire(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    trigger: Trigger;
    contactId: string;
    conversationId?: string | null;
    detail?: Record<string, unknown>;
    /** true → remember the fire so no_reply doesn't re-arm for this contact. */
    remember?: boolean;
  },
): Promise<string | null> {
  const { startRun } = await import("@/lib/flow-engine.server");
  const { runId, reason } = await startRun(supabase, {
    organizationId: args.organizationId,
    flowId: args.trigger.flow_id,
    contactId: args.contactId,
    conversationId: args.conversationId ?? null,
    trigger: { kind: args.trigger.kind, trigger_id: args.trigger.id, ...(args.detail ?? {}) },
  });
  if (runId && args.remember) {
    await supabase
      .from("flow_trigger_fires")
      .upsert(
        {
          organization_id: args.organizationId,
          trigger_id: args.trigger.id,
          contact_id: args.contactId,
          run_id: runId,
        },
        { onConflict: "trigger_id,contact_id" },
      );
  }
  return runId ?? (reason ? null : null);
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

/**
 * Inbound customer message: first_message → ctwa_ad → campaign_button →
 * keyword, first match wins. Called only when no run is waiting for this
 * contact's reply (the flow already owns the conversation then).
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
  },
): Promise<{ started: boolean; flowId?: string }> {
  const { flowsV2Enabled } = await import("@/lib/flow-engine.server");
  if (!(await flowsV2Enabled(supabase, args.organizationId))) return { started: false };

  if (args.isFirstMessageEver) {
    for (const t of await enabledTriggers(supabase, args.organizationId, "first_message")) {
      const runId = await fire(supabase, { organizationId: args.organizationId, trigger: t, contactId: args.contactId, conversationId: args.conversationId });
      if (runId) return { started: true, flowId: t.flow_id };
    }
  }
  if (args.isCtwa) {
    for (const t of await enabledTriggers(supabase, args.organizationId, "ctwa_ad")) {
      const runId = await fire(supabase, { organizationId: args.organizationId, trigger: t, contactId: args.contactId, conversationId: args.conversationId });
      if (runId) return { started: true, flowId: t.flow_id };
    }
  }
  if (args.campaignButton) {
    for (const t of await enabledTriggers(supabase, args.organizationId, "campaign_button")) {
      const cid = (t.config["campaign_id"] as string | null) ?? null;
      const btn = norm(String(t.config["button"] ?? ""));
      if (cid && cid !== args.campaignButton.campaignId) continue;
      if (btn && btn !== norm(args.campaignButton.button ?? "")) continue;
      const runId = await fire(supabase, {
        organizationId: args.organizationId,
        trigger: t,
        contactId: args.contactId,
        conversationId: args.conversationId,
        detail: { campaign_id: args.campaignButton.campaignId, button: args.campaignButton.button },
      });
      if (runId) return { started: true, flowId: t.flow_id };
    }
  }
  if (args.body.trim()) {
    for (const t of await enabledTriggers(supabase, args.organizationId, "keyword")) {
      if (!keywordMatches(t.config, args.body)) continue;
      const runId = await fire(supabase, {
        organizationId: args.organizationId,
        trigger: t,
        contactId: args.contactId,
        conversationId: args.conversationId,
        detail: { keyword_of: args.body.slice(0, 120) },
      });
      if (runId) return { started: true, flowId: t.flow_id };
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
  for (const t of await enabledTriggers(supabase, args.organizationId, "form_submitted")) {
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
  for (const t of await enabledTriggers(supabase, args.organizationId, "tag_added")) {
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
  for (const t of await enabledTriggers(supabase, args.organizationId, "store_event")) {
    if (String(t.config["event"] ?? "") !== args.event) continue;
    await fire(supabase, { organizationId: args.organizationId, trigger: t, contactId: args.contactId, detail: { event: args.event, ...(args.detail ?? {}) } });
  }
}

/**
 * Minute tick: "no reply for N days". A contact qualifies when their last
 * inbound message is older than N days (or they never wrote) and this trigger
 * has never fired for them. Batched so a big workspace doesn't stall the tick.
 */
export async function dispatchNoReply(supabase: SupabaseClient): Promise<{ started: number }> {
  const { data: triggers } = await supabase
    .from("flow_triggers")
    .select("id, organization_id, flow_id, kind, config")
    .eq("kind", "no_reply")
    .eq("is_enabled", true)
    .limit(50);
  let started = 0;
  for (const t of (triggers ?? []) as Array<Trigger & { organization_id: string }>) {
    const days = Math.min(Math.max(Number(t.config["days"] ?? 3), 1), 90);
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    // Contacts whose conversation has gone quiet past the cutoff.
    const { data: convs } = await supabase
      .from("conversations")
      .select("id, contact_id, last_customer_message_at")
      .eq("organization_id", t.organization_id)
      .not("contact_id", "is", null)
      .or(`last_customer_message_at.is.null,last_customer_message_at.lt.${cutoff}`)
      .order("last_customer_message_at", { ascending: true, nullsFirst: true })
      .limit(25);
    for (const c of (convs ?? []) as Array<{ id: string; contact_id: string; last_customer_message_at: string | null }>) {
      // Skip contacts with an active run on any flow — they're being handled.
      const { data: active } = await supabase
        .from("flow_runs")
        .select("id")
        .eq("organization_id", t.organization_id)
        .eq("contact_id", c.contact_id)
        .in("status", ["running", "waiting"])
        .limit(1);
      if (active && active.length) continue;
      const runId = await fire(supabase, {
        organizationId: t.organization_id,
        trigger: t,
        contactId: c.contact_id,
        conversationId: c.id,
        detail: { days },
        remember: true,
      });
      if (runId) started += 1;
    }
  }
  return { started };
}
