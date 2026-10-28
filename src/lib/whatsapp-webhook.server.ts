import type { KnowledgeAhead } from "@/lib/ai-agent.server";
import { outsideFetch } from "@/lib/outside-call.server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { detectLanguage } from "@/lib/languages";
import { readCodIntent } from "@/lib/cod";
import { normalizePhone, toWaId } from "@/lib/phone";
import {
  DEFAULT_OPT_IN_KEYWORDS,
  DEFAULT_OPT_OUT_KEYWORDS,
  OPT_IN_CONFIRMATION,
  OPT_OUT_CONFIRMATION,
  matchKeyword,
  qualityLabel,
} from "@/lib/opt-out";
import { sendServiceText } from "@/lib/service-text.server";
import {
  ACCOUNT_COLUMNS,
  connectionForAccount,
  getWhatsAppConnection,
  type AccountRow,
} from "@/lib/whatsapp-numbers.server";
import { replyTimer, type MessageTiming, type ReplyTimer } from "@/lib/reply-timing";
import {
  evaluateAutomations,
  loadAutomations,
  loadOrgTimezone,
} from "@/lib/automations.server";
import type { AutomationRow } from "@/lib/automations";
import { emitEvent } from "@/lib/events.server";
import { parseCampaignCallbackData } from "@/lib/campaign-callback";

/** Service-role client for the AiDwar (Mumbai) backend. Server-only. */
export function getServiceClient(): SupabaseClient {
  const url = new URL(process.env["AIDWAR_SUPABASE_URL"]!).origin;
  return createClient(url, process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Batch 29: the burst wait is adaptive. People type in bursts — a
 * half-sentence, then the whole one. Aiden answers as soon as the customer
 * has been quiet for `quietMs` since their latest message, and never later
 * than `capMs` after the first message of the burst. Both are platform
 * settings (platform_settings.ai_burst_quiet_ms / ai_burst_cap_ms, Super
 * Admin → AI, migration 20261090); missing columns, a missing row or a failed
 * read mean these defaults. Before: one fixed window
 * (platform_settings.ai_burst_wait_ms, waits up to ~4.7 s live), no longer read.
 */
export const DEFAULT_BURST_QUIET_MS = 1500;
export const DEFAULT_BURST_CAP_MS = 3000;
/** The settings' allowed range (the database checks match). */
export const MAX_BURST_WINDOW_MS = 10_000;

export type BurstSettings = { quietMs: number; capMs: number };

let burstSetting: { value: BurstSettings; at: number } | null = null;

const inRange = (raw: unknown): raw is number =>
  typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= MAX_BURST_WINDOW_MS;

/**
 * The platform's burst settings, read at most once a minute per worker. A
 * missing row, a missing column or a failed read means the defaults — the
 * setting can never stop a reply. A quiet gap above the cap is cut to it.
 */
export async function burstSettings(supabase: SupabaseClient, now = Date.now()): Promise<BurstSettings> {
  if (burstSetting && now - burstSetting.at < 60_000) return burstSetting.value;
  let quietMs = DEFAULT_BURST_QUIET_MS;
  let capMs = DEFAULT_BURST_CAP_MS;
  try {
    const { data, error } = await supabase
      .from("platform_settings")
      .select("ai_burst_quiet_ms, ai_burst_cap_ms")
      .eq("id", true)
      .maybeSingle();
    const row = error ? null : (data as { ai_burst_quiet_ms?: unknown; ai_burst_cap_ms?: unknown } | null);
    if (inRange(row?.ai_burst_quiet_ms)) quietMs = Math.round(row.ai_burst_quiet_ms);
    if (inRange(row?.ai_burst_cap_ms)) capMs = Math.round(row.ai_burst_cap_ms);
  } catch {
    // the defaults
  }
  const value = { quietMs: Math.min(quietMs, capMs), capMs };
  burstSetting = { value, at: now };
  return value;
}

/** Drop the cached settings after an admin save so the change is live at once in this worker. */
export function resetBurstWindowCache(): void {
  burstSetting = null;
}

type BurstRow = { id: string; direction: string; body: string | null; created_at: string };

/**
 * The first message of the burst `mine` belongs to: walking back through the
 * customer's texts while each came less than `quietMs` (+1 s: WhatsApp's
 * timestamps are whole seconds) after the one before, stopping at a reply.
 */
export function burstStartOf(rows: BurstRow[], mine: number, quietMs: number): number {
  let start = mine;
  let next = mine;
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]!;
    const at = Date.parse(r.created_at);
    if (!Number.isFinite(at) || at > next) continue;
    if (r.direction === "outbound") break;
    if (!(r.body ?? "").trim()) continue;
    if (next - at > quietMs + 1000) break;
    start = Math.min(start, at);
    next = at;
  }
  return start;
}

/**
 * Wait out the burst: answer once the customer has been quiet for quietMs
 * (or once capMs has passed since the burst's first message), from the
 * newest message's pass. The last text in the burst answers for all of them;
 * every earlier delivery stands down, so the customer gets exactly one reply.
 */
export async function coalesceBurst(
  supabase: SupabaseClient,
  args: {
    conversationId: string;
    messageId: string | null;
    occurredAt: string;
    body: string | null;
    /**
     * When the message row was written (ms). The quiet gap runs from there,
     * so the guards, flows and automations that already ran count toward it
     * instead of being added in front of it.
     */
    storedAt?: number;
    /** Called the moment the wait is over, before the burst is read (the caller's own reads start then). */
    afterWait?: () => void;
    /** burstSettings(); left out, the defaults. */
    settings?: BurstSettings;
    /** Test clock. */
    now?: () => number;
  },
): Promise<{ proceed: boolean; body: string | null; waitedMs: number }> {
  const now = args.now ?? Date.now;
  const started = now();
  const { quietMs, capMs } = args.settings ?? { quietMs: DEFAULT_BURST_QUIET_MS, capMs: DEFAULT_BURST_CAP_MS };
  const text = (args.body ?? "").trim();
  if (!text || !args.messageId) {
    args.afterWait?.();
    return { proceed: true, body: args.body, waitedMs: 0 };
  }

  const mine = args.storedAt ?? started;
  const lookBack = new Date(new Date(args.occurredAt).getTime() - capMs - 1000).toISOString();
  const readBurst = async () => {
    const { data } = await supabase
      .from("messages")
      .select("id, direction, body, created_at")
      .eq("conversation_id", args.conversationId)
      .gte("created_at", lookBack)
      .order("created_at", { ascending: true })
      .limit(30);
    return (data ?? []) as BurstRow[];
  };

  // Where this burst began: read while the quiet gap runs (it never adds to it).
  // A message alone in its burst waits the quiet gap; one late in a long
  // burst waits only until the cap since the burst's first message.
  // Message times are WhatsApp's (whole seconds, sent before delivery); they
  // are moved onto our clock by this message's own delivery offset, so a
  // message alone in its burst always waits the full quiet gap.
  // (Nothing to wait for any more: no read.)
  const earlier = mine + quietMs > now() ? await readBurst().catch(() => [] as BurstRow[]) : [];
  const myAt = earlier.find((r) => r.id === args.messageId)?.created_at;
  const myMeta = myAt ? Date.parse(myAt) : NaN;
  const firstMeta = Number.isFinite(myMeta)
    ? burstStartOf(earlier.filter((r) => r.id !== args.messageId), myMeta, quietMs)
    : NaN;
  const firstAt = Number.isFinite(firstMeta) ? firstMeta : Date.parse(args.occurredAt);
  const firstOurs = Number.isFinite(firstMeta) ? mine - (myMeta - firstMeta) : mine;
  const until = Math.min(mine + quietMs, firstOurs + capMs);
  const wait = until - now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  args.afterWait?.();

  const rows = await readBurst();
  const waitedMs = Math.max(0, now() - started);

  // Something already replied in this burst: leave the usual path to it.
  const sinceFirst = rows.filter((r) => {
    const at = Date.parse(r.created_at);
    return !Number.isFinite(at) || at >= firstAt - 1000;
  });
  if (sinceFirst.some((r) => r.direction === "outbound")) return { proceed: true, body: args.body, waitedMs };

  const inbound = sinceFirst.filter((r) => r.direction === "inbound" && (r.body ?? "").trim());
  const index = inbound.findIndex((r) => r.id === args.messageId);
  // A newer message came in: its pass answers for the whole burst.
  if (index >= 0 && index < inbound.length - 1) return { proceed: false, body: null, waitedMs };

  const before = inbound
    .slice(0, Math.max(index, 0))
    .map((r) => (r.body ?? "").trim())
    .filter((t) => t && !text.toLowerCase().includes(t.toLowerCase()));
  return { proceed: true, body: [...before, text].join("\n"), waitedMs };
}

/**
 * Marks a customer's message read and shows the typing dots (WhatsApp Cloud
 * API; they last until our reply arrives or ~25 s). Never awaited on the
 * reply's path: it never delays or blocks a reply, and a failure is silent.
 * The caller hands the returned promise to the webhook's later() so the
 * request isn't over before it is sent.
 *
 * Batch 28: called only once a reply is certain to go (Aiden in Replying
 * mode past its gates, an owner's message on the AiDwar number) — dots
 * followed by nothing (Draft mode, Aiden off, a stale button) are gone.
 */
export function showTyping(
  connection: Promise<{ accessToken?: string | null } | null>,
  phoneNumberId: string,
  messageId: string,
): Promise<unknown> {
  if (!messageId) return Promise.resolve();
  return connection
    .then((c) => {
      if (!c?.accessToken) return;
      return outsideFetch("meta", `https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${c.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          typing_indicator: { type: "text" },
        }),
      });
    })
    .catch(() => {});
}

/** Timing-safe hex compare. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Verify Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw body). */
export async function verifyMetaSignature(
  rawBody: string,
  header: string | null,
  appSecret: string | undefined,
): Promise<boolean> {
  if (!header || !appSecret) return false;
  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return safeEqual(provided.toLowerCase(), expected);
}

/** A runtime's "keep working after the response" hook, when it has one. */
export type WaitUntil = (work: Promise<unknown>) => void;

/**
 * The runtime's waitUntil for this request. On Cloudflare, nitro puts it on
 * the Request itself (request.waitUntil, or runtime.cloudflare.context);
 * src/server.ts adds it from the worker's ctx when neither is there. null in
 * dev and tests — the caller then processes before answering, as before.
 */
export function waitUntilOf(request: Request): WaitUntil | null {
  const r = request as Request & {
    waitUntil?: WaitUntil;
    runtime?: { cloudflare?: { context?: { waitUntil?: WaitUntil } } };
  };
  if (typeof r.waitUntil === "function") return r.waitUntil;
  const ctx = r.runtime?.cloudflare?.context;
  if (ctx && typeof ctx.waitUntil === "function") return ctx.waitUntil.bind(ctx);
  return null;
}

/**
 * Meta's webhook POST. The event is stored first, then Meta gets its 200
 * straight away and the payload is processed after the response (waitUntil),
 * so a slow reply (the AI can take 20 s) never makes Meta redeliver. Exactly
 * one processing pass for this payload, as before: dedupe (meta_message_id),
 * retries (finishEvent) and processed_at are unchanged, and anything the
 * background pass doesn't finish is picked up by /api/internal/reprocess-events.
 */
export async function acceptWebhook(
  supabase: SupabaseClient,
  args: {
    rawBody: string;
    signatureValid: boolean;
    waitUntil: WaitUntil | null;
    process?: typeof processWebhookPayload;
  },
): Promise<Response> {
  const started = Date.now();
  // An unsigned body is never stored or processed (live: every Meta event is signed).
  if (!args.signatureValid) return new Response("Invalid signature", { status: 401 });
  let payload: AnyRecord;
  try {
    payload = JSON.parse(args.rawBody) as AnyRecord;
  } catch {
    payload = { _unparsable: args.rawBody.slice(0, 5000) };
  }

  // Only for a signed payload with customer messages: the first reads start
  // alongside the store (they never write anything).
  const prefetch = args.signatureValid ? prefetchInbound(supabase, payload) : undefined;
  const { data: event } = await supabase
    .from("webhook_events")
    .insert({ provider: "meta", payload, signature_valid: args.signatureValid })
    .select("id, received_at")
    .single();
  const storeMs = Date.now() - started;
  // Not stored = not ours yet: Meta retries a non-2xx, so nothing is lost.
  if (!event) {
    console.error(JSON.stringify({ scope: "webhook_ack", event_id: null, stored: false }));
    return new Response("Not stored", { status: 500 });
  }

  let background = false;
  if (args.signatureValid && event) {
    const run = args.process ?? processWebhookPayload;
    const work = run(
      supabase,
      event.id as string,
      payload,
      (event.received_at as string | null) ?? null,
      { storeMs, ...(prefetch ? { prefetch } : {}) },
    ).catch(() => {
      // processWebhookPayload records its own errors
    });
    if (args.waitUntil) {
      args.waitUntil(work);
      background = true;
    } else {
      await work;
    }
  }

  console.log(
    JSON.stringify({
      scope: "webhook_ack",
      event_id: (event?.id as string | undefined) ?? null,
      background,
      ack_ms: Date.now() - started,
    }),
  );
  return new Response("ok", { status: 200 });
}

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

const REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Mirrors a message status onto its campaign recipient (monotonic) and bumps
 * the campaign's delivered/read/failed counters exactly once per transition,
 * in one database call (campaign_recipient_status, 20261016_send_at_scale.sql),
 * so two copies of the same webhook processed together can't both count it.
 * The recipient is found by id when Meta echoed our callback data (it may not
 * have its message id yet — the sender writes in batches), else by message.
 */
async function applyCampaignStatus(
  supabase: SupabaseClient,
  messageId: string,
  nextStatus: string,
  errorDetail: string | null,
  recipientId: string | null = null,
): Promise<string | null> {
  // Batch 28 (item 8): never throws. The message's own status, its price and
  // its event never depend on this counter (8 Oct: the function wasn't on
  // live and every campaign status failed, unpriced). A failure is logged on
  // its own and returned, so the event stays retryable for the counter alone
  // (the retry finds the message already moved and redoes only this and an
  // unpriced message's price — retakeStatusSteps; the function is idempotent).
  try {
    const { error } = await supabase.rpc("campaign_recipient_status", {
      p_message_id: messageId,
      p_recipient_id: recipientId,
      p_status: nextStatus,
      p_error: errorDetail,
    });
    if (!error) return null;
    console.warn(
      JSON.stringify({ scope: "campaign_counter", message_id: messageId, status: nextStatus, code: error.code ?? null, error: error.message }),
    );
    return `counter: ${error.message}`;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({ scope: "campaign_counter", message_id: messageId, status: nextStatus, error: text }));
    return `counter: ${text}`;
  }
}

/** Messages from before attribution lived on the row (first attributed send: 2026-08-14). */
const ATTRIBUTION_SINCE = "2026-08-15T00:00:00Z";

const TEMPLATE_CATEGORY_TTL_MS = 5 * 60_000;
const templateCategoryCache = new Map<string, { at: number; category: string }>();

type StatusRow = {
  id: string;
  status?: string | null;
  type?: string | null;
  template_name?: string | null;
  conversation_id?: string | null;
  campaign_id?: string | null;
  flow_id?: string | null;
  flow_step_id?: string | null;
  scheduled_send_id?: string | null;
  created_at?: string | null;
  /** Batch 34: metadata.source "api" marks a message the Public API sent. */
  metadata?: Record<string, unknown> | null;
  /** Embedded with the status update, so it isn't read a second time. */
  conversations?: { contact_id?: string | null; whatsapp_account_id?: string | null } | null;
};

/**
 * Shared dimensions for message.sent/delivered/read/failed: which campaign or
 * flow the message belonged to, the template, the business account, the billing
 * category and the marketing/transactional class. Attribution now lives on the
 * messages row itself, so the status callbacks carry exactly the same
 * dimensions the send path emitted. Lookup failures degrade to nulls — capture
 * never blocks the webhook. The conversation usually comes embedded in the
 * status update and the template's category from a short cache, so a status
 * costs no extra reads here.
 */
async function messageEventDimensions(
  supabase: SupabaseClient,
  organizationId: string,
  wabaId: string | null,
  message: StatusRow,
): Promise<Record<string, unknown>> {
  const { outboundMessageDimensions } = await import("@/lib/message-events");
  const templateName = message.template_name ?? null;
  let contactId: string | null = null;
  let campaignId = message.campaign_id ?? null;
  let flowId = message.flow_id ?? null;
  let flowStepId = message.flow_step_id ?? null;
  let scheduledSendId = message.scheduled_send_id ?? null;
  let billingCategory = templateName ? "utility" : "service";
  let accountId: string | null = null;

  try {
    // Older rows predate the attribution columns; fall back to the recipient row.
    const legacy = !message.created_at || message.created_at < ATTRIBUTION_SINCE;
    if (!campaignId && !flowId && legacy) {
      const { data: recipient } = await supabase
        .from("campaign_recipients")
        .select("campaign_id, contact_id")
        .eq("message_id", message.id)
        .maybeSingle();
      campaignId = (recipient?.campaign_id as string) ?? null;
      contactId = (recipient?.contact_id as string) ?? null;

      if (!campaignId) {
        const { data: send } = await supabase
          .from("scheduled_sends")
          .select("id, flow_id, flow_step_id")
          .eq("message_id", message.id)
          .maybeSingle();
        flowId = (send?.flow_id as string) ?? null;
        flowStepId = (send?.flow_step_id as string) ?? null;
        scheduledSendId = (send?.id as string) ?? null;
      }
    }

    if (message.conversations !== undefined) {
      contactId = contactId ?? (message.conversations?.contact_id ?? null);
      accountId = message.conversations?.whatsapp_account_id ?? null;
    } else if (message.conversation_id) {
      const { data: conv } = await supabase
        .from("conversations")
        .select("contact_id, whatsapp_account_id")
        .eq("id", message.conversation_id)
        .maybeSingle();
      contactId = contactId ?? ((conv?.contact_id as string) ?? null);
      accountId = (conv?.whatsapp_account_id as string) ?? null;
    }

    if (templateName) {
      const key = `${organizationId}:${wabaId ?? ""}:${templateName}`;
      const hit = templateCategoryCache.get(key);
      if (hit && Date.now() - hit.at < TEMPLATE_CATEGORY_TTL_MS) {
        billingCategory = hit.category;
      } else {
        let query = supabase
          .from("message_templates")
          .select("category")
          .eq("organization_id", organizationId)
          .eq("name", templateName);
        if (wabaId) query = query.eq("waba_id", wabaId);
        const { data: tpl, error } = await query.limit(1).maybeSingle();
        billingCategory = String((tpl as { category?: string } | null)?.category ?? "utility");
        if (!error) templateCategoryCache.set(key, { at: Date.now(), category: billingCategory });
      }
    }
  } catch {
    // dimensions are best-effort
  }

  return outboundMessageDimensions({
    messageId: message.id,
    conversationId: message.conversation_id ?? null,
    contactId,
    wabaId,
    whatsappAccountId: accountId,
    templateName,
    messageType: message.type ?? null,
    billingCategory,
    campaignId,
    flowId,
    flowStepId,
    scheduledSendId,
  });
}

const STATUS_ROW_COLUMNS =
  "id, status, type, template_name, conversation_id, campaign_id, flow_id, flow_step_id, scheduled_send_id, created_at, metadata";
let statusEmbedBrokenUntil = 0;

/**
 * Moves one message to `nextStatus` in a single conditional update and
 * returns the row — or null when there is no such message or it is already
 * there (never downgrades; a failed message stays failed). A failure is
 * applied whatever the current status, as before.
 */
async function applyMessageStatus(
  supabase: SupabaseClient,
  organizationId: string,
  metaId: string,
  nextStatus: string,
  patch: Record<string, unknown>,
): Promise<StatusRow | null> {
  const run = (columns: string) => {
    let q = supabase
      .from("messages")
      .update(patch)
      .eq("meta_message_id", metaId)
      .eq("organization_id", organizationId);
    if (nextStatus !== "failed") {
      const rank = STATUS_RANK[nextStatus]!;
      const notBelow = ["failed", ...Object.keys(STATUS_RANK).filter((k) => STATUS_RANK[k]! >= rank)];
      // Not .or(): PostgREST re-applies an or=() filter to the rows it
      // returns, so the updated row (now at the new status) would come back
      // empty. Outbound messages always carry a status (never NULL).
      q = q.not("status", "in", `(${notBelow.join(",")})`);
    }
    return q.select(columns);
  };
  if (Date.now() >= statusEmbedBrokenUntil) {
    const { data, error } = await run(
      `${STATUS_ROW_COLUMNS}, conversations(contact_id, whatsapp_account_id)`,
    );
    if (!error) return ((data as unknown as StatusRow[] | null) ?? [])[0] ?? null;
    // A failed statement changed nothing; try once more without the embed.
    statusEmbedBrokenUntil = Date.now() + 10 * 60_000;
  }
  const { data, error } = await run(STATUS_ROW_COLUMNS);
  if (error) throw new Error(error.message);
  return ((data as unknown as StatusRow[] | null) ?? [])[0] ?? null;
}

/**
 * A status for one of our campaign messages whose row isn't written yet:
 * the sender writes rows in batches a moment after Meta accepts them. Wait
 * a little and apply it then. `undefined` = still not there (the event is
 * left for the retry pass rather than losing the status).
 */
async function applyWhenWritten(
  supabase: SupabaseClient,
  organizationId: string,
  metaId: string,
  nextStatus: string,
  patch: Record<string, unknown>,
): Promise<StatusRow | null | undefined> {
  for (const waitMs of [0, 500, 1500, 3000]) {
    if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
    const { data } = await supabase
      .from("messages")
      .select("id")
      .eq("meta_message_id", metaId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (data) return await applyMessageStatus(supabase, organizationId, metaId, nextStatus, patch);
  }
  return undefined;
}

/**
 * A status the message already has: redo what a failed first try may have
 * missed. The recipient move is conditional (counted once), and a message
 * with no price yet is priced (price_message is idempotent and a message is
 * debited at most once). Costs one read, only on this path. False when
 * there is no such message (yet).
 */
async function retakeStatusSteps(
  supabase: SupabaseClient,
  organizationId: string,
  metaId: string,
  nextStatus: string,
  recipientId: string | null,
  at: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, status, cost_amount, campaign_id, flow_id, created_at, metadata")
    .eq("meta_message_id", metaId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as (StatusRow & { cost_amount?: number | null }) | null;
  if (!row) return false;
  if ((STATUS_RANK[String(row.status)] ?? -1) < STATUS_RANK[nextStatus]!) return true;
  // Batch 34: an API message's event again (queued once per message and event),
  // so a first try that failed to queue it — or a status that arrived out of
  // order — still reaches the merchant's webhook.
  const hookError = await queueApiStatusOf(supabase, organizationId, row, nextStatus, at, null);
  const campaignMessage =
    Boolean(row.campaign_id || recipientId) ||
    (!row.flow_id && (!row.created_at || row.created_at < ATTRIBUTION_SINCE));
  const counterError = campaignMessage ? await applyCampaignStatus(supabase, row.id, nextStatus, null, recipientId) : null;
  if ((nextStatus === "delivered" || nextStatus === "read") && row.cost_amount == null) {
    const { error: priceError } = await supabase.rpc("price_message", { p_message_id: row.id });
    if (priceError) throw new Error(`price: ${priceError.message}`);
  }
  // Priced either way; the counter alone keeps the event retryable.
  if (counterError) throw new Error(counterError);
  if (hookError) throw new Error(hookError);
  return true;
}

/** Batch 34: a status of a message the Public API sent is queued for the merchant's webhook. */
async function queueApiStatusOf(
  supabase: SupabaseClient,
  organizationId: string,
  row: Pick<StatusRow, "id" | "metadata">,
  status: string,
  at: string,
  errorDetail: string | null,
): Promise<string | null> {
  const { isApiSource } = await import("@/lib/public-api-source");
  if (!isApiSource(row.metadata?.["source"])) return null;
  const { queueApiStatus } = await import("@/lib/public-api-webhooks.server");
  return queueApiStatus(supabase, { organizationId, messageId: row.id, status, at, metadata: row.metadata, errorDetail });
}

/**
 * Batch 27: how long after Meta's timestamp a status for a message we have
 * no row for is kept for the retry pass. Our own sends write their row a
 * moment after Meta accepts them, so a status can arrive first; past this it
 * is a message we never sent (another app on the number) and is dropped.
 */
export const STATUS_ROW_WAIT_MS = 10 * 60_000;

/** Bring the campaign's charged total up to the ledger, at most every few seconds per campaign. */
const CHARGED_SYNC_EVERY_MS = 15_000;
const chargedSyncedAt = new Map<string, number>();

/** Counts one reply per contact per campaign for campaigns sent in the last 7 days. */
export async function applyCampaignReply(
  supabase: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<void> {
  const since = new Date(Date.now() - REPLY_WINDOW_MS).toISOString();
  const { data: recipients } = await supabase
    .from("campaign_recipients")
    .select("id, campaign_id, replied_at, created_at")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    .gte("created_at", since)
    .in("status", ["sent", "delivered", "read"])
    .order("created_at", { ascending: false })
    .limit(5);

  for (const r of (recipients ?? []) as Array<Record<string, unknown>>) {
    if (r["replied_at"]) continue;
    // Only the update that sets replied_at counts it: two messages from the
    // same customer at once can't both bump the counter.
    const { data: marked, error: markError } = await supabase
      .from("campaign_recipients")
      .update({ replied_at: new Date().toISOString() })
      .eq("id", r["id"] as string)
      .is("replied_at", null)
      .select("id");
    if (markError) throw new Error(markError.message);
    if (!marked?.length) continue;
    await supabase.rpc("bump_campaign_counters", {
      p_campaign_id: r["campaign_id"] as string,
      p_replied: 1,
    });
  }
}

type AnyRecord = Record<string, unknown>;

/** Click-to-WhatsApp ads: map Meta's referral payload onto a lead source. */
function ctwaSource(referral: AnyRecord): string {
  const hay = `${String(referral["source_type"] ?? "")} ${String(referral["source_url"] ?? "")}`.toLowerCase();
  return hay.includes("instagram") || hay.includes("ig.me") ? "ctwa_instagram" : "ctwa_facebook";
}

type MarkerRow = { marker: string; source: string };

/**
 * First-touch lead source for an inbound message: a click-to-WhatsApp referral
 * wins, otherwise the org's configured tracking markers are matched against the
 * message text. Applied only when the contact row is created.
 */
function inboundSource(
  msg: AnyRecord,
  bodyText: string | null,
  markers: MarkerRow[],
): { source: string; source_detail: AnyRecord | null } {
  const referral = msg["referral"] as AnyRecord | undefined;
  if (referral && typeof referral === "object") {
    return { source: ctwaSource(referral), source_detail: referral };
  }
  const text = (bodyText ?? "").toLowerCase();
  if (text) {
    for (const m of markers) {
      const marker = m.marker.trim().toLowerCase();
      if (marker && text.includes(marker)) {
        return { source: m.source, source_detail: { marker: m.marker, matched_text: (bodyText ?? "").slice(0, 300) } };
      }
    }
  }
  return { source: "direct", source_detail: null };
}

// Lead-source markers only label a brand-new contact's first touch, so they
// are reused for 60 s within this server (speed: one round trip less before
// the contact is written). Opt-out keywords are never cached this way.
const markerMemo = new Map<string, { rows: MarkerRow[]; exp: number }>();

async function loadMarkers(
  supabase: SupabaseClient,
  organizationId: string,
  cache: Map<string, MarkerRow[]>,
): Promise<MarkerRow[]> {
  const cached = cache.get(organizationId);
  if (cached) return cached;
  const memo = markerMemo.get(organizationId);
  if (memo && memo.exp > Date.now()) {
    cache.set(organizationId, memo.rows);
    return memo.rows;
  }
  const { data } = await supabase
    .from("lead_source_markers")
    .select("marker, source")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  const rows = ((data as MarkerRow[]) ?? []).filter((r) => r.marker && r.source);
  cache.set(organizationId, rows);
  markerMemo.set(organizationId, { rows, exp: Date.now() + 60_000 });
  return rows;
}

type KeywordSets = { optOut: string[]; optIn: string[] };
type WaConnection = Awaited<ReturnType<typeof getWhatsAppConnection>>["connection"];

/**
 * Per-message stage timings: logged as one JSON line, and stored on
 * webhook_events.timing with the update that closes the event (see
 * reply-timing.ts for the stages).
 */
function stageClock(eventId: string, receivedAt: string | null, sink: MessageTiming[]) {
  const lag = receivedAt ? Math.max(0, Date.now() - Date.parse(receivedAt)) : null;
  const { timer, result, fallbackStart, sinceReceived, note } = replyTimer(lag);
  return {
    timer,
    mark: timer.mark,
    fallbackStart,
    sinceReceived,
    note,
    log(messageId: string, route: string) {
      const timing = result(messageId, route);
      sink.push(timing);
      console.log(
        JSON.stringify({
          scope: "webhook_timing",
          event_id: eventId,
          message_id: messageId,
          route,
          received_lag_ms: lag,
          stages: timing.marks,
          ms: timing.ms,
          total_ms: timing.total_ms,
        }),
      );
    },
  };
}

/**
 * Flows v2 inbound hook: a run waiting on this conversation takes the reply;
 * otherwise inbound triggers may start a run. true → the flow owns this
 * message and nothing else replies. Never throws.
 */
async function flowsV2Inbound(
  supabase: SupabaseClient,
  args: {
    orgId: string;
    contactId: string;
    conversationId: string;
    accountId: string;
    onlyAccountId: string | null;
    msg: AnyRecord;
    body: string | null;
    contactAge: number;
    /** The contact's run, read while the steps before flows ran (speed). */
    firstLook?: Promise<unknown>;
    /** The inbound triggers, read at the same time (speed). */
    triggers?: Promise<{ data: unknown[] | null }>;
    connection?: WaConnection;
    /** The window write; the flow sends nothing before it lands. */
    ready?: Promise<unknown>;
    /** When the customer sent the message (it opens the 24-hour window). */
    inboundAt?: string;
    timer?: ReplyTimer;
    /** Whether a teammate owns the conversation, read with it (speed). */
    teammateOwns?: boolean;
    /** The published versions a trigger would start, read early (speed). */
    versions?: ReturnType<typeof import("@/lib/flow-triggers.server").prefetchStartVersions>;
  },
): Promise<boolean> {
  const extras = {
    conversation: { id: args.conversationId, whatsappAccountId: args.accountId },
    ...(args.ready ? { ready: args.ready } : {}),
    ...(args.inboundAt ? { inboundAt: args.inboundAt } : {}),
    ...(args.timer ? { timer: args.timer } : {}),
    ...(args.connection ? { connection: args.connection } : {}),
  };
  const { msg } = args;
  try {
    const { handleInboundForRuns } = await import("@/lib/flow-engine.server");
    const flowInteractive = msg["interactive"] as AnyRecord | undefined;
    const replyId =
      ((flowInteractive?.["button_reply"] as AnyRecord | undefined)?.["id"] as string | undefined) ??
      ((flowInteractive?.["list_reply"] as AnyRecord | undefined)?.["id"] as string | undefined) ??
      ((msg["button"] as AnyRecord | undefined)?.["payload"] as string | undefined) ??
      null;
    const loc = msg["location"] as AnyRecord | undefined;
    const taken = await handleInboundForRuns(supabase, {
      organizationId: args.orgId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      whatsappAccountId: args.accountId,
      body: args.body || (loc ? `${loc["latitude"]},${loc["longitude"]}` : ""),
      replyId,
      ...(args.firstLook ? { firstLook: args.firstLook as NonNullable<Parameters<typeof handleInboundForRuns>[1]["firstLook"]> } : {}),
      ...extras,
    });
    if (taken.consumed) return true;

    const { dispatchInboundTriggers } = await import("@/lib/flow-triggers.server");
    let campaignButton: { campaignId: string | null; button: string | null } | null = null;
    const ctxId = (msg["context"] as AnyRecord | undefined)?.["id"] as string | undefined;
    if (replyId && ctxId) {
      const { data: ctxMsg } = await supabase
        .from("messages")
        .select("campaign_id")
        .eq("meta_message_id", ctxId)
        .maybeSingle();
      const cid = (ctxMsg?.campaign_id as string | null) ?? null;
      if (cid) campaignButton = { campaignId: cid, button: replyId };
    }
    const started = await dispatchInboundTriggers(supabase, {
      organizationId: args.orgId,
      contactId: args.contactId,
      conversationId: args.conversationId,
      body: args.body ?? "",
      isFirstMessageEver: args.contactAge >= 0 && args.contactAge < 10_000,
      isCtwa: Boolean(msg["referral"]),
      campaignButton,
      accountId: args.accountId,
      onlyAccountId: args.onlyAccountId,
      skipKeywords: Boolean(taken.runActive),
      ...(args.triggers ? { triggers: args.triggers } : {}),
      ...(args.versions ? { versions: args.versions } : {}),
      ...(args.teammateOwns !== undefined ? { teammateOwns: args.teammateOwns } : {}),
      extras,
    });
    return started.started;
  } catch (error) {
    console.error("[flows-v2] inbound failed", error instanceof Error ? error.message : String(error));
    return false;
  }
}

async function loadOptKeywords(
  supabase: SupabaseClient,
  organizationId: string,
  cache: Map<string, KeywordSets>,
): Promise<KeywordSets> {
  const cached = cache.get(organizationId);
  if (cached) return cached;
  const { data } = await supabase
    .from("opt_out_keywords")
    .select("keyword, action")
    .eq("organization_id", organizationId);
  const sets = keywordSets((data as Array<{ keyword: string; action: string }> | null) ?? []);
  cache.set(organizationId, sets);
  return sets;
}

/** Built-in keywords plus the organization's own configured list. */
function keywordSets(rows: Array<{ keyword: string; action: string }>): KeywordSets {
  return {
    optOut: [
      ...DEFAULT_OPT_OUT_KEYWORDS,
      ...rows.filter((r) => r.action === "opt_out").map((r) => r.keyword),
    ],
    optIn: [
      ...DEFAULT_OPT_IN_KEYWORDS,
      ...rows.filter((r) => r.action === "opt_in").map((r) => r.keyword),
    ],
  };
}

// Plain session sends live in service-text.server.ts so the automations
// engine can reuse the exact same path (never a template).


/**
 * Applies opt-out / opt-in keyword handling for one inbound message. The
 * confirmation is sent only when the status actually changes, so a repeated
 * "STOP" never triggers a second reply.
 */
async function applyOptKeywords(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    accountId: string;
    phoneNumberId: string;
    accessToken: string;
    conversationId: string;
    contactId: string;
    currentStatus: string | null;
    waId: string;
    body: string | null;
    keywords: KeywordSets;
  },
): Promise<boolean> {

  const log = (stage: string, extra: Record<string, unknown> = {}) =>
    console.log(
      JSON.stringify({
        scope: "optkeywords",
        stage,
        organization_id: args.organizationId,
        contact_id: args.contactId,
        previous_status: args.currentStatus,
        ...extra,
      }),
    );

  const optOut = matchKeyword(args.body, args.keywords.optOut);
  const optIn = optOut ? null : matchKeyword(args.body, args.keywords.optIn);
  if (!optOut && !optIn) {
    log("no_match", {
      keyword_counts: {
        opt_out: args.keywords.optOut.length,
        opt_in: args.keywords.optIn.length,
      },
    });
    return false;
  }

  const nextStatus = optOut ? "opted_out" : "opted_in";
  const action = optOut ? "opt_out" : "opt_in";
  log("matched", { keyword: optOut ?? optIn, action, next_status: nextStatus });

  if (args.currentStatus === nextStatus) {
    log("skipped_already_in_status", { action, next_status: nextStatus });
    return true;
  }

  const { error } = await supabase
    .from("contacts")
    .update({
      opt_in_status: nextStatus,
      // Audit only — the block itself is workspace-wide, never per number.
      opt_status_account_id: args.accountId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", args.contactId);
  if (error) {
    log("status_update_failed", { action, next_status: nextStatus, error: error.message });
    return true;
  }
  log("status_updated", { action, next_status: nextStatus });
  if (optOut) {
    // Platform-wide STOP: any Flows v2 run for this contact ends too.
    try {
      const { cancelRunsForContact } = await import("@/lib/flow-engine.server");
      await cancelRunsForContact(supabase, args.organizationId, args.contactId);
    } catch (error) {
      console.error("[flows-v2] cancel on opt-out failed", error instanceof Error ? error.message : String(error));
    }
  }

  await emitEvent(supabase, optOut ? "contact.opted_out" : "contact.opted_in", {
    organizationId: args.organizationId,
    whatsappAccountId: args.accountId,
    entityType: "contact",
    entityId: args.contactId,
    properties: {
      keyword: optOut ?? optIn,
      previous_status: args.currentStatus,
      // The block is workspace-wide; the number is audit detail only.
      scope: "organization",
    },
  });

  await supabase.from("activity_log").insert({
    organization_id: args.organizationId,
    action: optOut ? "contact_opted_out" : "contact_opted_in",
    details: {
      contact_id: args.contactId,
      keyword: optOut ?? optIn,
      previous_status: args.currentStatus,
      new_status: nextStatus,
      whatsapp_account_id: args.accountId,
      scope: "organization",
    },
  });

  // Plain session text, sent directly through the Graph API — it deliberately
  // bypasses the campaign audience guard (the contact is already opted_out).
  await sendServiceText(supabase, {
    organizationId: args.organizationId,
    phoneNumberId: args.phoneNumberId,
    accessToken: args.accessToken,
    conversationId: args.conversationId,
    to: args.waId,
    body: optOut ? OPT_OUT_CONFIRMATION : OPT_IN_CONFIRMATION,
  });
  log("confirmation_sent", { action, next_status: nextStatus });

  // Batch 37: the merchant's webhook hears it (when one is set) — after the
  // customer's confirmation is out, so it never holds that up.
  try {
    const { queueContactOptEvent } = await import("@/lib/public-api-webhooks.server");
    await queueContactOptEvent(supabase, {
      organizationId: args.organizationId,
      contactId: args.contactId,
      event: optOut ? "contact.opted_out" : "contact.opted_in",
    });
  } catch {
    // the merchant's webhook queue never changes what the customer got
  }
  return true;
}


/** Normalises Meta's quality signals onto GREEN / YELLOW / RED / UNKNOWN. */
function readQuality(value: AnyRecord): string | null {
  const direct = value["quality_rating"] ?? value["current_quality_rating"];
  if (typeof direct === "string" && direct) return qualityLabel(direct);
  const event = String(value["event"] ?? "").toUpperCase();
  if (event === "FLAGGED") return "RED";
  if (event === "UNFLAGGED") return "GREEN";
  return null;
}




function messageBody(msg: AnyRecord): { type: string; body: string | null } {
  const type = String(msg["type"] ?? "text");
  const pick = (o: unknown, k: string) =>
    o && typeof o === "object" ? ((o as AnyRecord)[k] as string | undefined) ?? null : null;
  switch (type) {
    case "text":
      return { type, body: pick(msg["text"], "body") };
    case "button":
      return { type, body: pick(msg["button"], "text") };
    case "interactive": {
      const i = msg["interactive"] as AnyRecord | undefined;
      if (String(i?.["type"] ?? "") === "nfm_reply") return { type, body: "Form submitted" };
      return {
        type,
        body: pick(i?.["button_reply"], "title") ?? pick(i?.["list_reply"], "title"),
      };
    }
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return { type, body: pick(msg[type], "caption") };
    default:
      return { type, body: null };
  }
}

function mediaOf(msg: AnyRecord): {
  media_url: string | null;
  media_mime: string | null;
  media_name: string | null;
} {
  const type = String(msg["type"] ?? "");
  const m = msg[type] as AnyRecord | undefined;
  if (!m || typeof m !== "object") return { media_url: null, media_mime: null, media_name: null };
  const id = m["id"] as string | undefined;
  return {
    media_url: id ? `meta:${id}` : null,
    media_mime: (m["mime_type"] as string | undefined) ?? null,
    media_name: (m["filename"] as string | undefined) ?? null,
  };
}

/**
 * A customer's photo or voice note, as words the AI can act on. Voice becomes
 * the question itself; a picture becomes a one-line note the question is
 * asked about. Unsupported files get a polite line so nobody is left waiting.
 */
async function customerMediaToText(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    messageId: string | null;
    accessToken: string;
    caption: string | null;
    media: { media_url: string | null; media_mime: string | null; media_name: string | null };
  },
): Promise<{ body: string | null; fallback: string | null }> {
  const mediaId = args.media.media_url?.startsWith("meta:") ? args.media.media_url.slice(5) : null;
  if (!mediaId) return { body: args.caption, fallback: null };
  const mime = (args.media.media_mime ?? "").toLowerCase();
  const caption = (args.caption ?? "").trim();

  try {
    const { transcribeAudio, describeImage } = await import("@/lib/ai-media.server");
    // Batch 32: Meta first, as always; our stored copy when Meta no longer has it.
    const { readInboundMedia } = await import("@/lib/chat-media.server");
    const media = () =>
      readInboundMedia(supabase, { mediaId, accessToken: args.accessToken, messageId: args.messageId, maxBytes: 8 * 1024 * 1024 });
    if (mime.startsWith("audio/")) {
      const file = await media();
      const heard = file
        ? await transcribeAudio(supabase, args.organizationId, file.bytes, file.mime ?? args.media.media_mime)
        : { text: null };
      if (!heard.text) {
        return {
          body: caption || null,
          fallback: "I couldn't hear that voice note clearly — could you type it out for me?",
        };
      }
      if (args.messageId) {
        await supabase.from("messages").update({ body: heard.text }).eq("id", args.messageId);
      }
      return { body: heard.text, fallback: null };
    }
    if (mime.startsWith("image/")) {
      const file = await media();
      const seen = file
        ? await describeImage(supabase, args.organizationId, file.bytes, file.mime ?? args.media.media_mime, {
            conversationId: args.conversationId,
          })
        : { text: null };
      if (!seen.text) {
        return {
          body: caption || null,
          fallback: caption ? null : "Thanks for the picture — tell me what you'd like to know about it.",
        };
      }
      const body = caption
        ? `${caption}\n\n[Customer attached a picture: ${seen.text}]`
        : `[Customer sent a picture: ${seen.text}] What can you tell me about this?`;
      return { body, fallback: null };
    }
  } catch (error) {
    console.error("[customer-media]", error instanceof Error ? error.message : String(error));
    return { body: caption || null, fallback: null };
  }

  // Documents, stickers, contacts, locations: nothing we can read into an answer.
  return {
    body: caption || null,
    fallback: caption
      ? null
      : "Thanks — I can read text, pictures and voice notes. Tell me in a message how I can help.",
  };
}

type InboundAccount = Pick<AccountRow, "id" | "organization_id" | "waba_id"> & Partial<AccountRow>;

type EmbeddedAccountRead = { data: unknown; error: unknown };

/** The number's row with its workspace's markers and opt-out words embedded. Never rejects. */
function readEmbeddedAccount(supabase: SupabaseClient, phoneNumberId: string): Promise<EmbeddedAccountRead> {
  return Promise.resolve(
    supabase
      .from("whatsapp_accounts")
      .select(
        `${ACCOUNT_COLUMNS}, organizations(lead_source_markers(marker, source, created_at), opt_out_keywords(keyword, action))`,
      )
      .eq("phone_number_id", phoneNumberId)
      .maybeSingle(),
  ).then(
    (r) => ({ data: r.data as unknown, error: r.error as unknown }),
    (error: unknown) => ({ data: null, error: error ?? new Error("read failed") }),
  );
}

/**
 * The reads a payload carrying customer messages starts with — the number
 * (with markers and opt-out words embedded) and the onboarding number — begun
 * while the event itself is being stored, instead of one round trip after.
 * Read-only and identical to the reads processWebhookPayload would make;
 * nothing is written before the event is stored. Status-only payloads get none.
 */
export type InboundPrefetch = {
  accounts: Map<string, Promise<EmbeddedAccountRead>>;
  onboarding: Promise<{ data: unknown }>;
};

export function prefetchInbound(supabase: SupabaseClient, payload: AnyRecord): InboundPrefetch | undefined {
  const accounts = new Map<string, Promise<EmbeddedAccountRead>>();
  for (const entry of (payload["entry"] as AnyRecord[] | undefined) ?? []) {
    for (const change of (entry["changes"] as AnyRecord[] | undefined) ?? []) {
      const value = (change["value"] as AnyRecord | undefined) ?? {};
      const phoneNumberId = ((value["metadata"] as AnyRecord | undefined) ?? {})["phone_number_id"] as string | undefined;
      const hasMessages = ((value["messages"] as unknown[] | undefined) ?? []).length > 0;
      if (phoneNumberId && hasMessages && !accounts.has(phoneNumberId)) {
        accounts.set(phoneNumberId, readEmbeddedAccount(supabase, phoneNumberId));
      }
    }
  }
  if (accounts.size === 0) return undefined;
  const onboarding = Promise.resolve(
    supabase.from("platform_settings").select("onboarding_whatsapp_account_id").maybeSingle(),
  ).then(
    (r) => ({ data: r.data as unknown }),
    () => ({ data: null }),
  );
  return { accounts, onboarding };
}

const STATUS_ACCOUNT_TTL_MS = 30_000;
const statusAccountCache = new Map<string, { at: number; account: InboundAccount }>();

/**
 * The number a message came in on, by phone_number_id — with the workspace's
 * lead-source markers and opt-out words embedded, so the three reads the
 * message needs before its contact is written are one round trip. If the
 * embedded read fails for any reason, the plain read runs as before and the
 * markers / words are read separately as they always were.
 */
async function readInboundAccount(
  supabase: SupabaseClient,
  phoneNumberId: string,
  /** Only for a payload carrying messages (status callbacks don't need them). */
  caches: { markerCache: Map<string, MarkerRow[]>; keywordCache: Map<string, KeywordSets> } | null,
  /** The same embedded read, started while the event was being stored (speed). */
  prefetched?: Promise<EmbeddedAccountRead>,
): Promise<InboundAccount | null> {
  if (!caches) {
    // Status callbacks arrive ~3 per message sent; the number they belong to
    // is read once per isolate every STATUS_ACCOUNT_TTL_MS, not every time.
    const hit = statusAccountCache.get(phoneNumberId);
    if (hit && Date.now() - hit.at < STATUS_ACCOUNT_TTL_MS) return hit.account;
    const { data, error } = await supabase
      .from("whatsapp_accounts")
      .select("id, organization_id, waba_id")
      .eq("phone_number_id", phoneNumberId)
      .maybeSingle();
    const account = (data as InboundAccount | null) ?? null;
    if (!error && account) statusAccountCache.set(phoneNumberId, { at: Date.now(), account });
    return account;
  }
  const { markerCache, keywordCache } = caches;
  const embedded = await (prefetched ?? readEmbeddedAccount(supabase, phoneNumberId));
  if (!embedded.error) {
    const row = embedded.data as (AccountRow & { organizations?: unknown }) | null;
    if (!row) return null;
    const org = row.organizations as {
      lead_source_markers?: Array<MarkerRow & { created_at?: string | null }> | null;
      opt_out_keywords?: Array<{ keyword: string; action: string }> | null;
    } | null;
    if (org && Array.isArray(org.lead_source_markers)) {
      const rows = [...org.lead_source_markers]
        .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
        .map((m) => ({ marker: m.marker, source: m.source }))
        .filter((r) => r.marker && r.source);
      markerCache.set(row.organization_id, rows);
    }
    if (org && Array.isArray(org.opt_out_keywords)) {
      keywordCache.set(row.organization_id, keywordSets(org.opt_out_keywords));
    }
    const { organizations: _embedded, ...account } = row;
    return account;
  }
  const { data } = await supabase
    .from("whatsapp_accounts")
    .select("id, organization_id, waba_id")
    .eq("phone_number_id", phoneNumberId)
    .maybeSingle();
  return (data as InboundAccount | null) ?? null;
}

/**
 * Process one webhook payload. Routes each change to an organization via
 * phone_number_id, writes inbound messages and applies monotonic status updates.
 */
export async function processWebhookPayload(
  supabase: SupabaseClient,
  eventId: string,
  payload: AnyRecord,
  /** webhook_events.received_at, for the timing log. */
  receivedAt: string | null = null,
  /** How long storing the event took (acceptWebhook), for webhook_events.timing. */
  meta: {
    storeMs?: number;
    prefetch?: InboundPrefetch;
    /** Run by catch-up under a lease (webhook_events.lease_until): closing the event lets it go. */
    leased?: boolean;
    /** Batch 29: a safety-net pass (not the webhook's own): how and how late it picked the event up. */
    pickup?: ReplyPickup;
  } = {},
): Promise<void> {
  const processingStart = Date.now();
  const timings: MessageTiming[] = [];
  let accountMs: number | null = null;
  const timingRecord = (): Record<string, unknown> | null =>
    timings.length
      ? {
          v: 1,
          store_ms: meta.storeMs ?? null,
          // How long the number's lookup held the first message up (0 when it
          // finished during the store), and whether it started there.
          account_ms: accountMs,
          prefetched: Boolean(meta.prefetch),
          received_lag_ms: receivedAt ? Math.max(0, processingStart - Date.parse(receivedAt)) : null,
          ...(meta.pickup ? { pickup: meta.pickup } : {}),
          total_ms: Date.now() - processingStart,
          messages: timings,
        }
      : null;
  // The modules a reply may need are loaded while the first reads are in
  // flight, instead of one by one on the critical path (cold isolate).
  for (const load of [
    () => import("@/lib/flow-engine.server"),
    () => import("@/lib/flow-triggers.server"),
    () => import("@/lib/flows.server"),
    () => import("@/lib/feature-flags.server"),
    () => import("@/lib/cod.server"),
  ]) {
    load().catch(() => {});
  }
  try {
    const entries = (payload["entry"] as AnyRecord[] | undefined) ?? [];
    const markerCache = new Map<string, MarkerRow[]>();
    const keywordCache = new Map<string, KeywordSets>();
    const automationCache = new Map<string, AutomationRow[]>();
    const timezoneCache = new Map<string, string>();
    const connectionCache = new Map<string, Promise<WaConnection>>();
    // Bookkeeping that no reply depends on (analytics events, campaign reply
    // marks, offer taps) runs alongside the reply path and is awaited before
    // this payload is marked processed — so a flow answers without waiting on it.
    const deferred: Array<Promise<unknown>> = [];
    const later = (p: Promise<unknown>) => {
      deferred.push(p.catch((e) => console.error("[webhook] deferred step failed", e instanceof Error ? e.message : String(e))));
    };
    // Bookkeeping no reply depends on starts once this message has been
    // answered: a Worker keeps at most six requests in flight, and these used
    // to hold slots the reply path was queueing for. Still awaited (never
    // fire-and-forget) before the event is marked processed.
    const afterReply: Array<() => Promise<unknown>> = [];
    const startAfterReply = () => {
      for (const step of afterReply.splice(0)) later(Promise.resolve().then(step));
    };
    const deferEmit = (...a: Parameters<typeof emitEvent>) => {
      afterReply.push(async () => {
        await emitEvent(...a);
      });
    };
    // The number owners write to while Aiden is being set up. Never hardcoded.
    // Read alongside the first account lookup; awaited before it's needed.
    // Status-only payloads (most of them while a campaign sends) never read it.
    const carriesMessages = entries.some((e) =>
      ((e["changes"] as AnyRecord[] | undefined) ?? []).some(
        (c) => (((c["value"] as AnyRecord | undefined)?.["messages"] as unknown[] | undefined) ?? []).length > 0,
      ),
    );
    const onboardingRead = Promise.resolve(
      meta.prefetch?.onboarding ??
        (carriesMessages
          ? supabase.from("platform_settings").select("onboarding_whatsapp_account_id").maybeSingle()
          : { data: null }),
    ).then(
      ({ data }) =>
        (data as { onboarding_whatsapp_account_id?: string | null } | null)?.onboarding_whatsapp_account_id ?? null,
      () => null,
    );
    let onboardingAccountId: string | null = null;

    let routedAny = false;
    // Messages / statuses that threw; the event is left retryable when any did.
    const failures: string[] = [];


    for (const entry of entries) {
      for (const change of (entry["changes"] as AnyRecord[] | undefined) ?? []) {
        const value = (change["value"] as AnyRecord | undefined) ?? {};
        const field = String(change["field"] ?? "");

        // ---- account health: quality + account status updates ----
        if (field === "phone_number_quality_update" || field === "account_update") {
          const wabaId = String(entry["id"] ?? "");
          const displayNumber = String(
            value["display_phone_number"] ?? value["phone_number"] ?? "",
          );
          // Always scope to the WABA the event came from. Matching on the
          // display number alone would attach one client's health event to
          // whichever account happened to sort first.
          let lookup = supabase
            .from("whatsapp_accounts")
            .select("id, organization_id, phone_number_id, quality_rating, status")
            .eq("waba_id", wabaId);
          if (displayNumber) lookup = lookup.eq("display_phone_number", displayNumber);

          const { data: healthRows } = await lookup.limit(2);
          // Ambiguous or unknown: record it and skip rather than guess.
          if (!healthRows || healthRows.length !== 1) continue;
          const healthAccount = healthRows[0]!;
          routedAny = true;

          const nowIso = new Date().toISOString();
          const event = String(value["event"] ?? "").toUpperCase();
          const nextQuality = readQuality(value);
          const patch: AnyRecord = {};

          if (nextQuality && nextQuality !== healthAccount.quality_rating) {
            patch["quality_rating"] = nextQuality;
            patch["quality_updated_at"] = nowIso;
          }
          if (field === "account_update") {
            if (["DISABLED_UPDATE", "ACCOUNT_DELETED", "ACCOUNT_VIOLATION"].includes(event)) {
              patch["status"] = "disconnected";
            } else if (["VERIFIED_ACCOUNT", "ACCOUNT_RESTORED"].includes(event)) {
              patch["status"] = "active";
            }
          }

          if (Object.keys(patch).length > 0) {
            await supabase.from("whatsapp_accounts").update(patch).eq("id", healthAccount.id);
          }

          // Quality timeline: only current state lives on the account row, so
          // every reported rating is appended to its own history table.
          if (nextQuality) {
            await supabase.from("whatsapp_quality_history").insert({
              organization_id: healthAccount.organization_id as string,
              phone_number_id: (healthAccount.phone_number_id as string | null) ?? null,
              quality_rating: nextQuality,
              recorded_at: nowIso,
            });
          }

          if (nextQuality) {
            await emitEvent(supabase, "whatsapp.quality_changed", {
              organizationId: healthAccount.organization_id as string,
              whatsappAccountId: healthAccount.id as string,
              entityType: "whatsapp_account",
              entityId: healthAccount.id as string,
              properties: {
                old_rating: healthAccount.quality_rating ?? null,
                new_rating: nextQuality,
              },
            });
          }
          if (patch["status"] === "disconnected") {
            await emitEvent(supabase, "whatsapp.disconnected", {
              organizationId: healthAccount.organization_id as string,
              whatsappAccountId: healthAccount.id as string,
              entityType: "whatsapp_account",
              entityId: healthAccount.id as string,
              properties: { event: event || null, reason: "meta_account_update" },
            });
          }

          await supabase.from("activity_log").insert({
            organization_id: healthAccount.organization_id as string,
            action: nextQuality ? "quality_changed" : "account_health_update",
            details: {
              field,
              event: event || null,
              ...(nextQuality
                ? { old_rating: healthAccount.quality_rating ?? null, new_rating: nextQuality }
                : {}),
              ...(patch["status"] ? { new_status: patch["status"] } : {}),
            },
          });
          continue;
        }


        // ---- template status / category updates (routed by WABA id, not phone number) ----
        if (
          String(change["field"] ?? "") === "message_template_status_update" ||
          String(change["field"] ?? "") === "template_category_update"
        ) {
          const wabaId = String(entry["id"] ?? "");
          // A WABA can hold several numbers, so this is a list, not a single
          // row — but every number on it belongs to one organization.
          const { data: wabaAccounts } = await supabase
            .from("whatsapp_accounts")
            .select("organization_id")
            .eq("waba_id", wabaId);
          const wabaOrgIds = Array.from(
            new Set(
              ((wabaAccounts ?? []) as Array<{ organization_id: string }>).map(
                (r) => r.organization_id,
              ),
            ),
          );
          if (wabaOrgIds.length !== 1) continue;
          routedAny = true;

          const templateName = value["message_template_name"] as string | undefined;
          const templateLanguage = value["message_template_language"] as string | undefined;
          const metaTemplateId = value["message_template_id"];
          // The template rows this notice is about, on this WABA only.
          type Eq = { eq: (column: string, value: unknown) => Eq };
          type Run = PromiseLike<{ data: unknown; error: unknown }>;
          const matchTemplate = (query: unknown): Run | null => {
            const scoped = (query as Eq)
              .eq("organization_id", wabaOrgIds[0]!)
              .eq("waba_id", wabaId);
            if (metaTemplateId !== undefined && metaTemplateId !== null)
              return scoped.eq("meta_template_id", String(metaTemplateId)) as unknown as Run;
            if (!templateName) return null;
            const named = scoped.eq("name", templateName);
            return (templateLanguage
              ? named.eq("language", templateLanguage)
              : named) as unknown as Run;
          };
          // Batch 37: when Meta's notice happened, so a repeated notice queues nothing new.
          const noticeAt = Number(entry["time"] ?? 0)
            ? new Date(Number(entry["time"]) * 1000).toISOString()
            : new Date().toISOString();

          // Batch 37: Meta moved the template to another category — the stored
          // category follows (it decides the opt-out rule and the price), and
          // the merchant's webhook hears template.category_changed.
          if (String(change["field"] ?? "") === "template_category_update") {
            const nextCategory =
              typeof value["new_category"] === "string" ? value["new_category"].toUpperCase() : "";
            if (!nextCategory) continue; // only a notice of a change still to come
            const before = matchTemplate(
              supabase.from("message_templates").select("id, name, language, status, category"),
            );
            const update = matchTemplate(
              supabase
                .from("message_templates")
                .update({ category: nextCategory, updated_at: new Date().toISOString() }),
            );
            if (!before || !update) continue;
            const { data: previous } = await before;
            await update;
            const { queueTemplateApiEvents } = await import("@/lib/public-api-webhooks.server");
            await queueTemplateApiEvents(supabase, {
              organizationId: wabaOrgIds[0]!,
              event: "template.category_changed",
              rows: (previous ?? []) as never,
              next: { category: nextCategory },
              previousCategory:
                typeof value["previous_category"] === "string"
                  ? value["previous_category"].toUpperCase()
                  : null,
              occurredAt: noticeAt,
            });
            continue;
          }

          // Batch 27 (M12): DISABLED / DELETED (and the rest Meta sends) stop the
          // template from being sent; REINSTATED makes it sendable again.
          const { metaTemplateStatus } = await import("@/lib/templates");
          const nextStatus = metaTemplateStatus(value["event"]);
          if (!nextStatus) continue;

          const reason = (value["reason"] as string | undefined) ?? null;
          const rejectionReason =
            nextStatus === "REJECTED"
              ? reason && reason !== "NONE"
                ? reason
                : "Rejected by review"
              : null;
          const update = matchTemplate(
            supabase.from("message_templates").update({
              status: nextStatus,
              rejection_reason: rejectionReason,
              updated_at: new Date().toISOString(),
            }),
          );
          if (!update) continue;
          // Batch 37: what the rows were, for template.status_changed.
          const before = matchTemplate(
            supabase.from("message_templates").select("id, name, language, status, category"),
          );
          const { data: previous } = before ? await before : { data: null };
          await update;
          const { queueTemplateApiEvents } = await import("@/lib/public-api-webhooks.server");
          await queueTemplateApiEvents(supabase, {
            organizationId: wabaOrgIds[0]!,
            event: "template.status_changed",
            rows: (previous ?? []) as never,
            next: { status: nextStatus, rejectionReason },
            previousCategory: null,
            occurredAt: noticeAt,
          });
          if (nextStatus === "APPROVED" || nextStatus === "REJECTED") {
            await emitEvent(supabase, nextStatus === "APPROVED" ? "template.approved" : "template.rejected", {
              organizationId: wabaOrgIds[0]!,
              entityType: "message_template",
              entityId: metaTemplateId != null ? String(metaTemplateId) : null,
              properties: {
                template_name: templateName ?? null,
                waba_id: wabaId,
                ...(nextStatus === "REJECTED" ? { reason: reason ?? null } : {}),
              },
            });
          }
          continue;
        }

        const metadata = (value["metadata"] as AnyRecord | undefined) ?? {};
        const phoneNumberId = metadata["phone_number_id"] as string | undefined;
        if (!phoneNumberId) continue;

        const hasMessages = ((value["messages"] as unknown[] | undefined) ?? []).length > 0;
        const lookupStarted = Date.now();
        const account = await readInboundAccount(
          supabase,
          phoneNumberId,
          hasMessages ? { markerCache, keywordCache } : null,
          hasMessages ? meta.prefetch?.accounts.get(phoneNumberId) : undefined,
        );
        if (hasMessages && accountMs === null) accountMs = Date.now() - lookupStarted;

        onboardingAccountId = await onboardingRead;

        // phone_number_id is globally unique, so an unknown one means the
        // payload isn't ours: it stays recorded and unrouted, never attached
        // to some other account.
        if (!account) continue;
        routedAny = true;
        const orgId = account.organization_id as string;
        // The Flows v2 flag is read now, beside the contact write, so the
        // flow's turn finds it ready (it is shared and reused for 30 s).
        if (hasMessages) {
          import("@/lib/flow-engine.server")
            .then(({ flowsV2Enabled }) => flowsV2Enabled(supabase, orgId))
            .catch(() => {});
        }
        const accountId = account.id as string;
        const accountWabaId = (account.waba_id as string | null) ?? null;

        // Token for THIS number's WABA — replies always go back out on the
        // number the customer wrote to. Read while the contact and message
        // are written; awaited before anything that could send.
        let connectionRead = connectionCache.get(accountId);
        // Status-only payloads never send, so they never read the token.
        if (!connectionRead && hasMessages) {
          // The number's row is already in hand: only its token is read.
          connectionRead = (
            account.phone_number_id !== undefined
              ? connectionForAccount(supabase, account as AccountRow)
              : getWhatsAppConnection(supabase, orgId, accountId)
          ).then(
            (r) => r.connection,
            () => null,
          );
          connectionCache.set(accountId, connectionRead);
        }
        const connectionP: Promise<WaConnection> = connectionRead ?? Promise.resolve(null);
        let accessToken = "";
        let connection: WaConnection = null;

        // ---- inbound messages ----
        const contactsMeta = (value["contacts"] as AnyRecord[] | undefined) ?? [];
        for (const msg of (value["messages"] as AnyRecord[] | undefined) ?? []) {
          const clock = stageClock(eventId, receivedAt, timings);
          let route = "none";
          let answerRowId: string | null = null;
          try {
            const waId = toWaId(msg["from"] as string | undefined);
            if (!waId) continue;

            // Batch 28: no typing dots up front on the onboarding number any
            // more — they went out before anyone knew a reply would follow
            // (a stranger past the greeting limit, a stale button, a flow
            // step that sends nothing). handleMerchantInbound starts them
            // (onWillReply) once a reply is certain.

            // Our own number appearing as the sender means this is an echo of a
            // message we sent (confirmation, automation reply). Never automate on it.
            const selfWaId = toWaId(metadata["display_phone_number"] as string | undefined);
            const isSystemEcho = Boolean(selfWaId && selfWaId === waId);
            const profile = contactsMeta.find((c) => c["wa_id"] === waId);
            const profileName =
              ((profile?.["profile"] as AnyRecord | undefined)?.["name"] as string | undefined) ??
              null;

            const parsed = messageBody(msg);
            // Opt-out keywords are read now and used after the message is stored.
            const keywordsRead = loadOptKeywords(supabase, orgId, keywordCache);
            keywordsRead.catch(() => {});
            // The AI's burst settings (platform settings, cached a minute):
            // read now so they never add to the wait.
            const burstWindow = burstSettings(supabase);
            const attribution = inboundSource(
              msg,
              parsed.body,
              await loadMarkers(supabase, orgId, markerCache),
            );
            clock.mark("account");

            // The open conversation is looked up by the sender's phone at the
            // same time as the contact is written (one round trip, not two).
            // Used only when it belongs to the contact the upsert returns.
            const phone = normalizePhone(waId);
            const openConversationRead = Promise.resolve(
              supabase
                .from("conversations")
                .select("id, unread_count, contact_id, assigned_to, needs_human, contacts!inner(phone)")
                .eq("organization_id", orgId)
                .eq("contacts.phone", phone)
                .eq("whatsapp_account_id", accountId)
                .eq("status", "open")
                .maybeSingle(),
            ).then(
              ({ data }) =>
                data as {
                  id: string;
                  unread_count: number | null;
                  contact_id?: string;
                  assigned_to?: string | null;
                  needs_human?: boolean | null;
                } | null,
              () => null,
            );

            // source / source_detail are frozen after insert by a DB trigger,
            // so this only ever applies to brand-new contacts (first touch).
            const { data: contact, error: contactError } = await supabase
              .from("contacts")
              .upsert(
                {
                  organization_id: orgId,
                  phone,
                  wa_id: waId,
                  ...(profileName ? { name: profileName } : {}),
                  // Everyone on the onboarding number is a business owner, not a
                  // lead, and is filed that way for good.
                  source:
                    onboardingAccountId && accountId === onboardingAccountId
                      ? "onboarding"
                      : attribution.source,
                  source_detail:
                    onboardingAccountId && accountId === onboardingAccountId
                      ? null
                      : attribution.source_detail,

                  updated_at: new Date().toISOString(),
                },
                { onConflict: "organization_id,phone" },
              )
              .select("id, opt_in_status, created_at")
              .single();
            if (contactError) throw new Error(`contact upsert failed: ${contactError.message}`);
            if (!contact) continue;
            clock.mark("contact");

            // The upsert can't tell us whether it inserted, so a freshly stamped
            // created_at is the signal for a genuinely new contact.
            const contactAge = Date.now() - new Date(String(contact.created_at)).getTime();
            if (contactAge >= 0 && contactAge < 10_000) {
              deferEmit(supabase, "contact.created", {
                organizationId: orgId,
                whatsappAccountId: accountId,
                entityType: "contact",
                entityId: contact.id as string,
                properties: { contact_source: attribution.source },
              });
            }

            const joined = await openConversationRead;
            // assigned_to rides along (speed): whether a teammate owns the
            // thread decides if a trigger may start a flow in it, and is then
            // not read again.
            let conversation: {
              id: string;
              unread_count: number | null;
              assigned_to?: string | null;
              needs_human?: boolean | null;
            } | null =
              joined && joined.contact_id === contact.id
                ? {
                    id: joined.id,
                    unread_count: joined.unread_count,
                    assigned_to: joined.assigned_to ?? null,
                    needs_human: joined.needs_human ?? null,
                  }
                : null;
            if (!conversation) {
              const { data: found } = await supabase
                .from("conversations")
                .select("id, unread_count, assigned_to, needs_human")
                .eq("organization_id", orgId)
                .eq("contact_id", contact.id)
                .eq("whatsapp_account_id", accountId)
                .eq("status", "open")
                .maybeSingle();
              conversation = found as typeof conversation;
            }

            if (!conversation) {
              const { data: created, error: createError } = await supabase
                .from("conversations")
                .insert({
                  organization_id: orgId,
                  contact_id: contact.id,
                  whatsapp_account_id: accountId,
                  status: "open",
                })
                .select("id, unread_count, assigned_to")
                .single();
              if (createError) throw new Error(`conversation insert failed: ${createError.message}`);
              conversation = created;
              if (created) {
                deferEmit(supabase, "conversation.opened", {
                  organizationId: orgId,
                  whatsappAccountId: accountId,
                  entityType: "conversation",
                  entityId: created.id as string,
                  properties: { opened_by: "inbound" },
                });
              }
            }
            if (!conversation) continue;
            clock.mark("conversation");

            const { type, body } = parsed;
            const media = mediaOf(msg);
            const tsSeconds = Number(msg["timestamp"] ?? 0);
            const occurredAt = tsSeconds
              ? new Date(tsSeconds * 1000).toISOString()
              : new Date().toISOString();
            // No received_at for this pass: time the reply from the message itself.
            if (tsSeconds) clock.fallbackStart(tsSeconds * 1000);

            // The message write goes out first; the reads below share the
            // Worker's six connections with it.
            const messageWrite = Promise.resolve(
              supabase
                .from("messages")
                .upsert(
                  {
                    organization_id: orgId,
                    conversation_id: conversation.id,
                    meta_message_id: String(msg["id"] ?? ""),
                    direction: "inbound",
                    type,
                    body,
                    media_url: media.media_url,
                    media_mime: media.media_mime,
                    status: "delivered",
                    status_updated_at: occurredAt,
                    created_at: occurredAt,
                    detected_language: detectLanguage(body),

                  },
                  { onConflict: "meta_message_id", ignoreDuplicates: true },
                )
                .select("id"),
            );

            // The contact's flow run, the inbound triggers and the
            // cash-on-delivery lookups, read while the message is stored so
            // the guards and the flow's turn don't wait on them. Read-only;
            // only used for a message that turns out to be new.
            const isCustomerNumber = !(onboardingAccountId && accountId === onboardingAccountId);
            // Read on the onboarding number too: a keyword pinned to it starts
            // a flow there, and these are the same reads the flow step would
            // otherwise make one after another.
            const flowLook =
              !isSystemEcho && type !== "order"
                ? import("@/lib/flow-engine.server").then(({ peekInboundRun }) =>
                    peekInboundRun(supabase, {
                      organizationId: orgId,
                      contactId: contact.id as string,
                      conversationId: conversation.id as string,
                      whatsappAccountId: accountId,
                    }),
                  )
                : null;
            flowLook?.catch(() => {});
            const triggersLook = flowLook
              ? import("@/lib/flow-triggers.server").then(({ readInboundTriggers }) => readInboundTriggers(supabase, orgId))
              : null;
            triggersLook?.catch(() => {});
            // The flow a trigger would start: its published version is read
            // as soon as the triggers are (speed). Nothing when none matches.
            const startVersions = triggersLook
              ? import("@/lib/flow-triggers.server").then(({ prefetchStartVersions }) =>
                  prefetchStartVersions(supabase, {
                    organizationId: orgId,
                    triggers: triggersLook,
                    body: body ?? "",
                    isFirstMessageEver: contactAge >= 0 && contactAge < 10_000,
                    isCtwa: Boolean(msg["referral"]),
                    accountId,
                    onlyAccountId: isCustomerNumber ? null : onboardingAccountId,
                  }),
                )
              : null;
            startVersions?.catch(() => {});
            const teammateOwns = Boolean(conversation.assigned_to);
            const tapPayload =
              ((msg["button"] as AnyRecord | undefined)?.["payload"] as string | undefined) ??
              (((msg["interactive"] as AnyRecord | undefined)?.["button_reply"] as AnyRecord | undefined)?.["id"] as
                | string
                | undefined) ??
              null;
            const contextMetaId =
              ((msg["context"] as AnyRecord | undefined)?.["id"] as string | undefined) ?? null;
            // A text with no yes/confirm/no/cancel in it can never settle a
            // cash-on-delivery ask (readCodIntent), so its reads stay off the
            // reply's path; it is still saved on an open ask, after the reply.
            const codMayAnswer = readCodIntent([body, tapPayload].filter(Boolean).join(" | ") || null) !== null;
            const codReads =
              isCustomerNumber && !isSystemEcho && type !== "order" && (body || tapPayload) && codMayAnswer
                ? import("@/lib/cod.server").then(({ prefetchCodReads }) =>
                    prefetchCodReads(supabase, { organizationId: orgId, contactId: contact.id as string, contextMetaId }),
                  )
                : null;
            codReads?.catch(() => {});

            // The automations' own reads (the org's timezone and its active
            // automations, cached per payload) — read-only, so they run with
            // the message write instead of after the flows' turn.
            const automationReads =
              isCustomerNumber && !isSystemEcho
                ? Promise.all([
                    loadOrgTimezone(supabase, orgId, timezoneCache),
                    loadAutomations(supabase, orgId, automationCache),
                  ])
                : null;
            automationReads?.catch(() => {});

            const { data: stored, error: insertError } = await messageWrite;
            // A failed write is not a duplicate: only an empty, error-free
            // result means Meta sent this message before.
            if (insertError) throw new Error(`message insert failed: ${insertError.message}`);
            const isNew = Boolean(stored && stored.length > 0);
            // Stored is not answered: a message whose earlier pass died before
            // it was answered is answered now, once (claimed); otherwise a
            // duplicate stays a duplicate.
            const inserted = isNew ? stored : await reclaimUnanswered(supabase, String(msg["id"] ?? ""));
            const reanswered = !isNew && Boolean(inserted?.length);
            answerRowId = (inserted?.[0]?.id as string | undefined) ?? null;
            const storedAt = Date.now();

            clock.mark("message_stored");

            // Only bump counters when this message was genuinely new. The
            // write opens the 24-hour window every send checks, so it runs
            // alongside the reads below and is awaited (`windowReady`) before
            // anything that could send.
            let windowReady: Promise<unknown> = Promise.resolve();
            if (isNew && inserted) {
              windowReady = Promise.resolve(
                supabase
                  .from("conversations")
                  .update({
                    last_message_at: occurredAt,
                    last_customer_message_at: occurredAt,
                    unread_count: (conversation.unread_count ?? 0) + 1,
                  })
                  .eq("id", conversation.id),
              );
              later(windowReady);
              afterReply.push(() => applyCampaignReply(supabase, orgId, contact.id));
              // Batch 32: the customer's file is copied into chat-media once
              // the reply is out (the Meta id expires after 7 days). Awaited
              // with the rest before the event closes; a failure leaves
              // "meta:<id>" for the sweep (runChatMediaSweep).
              if (media.media_url && !isSystemEcho) {
                const messageId = inserted[0]!.id as string;
                const conversationId = conversation.id as string;
                afterReply.push(async () => {
                  const token = (await connectionP)?.accessToken ?? "";
                  const { saveInboundMedia } = await import("@/lib/chat-media.server");
                  const outcome = await saveInboundMedia(supabase, {
                    messageId,
                    organizationId: orgId,
                    conversationId,
                    mediaRef: media.media_url,
                    mime: media.media_mime,
                    filename: media.media_name,
                    accessToken: token,
                  });
                  console.log(JSON.stringify({ scope: "chat_media", via: "webhook", message_id: messageId, outcome }));
                });
              }
              deferEmit(supabase, "message.received", {
                organizationId: orgId,
                whatsappAccountId: accountId,
                entityType: "message",
                entityId: inserted[0]!.id as string,
                occurredAt,
                properties: { message_type: type, conversation_id: conversation.id },
              });
              // Batch 37: the merchant's own webhook hears message.received (and
              // contact.created for a new number) — once, as this message is new;
              // after the reply, awaited before the event is closed.
              if (!isSystemEcho && isCustomerNumber) {
                const apiEvent = {
                  organizationId: orgId,
                  contactId: contact.id as string,
                  messageId: inserted[0]!.id as string,
                  msg,
                  phone,
                  name: profileName,
                  newContact: contactAge >= 0 && contactAge < 10_000,
                  contactSource: attribution.source,
                  occurredAt,
                };
                afterReply.push(async () =>
                  (await import("@/lib/public-api-webhooks.server")).queueInboundApiEvents(
                    supabase,
                    apiEvent,
                  ),
                );
              }
            }

            connection = await connectionP;
            accessToken = connection?.accessToken ?? "";

            // A filled-in WhatsApp form is handled before any other routing, on
            // every number (the onboarding number included): it is saved as a
            // form response and shown in the inbox, never treated as a chat
            // message for the owner channel, automations or the AI.
            if (
              type === "interactive" &&
              String((msg["interactive"] as AnyRecord | undefined)?.["type"] ?? "") === "nfm_reply"
            ) {
              route = "form";
              if (!isSystemEcho) {
                await windowReady;
                const { handleFormReply } = await import("@/lib/wa-forms.server");
                let messageRowId = (inserted?.[0]?.id as string | undefined) ?? null;
                if (!messageRowId) {
                  const { data: existingMsg } = await supabase
                    .from("messages")
                    .select("id")
                    .eq("meta_message_id", String(msg["id"] ?? ""))
                    .maybeSingle();
                  messageRowId = (existingMsg?.id as string | undefined) ?? null;
                }
                await handleFormReply(supabase, {
                  organizationId: orgId,
                  whatsappAccountId: accountId,
                  contactId: contact.id as string,
                  conversationId: conversation.id as string,
                  messageRowId,
                  metaMessageId: String(msg["id"] ?? ""),
                  msg,
                });
              }
              continue;
            }

            // Flows v2 on the onboarding number: that number never runs opt-out,
            // COD or automations, so a waiting run / keyword trigger pinned to
            // this number is checked here, before the owner channel. Opt-out
            // words (defaults + workspace list) never reach a flow.
            if (
              onboardingAccountId &&
              accountId === onboardingAccountId &&
              !isSystemEcho &&
              inserted &&
              inserted.length > 0 &&
              !matchKeyword(body, (await keywordsRead).optOut)
            ) {
              // Same as on a customer number: the reads made while the
              // message was stored, the number already resolved, and the
              // window write awaited only before the first send (speed).
              const taken = await flowsV2Inbound(supabase, {
                orgId,
                contactId: contact.id as string,
                conversationId: conversation.id as string,
                accountId,
                onlyAccountId: onboardingAccountId,
                msg,
                body,
                contactAge,
                ...(flowLook ? { firstLook: flowLook } : {}),
                ...(triggersLook ? { triggers: triggersLook } : {}),
                ...(startVersions ? { versions: startVersions } : {}),
                teammateOwns,
                connection,
                ready: windowReady,
                inboundAt: occurredAt,
                timer: clock.timer,
              });
              clock.mark("flows");
              // Landed before anything was sent; a failed write still fails
              // this message (retryable), as before.
              await windowReady;
              if (taken) {
                route = "flow";
                continue;
              }
            }

            // The onboarding number is a different conversation entirely: the
            // person writing is a business owner, not a customer. Nothing that
            // follows (opt-out keywords, COD, automations, the customer AI)
            // applies to them.
            if (onboardingAccountId && accountId === onboardingAccountId) {
              route = "merchant";
              if (!isSystemEcho && inserted && inserted.length > 0) {
                await windowReady;
                const { handleMerchantInbound } = await import("@/lib/merchant-channel.server");
                const merchantInteractive = msg["interactive"] as AnyRecord | undefined;
                const merchantTapId =
                  ((merchantInteractive?.["button_reply"] as AnyRecord | undefined)?.["id"] as
                    | string
                    | undefined) ??
                  ((merchantInteractive?.["list_reply"] as AnyRecord | undefined)?.["id"] as
                    | string
                    | undefined) ??
                  null;
                await handleMerchantInbound(supabase, {
                  organizationId: orgId,
                  accountId,
                  phoneNumberId,
                  accessToken,
                  waId,
                  conversationId: conversation.id as string,
                  contactId: contact.id as string,
                  body: body ?? "",
                  interactiveId: merchantTapId,
                  mediaUrl: media.media_url,
                  mediaMime: media.media_mime,
                  mediaName: media.media_name,
                  onWillReply: () => later(showTyping(connectionP, phoneNumberId, String(msg["id"] ?? ""))),
                });
              }
              continue;
            }

            // A cart sent from the catalogue is an order, not a question: record
            // it, hand the thread to a person and acknowledge it ourselves. The
            // AI employee never answers an order message.
            if (type === "order" && !isSystemEcho && inserted && inserted.length > 0) {
              await windowReady;
              const { handleCatalogOrder } = await import("@/lib/whatsapp-orders.server");
              const handled = await handleCatalogOrder(supabase, {
                organizationId: orgId,
                conversationId: conversation.id as string,
                contactId: (contact.id as string) ?? null,
                metaMessageId: String(msg["id"] ?? ""),
                order: (msg["order"] as AnyRecord | undefined) ?? {},
                phoneNumberId,
                accessToken,
                to: waId,
              });
              if (handled.handled) {
                route = "order";
                continue;
              }
            }


            // Opt-out / opt-in runs on EVERY inbound text, independent of whether
            // the message row was new — it is idempotent (no-op when the status
            // already matches), so duplicate deliveries cannot swallow a "STOP".
            const keywords = await keywordsRead;
            // A match may send a confirmation, which needs the window write.
            if (matchKeyword(body, keywords.optOut) || matchKeyword(body, keywords.optIn)) await windowReady;
            const optKeywordMatched = await applyOptKeywords(supabase, {
              organizationId: orgId,
              accountId,
              phoneNumberId,
              accessToken,
              conversationId: conversation.id as string,

              contactId: contact.id as string,
              currentStatus: (contact as { opt_in_status?: string }).opt_in_status ?? null,
              waId,
              body,
              keywords,
            });

            // Cash-on-delivery answers. Button replies quote the message that
            // asked, which is how the answer finds its order; anything typed is
            // still stored verbatim so nothing is lost.
            let codHandled = false;
            if (!isSystemEcho && !optKeywordMatched && !codMayAnswer) {
              // Can't be an answer (applyCodReply would return false): the
              // verbatim save on an open ask runs once this message is
              // answered, and is awaited before the event is closed.
              afterReply.push(async () =>
                (await import("@/lib/cod.server")).applyCodReply(supabase, {
                  organizationId: orgId,
                  contactId: contact.id as string,
                  contextMetaId,
                  body,
                  payload: tapPayload,
                }),
              );
            } else if (!isSystemEcho && !optKeywordMatched) {
              const { applyCodReply } = await import("@/lib/cod.server");
              // COD only records the answer (it never sends), so it runs
              // alongside the window write; its first reads were started
              // with the message write.
              const reads = codReads ? await codReads : undefined;
              codHandled = await applyCodReply(supabase, {
                organizationId: orgId,
                contactId: contact.id as string,
                contextMetaId,
                body,
                payload: tapPayload,
                ...(reads ? { reads } : {}),
              });
            }
            clock.mark("guards_done");

            // A customer who sends the coupon code back has taken the offer.
            // Only new messages count, so a redelivered webhook can't inflate it.
            if (inserted && inserted.length > 0 && !isSystemEcho) {
              const interactiveTap = msg["interactive"] as AnyRecord | undefined;
              afterReply.push(async () => (await import("@/lib/offers.server")).recordOfferTap(supabase, {
                organizationId: orgId,
                contactId: contact.id as string,
                body,
                payload:
                  ((msg["button"] as AnyRecord | undefined)?.["payload"] as string | undefined) ??
                  ((interactiveTap?.["button_reply"] as AnyRecord | undefined)?.["id"] as
                    | string
                    | undefined) ??
                  null,
              }));
            }


            // Flows v2 runs after catalogue orders, opt-out keywords and COD
            // answers, and before automations: a waiting run takes the reply
            // first, otherwise a trigger may start one. Either way nothing else
            // (automations, the AI) replies to this message.
            if (!isSystemEcho && !optKeywordMatched && !codHandled && inserted && inserted.length > 0) {
              const taken = await flowsV2Inbound(supabase, {
                orgId,
                contactId: contact.id as string,
                conversationId: conversation.id as string,
                accountId,
                onlyAccountId: null,
                msg,
                body,
                contactAge,
                ...(flowLook ? { firstLook: flowLook } : {}),
                ...(triggersLook ? { triggers: triggersLook } : {}),
                ...(startVersions ? { versions: startVersions } : {}),
                teammateOwns,
                connection,
                // The flow may claim/start its run while the window write
                // lands; it sends nothing before it has.
                ready: windowReady,
                inboundAt: occurredAt,
                timer: clock.timer,
              });
              clock.mark("flows");
              if (taken) {
                route = "flow";
                // Already landed when the flow sent; a failed write still
                // fails this message (retryable), as before.
                await windowReady;
                continue;
              }
            }
            // No flow took it. The agent's set-up and its answer run's reads
            // (read-only) start now, so they run alongside the window write,
            // the automations and the burst wait instead of after them. Only
            // used when nothing else answers; every gate is still applied, in
            // the same order, in runAgentOnInbound.
            const contactOptedOut = (contact as { opt_in_status?: string }).opt_in_status === "opted_out";
            const agentPrepared =
              !isSystemEcho && inserted && inserted.length > 0 && !optKeywordMatched && !codHandled && !contactOptedOut
                ? import("@/lib/ai-agent.server").then(({ prepareAgentInbound }) =>
                    prepareAgentInbound(supabase, orgId, conversation.id as string),
                  )
                : undefined;
            agentPrepared?.catch(() => {});

            // Everything below may send: the window write lands first.
            await windowReady;

            // Automations run last, and never for a message that was an opt-out /
            // opt-in keyword or a cash-on-delivery answer. Inbound only — our own
            // outbound sends (including opt-out confirmations and automation
            // replies) never reach here.
            const beforeAutomations = new Date().toISOString();
            const [orgTimezone, automations] = await (automationReads ?? Promise.reject(new Error("not read"))).catch(() =>
              Promise.all([
                loadOrgTimezone(supabase, orgId, timezoneCache),
                loadAutomations(supabase, orgId, automationCache),
              ]),
            );
            const automationReplied = await evaluateAutomations(supabase, {
              organizationId: orgId,
              phoneNumberId,
              accessToken,
              conversationId: conversation.id as string,
              contactId: contact.id as string,
              inboundMessageId: String(msg["id"] ?? ""),
              waId,
              body,
              optKeywordMatched: optKeywordMatched || codHandled,
              isSystemEcho,
              orgTimezone,
              automations,
            });
            clock.mark("automations");

            // The AI employee gets the last word, and only when nothing else
            // answered this message. Never on our own echoes or on a duplicate
            // delivery, and never after an automation already replied.
            if (!isSystemEcho && inserted && inserted.length > 0) {
              // Did anything already answer THIS message? An automation says
              // so itself; a teammate's reply from the Inbox (sent_by) is read
              // now, while the burst window runs out. Batch 29: this used to
              // count every outbound message since, so the reply Aiden (or a
              // flow) was still sending to the customer's PREVIOUS message
              // made this one "already handled" — nothing ran, and the
              // customer heard nothing until they wrote again (live: 9
              // replies at 60–162 s). Those replies answer another message.
              const repliedRead = automationReplied
                ? Promise.resolve(1)
                : Promise.resolve(
                    supabase
                      .from("messages")
                      .select("id", { count: "exact", head: true })
                      .eq("conversation_id", conversation.id)
                      .eq("direction", "outbound")
                      .not("sent_by", "is", null)
                      .gte("created_at", beforeAutomations),
                  ).then(({ count }) => count ?? 0);

              // Batch 27 (H2): set while Aiden is answering this message, so a
              // throw from that pass hands the chat to a person, not silence.
              let agentAnswering = false;
              let agentQuestion: string | null = null;
              try {
                const handledBefore = optKeywordMatched || codHandled;
                const optedOut =
                  (contact as { opt_in_status?: string }).opt_in_status === "opted_out";

                const { runAgentOnInbound, prepareAgentInbound, readAgentGate } = await import("@/lib/ai-agent.server");
                // The agent's gate (owner, hand-over, window) is read the
                // moment the wait ends, alongside the burst read.
                let gate: ReturnType<typeof readAgentGate> | undefined;
                // Two texts typed a breath apart are one question: wait out the
                // burst, answer once, and let the overtaken delivery stand down.
                const waitBurst = async (text: string | null) =>
                  coalesceBurst(supabase, {
                    conversationId: conversation.id as string,
                    messageId: (inserted[0] as { id?: string } | undefined)?.id ?? null,
                    occurredAt,
                    body: text,
                    storedAt,
                    settings: await burstWindow,
                    afterWait: () => {
                      gate = readAgentGate(supabase, conversation.id as string);
                    },
                  });

                let alreadyHandled: boolean;
                let agentBody = body;
                let mediaFallback: string | null = null;
                // M7: a chat a person owns (or that waits on one) is theirs:
                // no transcription and no automatic fallback, at our cost.
                let personOwns = false;
                let burst: { proceed: boolean; body: string | null };
                let burstStarted = Date.now();
                let knowledgeAhead: Promise<KnowledgeAhead | null> | undefined;
                if (media.media_url) {
                  // Pictures and voice notes become words first, so a
                  // media-only message is never dropped on the floor — and
                  // only once we know nothing else answered (it costs a read).
                  alreadyHandled = handledBefore || (await repliedRead) > 0;
                  if (!alreadyHandled && !optedOut) {
                    const owner = await readAgentGate(supabase, conversation.id as string);
                    personOwns = Boolean(owner?.assigned_to) || owner?.needs_human === true;
                  }
                  if (!alreadyHandled && !optedOut && !personOwns) {
                    const converted = await customerMediaToText(supabase, {
                      organizationId: orgId,
                      conversationId: conversation.id as string,
                      messageId: (inserted[0] as { id?: string } | undefined)?.id ?? null,
                      accessToken,
                      caption: body,
                      media,
                    });
                    agentBody = converted.body;
                    mediaFallback = converted.fallback;
                  }
                  burstStarted = Date.now();
                  burst = alreadyHandled || optedOut ? { proceed: true, body: agentBody } : await waitBurst(agentBody);
                } else {
                  // Text: the burst wait and the replied read run together.
                  const waiting = handledBefore || optedOut ? null : waitBurst(agentBody);
                  waiting?.catch(() => {});
                  alreadyHandled = handledBefore || (await repliedRead) > 0;
                  // Batch 29: nothing else answered — the material match for
                  // these words starts now, inside the burst wait, not after it.
                  if (waiting && !alreadyHandled && agentPrepared) {
                    const { startKnowledgeAhead } = await import("@/lib/ai-agent.server");
                    // Never for a chat a person owns (the open conversation read carries both).
                    const personAtStart = Boolean(conversation.assigned_to) || conversation.needs_human === true;
                    knowledgeAhead = agentPrepared.then((prep) =>
                      startKnowledgeAhead(supabase, prep, orgId, agentBody, personAtStart),
                    );
                    // Awaited before the event closes, used or not (never fire-and-forget).
                    later(knowledgeAhead.then((k) => k?.match));
                  }
                  burst = waiting && !alreadyHandled ? await waiting : { proceed: true, body: agentBody };
                }

                // Started when no flow took the message (see above); an
                // answered or opted-out message never uses it.
                const prepared =
                  alreadyHandled || optedOut
                    ? undefined
                    : (agentPrepared ?? prepareAgentInbound(supabase, orgId, conversation.id as string));

                if (!burst.proceed) {
                  route = "ai_superseded";
                  console.log("[ai-agent] burst_superseded", conversation.id);
                  continue;
                }
                agentBody = burst.body;
                clock.mark("burst");
                const burstMs = Date.now() - burstStarted;

                route = "ai";
                agentAnswering = !alreadyHandled && !optedOut;
                agentQuestion = agentBody;
                const outcome = await runAgentOnInbound(supabase, {
                  organizationId: orgId,
                  conversationId: conversation.id as string,
                  contactId: contact.id as string,
                  phoneNumberId,
                  accessToken,
                  waId,
                  body: agentBody,
                  alreadyHandled,
                  optedOut,
                  ...(prepared ? { prepared } : {}),
                  ...(gate ? { gate } : {}),
                  ...(knowledgeAhead ? { knowledgeAhead } : {}),
                  ...(contextMetaId ? { replyToMetaId: contextMetaId } : {}),
                  timer: clock.timer,
                  // A live reply is coming: read receipt + typing dots now.
                  onWillReply: () => later(showTyping(connectionP, phoneNumberId, String(msg["id"] ?? ""))),
                  later,
                  speed: {
                    sinceReceived: clock.sinceReceived,
                    pickup: reanswered ? "reanswer" : (meta.pickup?.via ?? "live"),
                    burstMs: burstMs,
                  },
                });
                agentAnswering = false;
                clock.mark("ai_done");
                // Why Aiden did (or didn't) answer, on the event's timing:
                // a quick "ai" with nothing sent is never a mystery again.
                clock.note(
                  "ai_outcome",
                  outcome.acted ? `${outcome.mode}:${outcome.status}${"sent" in outcome ? (outcome.sent ? ":sent" : ":not_sent") : ""}` : outcome.reason,
                );

                // Only a live-replying agent speaks; otherwise the thread just
                // sits unread in the inbox for a person, as it always has.
                if (mediaFallback && !personOwns && !outcome.acted && outcome.reason === "no_text") {
                  const { data: agentRow } = await supabase
                    .from("ai_agents")
                    .select("mode")
                    .eq("organization_id", orgId)
                    .eq("is_default", true)
                    .maybeSingle();
                  if ((agentRow as { mode?: string } | null)?.mode === "replying") {
                    const { sendServiceText } = await import("@/lib/service-text.server");
                    await sendServiceText(supabase, {
                      organizationId: orgId,
                      phoneNumberId,
                      accessToken,
                      conversationId: conversation.id as string,
                      to: waId,
                      body: mediaFallback,
                    });
                  }
                }
              } catch (error) {
                console.error(
                  "[ai-agent] failed",
                  error instanceof Error ? error.message : String(error),
                );
                if (agentAnswering) {
                  const { stepBackAfterAgentFailure } = await import("@/lib/ai-agent.server");
                  const handed = await stepBackAfterAgentFailure(supabase, {
                    organizationId: orgId,
                    conversationId: conversation.id as string,
                    contactId: contact.id as string,
                    phoneNumberId,
                    accessToken,
                    waId,
                    question: agentQuestion,
                    since: beforeAutomations,
                    later,
                  });
                  if (handed) console.log("[ai-agent] stepped_back_after_failure", conversation.id);
                }
              }
            }
          } catch (err) {
            // One bad message never drops the rest of the event; the event
            // stays retryable (see finishEvent).
            route = "failed";
            failures.push(failureNote(`message ${String(msg["id"] ?? "")}`, err));
          } finally {
            clock.log(String(msg["id"] ?? ""), route);
            // Awaited right after the reply, so a pass that dies later never
            // makes the retry answer twice.
            if (route !== "failed") await markAnswered(supabase, answerRowId);
            startAfterReply();
          }
        }


        // ---- status updates ----
        // ~3 of these arrive for every message a campaign sends, so each is
        // one conditional update of the message (returning the row and its
        // conversation), one for the campaign recipient, the price for
        // delivered/read, and the event. Never a read-then-write.
        for (const st of (value["statuses"] as AnyRecord[] | undefined) ?? []) {
          try {
            const metaId = st["id"] as string | undefined;
            const nextStatus = String(st["status"] ?? "");
            if (!metaId || !nextStatus) continue;
            if (nextStatus !== "failed" && STATUS_RANK[nextStatus] === undefined) continue;
            const ours = parseCampaignCallbackData(st["biz_opaque_callback_data"]);

            const tsSeconds = Number(st["timestamp"] ?? 0);
            const at = tsSeconds
              ? new Date(tsSeconds * 1000).toISOString()
              : new Date().toISOString();
            const errs = (st["errors"] as AnyRecord[] | undefined) ?? [];
            const detail = errs.length ? JSON.stringify(errs) : "unknown_error";

            // What Meta actually charged for. This is authoritative: a utility
            // message inside an open service window is free, and only a billable
            // delivered message costs anything. Cost is never inferred from the
            // fact that a send happened.
            const pricing = st["pricing"] as AnyRecord | undefined;
            const pricingPatch = pricing
              ? {
                  billable: pricing["billable"] === undefined ? null : Boolean(pricing["billable"]),
                  pricing_model: pricing["pricing_model"] != null ? String(pricing["pricing_model"]) : null,
                  pricing_category:
                    pricing["category"] != null ? String(pricing["category"]).toLowerCase() : null,
                }
              : {};
            const patch =
              nextStatus === "failed"
                ? { status: "failed", status_updated_at: at, error_detail: detail }
                : { status: nextStatus, status_updated_at: at, ...pricingPatch };

            let existing: StatusRow | null | undefined = await applyMessageStatus(
              supabase,
              orgId,
              metaId,
              nextStatus,
              patch,
            );
            if (!existing && ours) {
              existing = await applyWhenWritten(supabase, orgId, metaId, nextStatus, patch);
              if (existing === undefined) {
                failures.push(`status ${metaId}: campaign message not written yet`);
                continue;
              }
            }
            if (!existing) {
              // Already at this status: a retry of an event whose first try
              // moved the message and then failed, or a late duplicate. Redo
              // only the steps that are safe to repeat (never the event).
              const known =
                existing === null && nextStatus !== "failed"
                  ? await retakeStatusSteps(supabase, orgId, metaId, nextStatus, ours?.recipientId ?? null, at)
                  : Boolean(ours);
              // Batch 27: no row at all for one of our non-campaign messages
              // (Aiden, flows, the inbox) — its row is written a moment after
              // Meta accepts the send, and this status beat it. Leave the
              // event for the retry pass instead of losing the status, while
              // it is recent; an old one is a message we never sent.
              if (!known && Date.now() - Date.parse(at) < STATUS_ROW_WAIT_MS) {
                failures.push(`status ${metaId}: message not written yet`);
              }
              continue;
            }

            // Batch 34: a message the Public API sent tells the merchant's own
            // system too (queued here; the minute worker delivers it).
            {
              const hookError = await queueApiStatusOf(supabase, orgId, existing, nextStatus, at, nextStatus === "failed" ? detail : null);
              if (hookError) failures.push(failureNote(`status ${metaId}`, hookError));
            }

            // Every per-message event carries the same dimensions as the send.
            const statusProps = await messageEventDimensions(supabase, orgId, accountWabaId, existing);
            const campaignMessage =
              Boolean(existing.campaign_id || ours) ||
              (!existing.flow_id && (!existing.created_at || existing.created_at < ATTRIBUTION_SINCE));

            if (nextStatus === "failed") {
              if (campaignMessage) {
                const counterError = await applyCampaignStatus(supabase, existing.id, "failed", detail, ours?.recipientId ?? null);
                if (counterError) failures.push(failureNote(`status ${metaId}`, counterError));
              }
              await emitEvent(supabase, "message.failed", {
                organizationId: orgId,
                whatsappAccountId: accountId,
                entityType: "message",
                entityId: existing.id as string,
                occurredAt: at,
                properties: {
                  ...statusProps,
                  whatsapp_account_id: accountId,
                  error_code: errs[0]?.["code"] != null ? String(errs[0]!["code"]) : null,
                },
              });
              continue;
            }

            if (campaignMessage) {
              // Never stops the price and the event below (Batch 28).
              const counterError = await applyCampaignStatus(supabase, existing.id, nextStatus, null, ours?.recipientId ?? null);
              if (counterError) failures.push(failureNote(`status ${metaId}`, counterError));
            }

            // Priced from the rate card, in the database, so a missing rate is a
            // warning and never a guessed number.
            if (nextStatus === "delivered" || nextStatus === "read") {
              const { data: priced, error: priceError } = await supabase.rpc("price_message", {
                p_message_id: existing.id,
              });
              const campaignId = existing.campaign_id ? String(existing.campaign_id) : null;
              if (!priceError && priced !== false && campaignId) {
                // The debit for this message was just written (by the database,
                // with the price); keep the campaign's total in step with it —
                // re-read at most every few seconds per campaign (the campaign
                // worker catches up the tail after it completes).
                const last = chargedSyncedAt.get(campaignId) ?? 0;
                if (Date.now() - last >= CHARGED_SYNC_EVERY_MS) {
                  chargedSyncedAt.set(campaignId, Date.now());
                  try {
                    const { syncCampaignCharged } = await import("@/lib/campaign-billing.server");
                    await syncCampaignCharged(supabase, orgId, campaignId);
                  } catch (error) {
                    console.warn(
                      JSON.stringify({
                        scope: "campaign_charged",
                        campaign_id: campaignId,
                        error: error instanceof Error ? error.message : String(error),
                      }),
                    );
                  }
                }
              }
              if (priceError || priced === false) {
                console.warn(
                  JSON.stringify({
                    scope: "message_cost",
                    stage: "no_matching_rate",
                    message_id: existing.id,
                    category: (pricingPatch as { pricing_category?: string | null }).pricing_category ?? null,
                    organization_id: orgId,
                    error: priceError?.message ?? null,
                  }),
                );
              }
              // Not priced = not billed: the event stays retryable, and the
              // retry prices it (retakeStatusSteps).
              if (priceError) failures.push(failureNote(`price ${metaId}`, priceError.message));
            }

            if (nextStatus === "delivered" || nextStatus === "read" || nextStatus === "sent") {
              await emitEvent(supabase, `message.${nextStatus}`, {
                organizationId: orgId,
                whatsappAccountId: accountId,
                entityType: "message",
                entityId: existing.id as string,
                occurredAt: at,
                properties: { ...statusProps, whatsapp_account_id: accountId },
              });
            }

          } catch (err) {
            // One bad status never drops the rest of the event; the event
            // stays retryable (see finishEvent).
            failures.push(failureNote(`status ${String(st["id"] ?? "")}`, err));
          }
        }

      }
    }

    startAfterReply();
    await Promise.all(deferred);
    await finishEvent(supabase, eventId, failures, routedAny ? null : "unknown_phone_number_id", timingRecord(), {
      leased: Boolean(meta.leased),
    });
  } catch (err) {
    await finishEvent(supabase, eventId, [failureNote("event", err)], null, timingRecord(), {
      leased: Boolean(meta.leased),
    });
  }
}

/**
 * Stored vs answered (messages.answered_at / answer_claimed_at, migration
 * 20261032_batch17_message_answered.sql). A failed write steps aside: a
 * duplicate stays a duplicate.
 */
export const REANSWER_AFTER_MS = 3 * 60_000;

async function answerWrite(run: () => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>) {
  try {
    const { data, error } = await run();
    return error ? null : data;
  } catch {
    return null;
  }
}

/**
 * Batch 29: a customer message picked up by a safety net instead of the
 * webhook's own pass — catch-up (reprocessUnprocessedEvents) or the re-answer
 * of a stored, never-answered message (reclaimUnanswered). Every reply is
 * produced in the webhook's own request; each pickup is logged (scope
 * "reply_pickup") and kept on webhook_events.timing.pickup so it shows on
 * live, with why and how late.
 */
export type ReplyPickup = {
  via: "catch_up" | "reanswer";
  /** catch_up: never_processed | retry_after_failure | pass_died; reanswer: stored_never_answered. */
  reason: string;
  /** ms from receiving the message (event received_at / message time) to this pickup. */
  delay_ms: number | null;
};

export function logReplyPickup(pickup: ReplyPickup, ids: { event_id?: string | null; message_id?: string | null }): void {
  console.warn(JSON.stringify({ scope: "reply_pickup", ...pickup, ...ids }));
}

/** This pass finished routing the message (answered, or deliberately not). */
export async function markAnswered(supabase: SupabaseClient, rowId: string | null): Promise<void> {
  if (!rowId) return;
  await answerWrite(() =>
    supabase.from("messages").update({ answered_at: new Date().toISOString() }).eq("id", rowId).is("answered_at", null),
  );
}

/**
 * A duplicate delivery of an inbound message that was stored but never
 * answered (its pass died) and isn't being answered right now. The insert
 * stamps answer_claimed_at (column default), so a live pass is never
 * doubled; one conditional update claims it, so only one retry answers.
 */
export async function reclaimUnanswered(
  supabase: SupabaseClient,
  metaMessageId: string,
): Promise<Array<{ id: string }> | null> {
  if (!metaMessageId) return null;
  const cutoff = new Date(Date.now() - REANSWER_AFTER_MS).toISOString();
  const claimed = (await answerWrite(() =>
    supabase
      .from("messages")
      .update({ answer_claimed_at: new Date().toISOString() })
      .eq("meta_message_id", metaMessageId)
      .eq("direction", "inbound")
      .is("answered_at", null)
      .lt("answer_claimed_at", cutoff)
      .select("id, created_at"),
  )) as Array<{ id: string; created_at?: string | null }> | null;
  if (!claimed?.length) return null;
  const at = claimed[0]!.created_at ? Date.parse(claimed[0]!.created_at) : NaN;
  logReplyPickup(
    { via: "reanswer", reason: "stored_never_answered", delay_ms: Number.isFinite(at) ? Math.max(0, Date.now() - at) : null },
    { message_id: claimed[0]!.id },
  );
  return claimed;
}

/** Retries an event gets before it is recorded as given up. */
export const WEBHOOK_MAX_ATTEMPTS = 5;

function failureNote(what: string, err: unknown): string {
  return `${what}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200);
}

/** "retry:2 ..." -> 2. The attempt count lives in the error text, no new column. */
export function webhookAttempts(error: string | null | undefined): number {
  const match = /^retry:(\d+) /.exec(error ?? "");
  return match ? Number(match[1]) : 0;
}

/**
 * Close an event. Clean: processed. Anything failed: processed_at goes back to
 * null so reprocess-events runs it again — messages already stored come back
 * as duplicates and are never answered twice — until WEBHOOK_MAX_ATTEMPTS,
 * after which it is recorded as given up.
 */
export async function finishEvent(
  supabase: SupabaseClient,
  eventId: string,
  failures: string[],
  cleanError: string | null,
  /** Per-stage timings, stored on webhook_events.timing. */
  timing: Record<string, unknown> | null = null,
  /** leased: a catch-up pass held the event (lease_until); closing it lets the lease go. */
  options: { leased?: boolean } = {},
): Promise<void> {
  // Only a leased run writes lease_until: the live path never needs the
  // column (so it works before 20261070_batch27_webhook_lease.sql is applied).
  const lease = options.leased ? { lease_until: null } : {};
  if (failures.length === 0) {
    await updateEvent(supabase, eventId, { processed_at: new Date().toISOString(), error: cleanError, ...lease }, timing);
    return;
  }
  const { data: prior } = await supabase
    .from("webhook_events")
    .select("error")
    .eq("id", eventId)
    .maybeSingle();
  const attempt = webhookAttempts((prior as { error?: string | null } | null)?.error) + 1;
  const detail = `${failures.length} failed: ${failures.join("; ")}`;
  const givenUp = attempt >= WEBHOOK_MAX_ATTEMPTS;
  console.error(
    JSON.stringify({
      at: "webhook_event_failed",
      event_id: eventId,
      attempt,
      given_up: givenUp,
      detail: detail.slice(0, 500),
    }),
  );
  await updateEvent(
    supabase,
    eventId,
    {
      processed_at: givenUp ? new Date().toISOString() : null,
      error: (givenUp ? `gave_up:${attempt} ${detail}` : `retry:${attempt} ${detail}`).slice(
        0,
        500,
      ),
      ...lease,
    },
    timing,
  );
}

/** Closes the event with its timings (webhook_events.timing) in the same write. */
async function updateEvent(
  supabase: SupabaseClient,
  eventId: string,
  patch: Record<string, unknown>,
  timing: Record<string, unknown> | null,
): Promise<void> {
  await supabase
    .from("webhook_events")
    .update(timing ? { ...patch, timing } : patch)
    .eq("id", eventId);
}

/**
 * Batch 27 (H1): catch-up never takes a customer message before a retry may
 * re-answer it (reclaimUnanswered: REANSWER_AFTER_MS) plus the live pass's
 * own life (~30 s, cut by the platform). An event caught any earlier found
 * its message "stored, claimed by a live pass" and was closed as a duplicate,
 * so the customer was never answered. Status-only events keep their 60 s.
 */
export const CATCH_UP_MESSAGES_AFTER_MS = REANSWER_AFTER_MS + 30_000;
/** How long one catch-up pass holds an event (webhook_events.lease_until) before another may take it. */
export const CATCH_UP_LEASE_MS = 3 * 60_000;

type CatchUpRow = {
  id: unknown;
  payload: unknown;
  received_at?: string | null;
  lease_until?: string | null;
  error?: string | null;
};

/**
 * Catch-up processing: re-run processing for stored events that have a valid
 * signature and were never processed. Used by each incoming webhook (for
 * events older than `olderThanSeconds`) and after a WhatsApp account is
 * connected (with `olderThanSeconds: 0`, so earlier messages get routed).
 *
 * An event is held with a lease while it runs (lease_until, migration
 * 20261070_batch27_webhook_lease.sql) and marked processed only when it
 * closes, so a pass that dies leaves it for the next one. Before that column
 * exists it is claimed with processed_at, as before.
 */
export async function reprocessUnprocessedEvents(
  supabase: SupabaseClient,
  options: {
    olderThanSeconds?: number;
    limit?: number;
    /**
     * Status-only events (sent / delivered / read) at most this many at a
     * time; events with customer messages always one by one, in order, so
     * replies never overtake each other. Default 1: exactly as before.
     */
    statusConcurrency?: number;
    /** Stop starting new events after this long (ms). */
    budgetMs?: number;
  } = {},
): Promise<number> {
  const olderThanSeconds = options.olderThanSeconds ?? 60;
  const limit = options.limit ?? 50;
  const concurrency = Math.max(1, options.statusConcurrency ?? 1);
  const deadline = options.budgetMs !== undefined ? Date.now() + options.budgetMs : Infinity;
  const startedAt = Date.now();
  const cutoff = new Date(startedAt - olderThanSeconds * 1000).toISOString();
  // olderThanSeconds 0 (a number just connected) still means "everything now".
  const messageCutoff =
    olderThanSeconds > 0 ? startedAt - Math.max(olderThanSeconds * 1000, CATCH_UP_MESSAGES_AFTER_MS) : Infinity;

  const read = (columns: string) =>
    supabase
      .from("webhook_events")
      .select(columns)
      .is("processed_at", null)
      .eq("provider", "meta")
      .eq("signature_valid", true)
      .lte("received_at", cutoff)
      .order("received_at", { ascending: true })
      .limit(limit);
  let leases = true;
  let { data: events, error: readError } = (await read("id, payload, received_at, lease_until, error")) as unknown as {
    data: CatchUpRow[] | null;
    error: unknown;
  };
  if (readError) {
    // lease_until not there yet (or a bad read): claim with processed_at, as before.
    leases = false;
    ({ data: events } = (await read("id, payload, received_at")) as unknown as { data: CatchUpRow[] | null });
  }

  if (!events?.length) return 0;
  let handled = 0;

  /** Hold the event for this pass; false when another pass holds it or closed it. */
  const claim = async (event: CatchUpRow): Promise<boolean> => {
    if (!leases) {
      // Claim the event first: two overlapping catch-up passes used to pick the
      // same rows and could each run a reply.
      const { data: claimed } = await supabase
        .from("webhook_events")
        .update({ processed_at: new Date().toISOString() })
        .eq("id", event.id as string)
        .is("processed_at", null)
        .select("id");
      return Boolean(claimed?.length);
    }
    const now = Date.now();
    const held = event.lease_until ? Date.parse(event.lease_until) : NaN;
    if (Number.isFinite(held) && held > now) return false; // another pass is on it
    // A lease that ran out while the event is still open: that pass died.
    // It counts as an attempt, so an event that kills every pass still ends.
    const died = Number.isFinite(held);
    const attempt = died ? webhookAttempts(event.error) + 1 : 0;
    const givenUp = died && attempt >= WEBHOOK_MAX_ATTEMPTS;
    const patch: Record<string, unknown> = givenUp
      ? { processed_at: new Date(now).toISOString(), lease_until: null, error: `gave_up:${attempt} catch-up pass never finished` }
      : {
          lease_until: new Date(now + CATCH_UP_LEASE_MS).toISOString(),
          ...(died ? { error: `retry:${attempt} catch-up pass never finished` } : {}),
        };
    // Compare-and-set on the lease value we read: one pass wins.
    let q = supabase.from("webhook_events").update(patch).eq("id", event.id as string).is("processed_at", null);
    q = event.lease_until ? q.eq("lease_until", event.lease_until) : q.is("lease_until", null);
    const { data: claimed } = await q.select("id");
    if (givenUp && claimed?.length) {
      console.error(JSON.stringify({ at: "webhook_event_failed", event_id: event.id, attempt, given_up: true, detail: "lease expired" }));
      return false;
    }
    return Boolean(claimed?.length);
  };

  const one = async (event: CatchUpRow, onlyStatuses: boolean) => {
    // Read before the claim rewrites them: why this event is still open.
    const reason = event.lease_until ? "pass_died" : event.error ? "retry_after_failure" : "never_processed";
    if (!(await claim(event))) return;
    handled += 1;
    const received = event.received_at ? Date.parse(event.received_at) : NaN;
    const pickup: ReplyPickup = {
      via: "catch_up",
      reason,
      delay_ms: Number.isFinite(received) ? Math.max(0, Date.now() - received) : null,
    };
    // Only a customer message is a reply pickup (status events are thousands a day).
    if (!onlyStatuses) logReplyPickup(pickup, { event_id: event.id as string });
    await processWebhookPayload(
      supabase,
      event.id as string,
      (event.payload ?? {}) as AnyRecord,
      // Batch 29: the event's own received_at, so the reply's speed counts the real wait.
      event.received_at ?? null,
      { ...(leases ? { leased: true } : {}), ...(onlyStatuses ? {} : { pickup }) },
    );
  };
  const statusOnly = (payload: unknown) =>
    ((payload as AnyRecord | null)?.["entry"] as AnyRecord[] | undefined)?.every((e) =>
      ((e["changes"] as AnyRecord[] | undefined) ?? []).every(
        (c) => (((c["value"] as AnyRecord | undefined)?.["messages"] as unknown[] | undefined) ?? []).length === 0,
      ),
    ) ?? false;

  const batch: CatchUpRow[] = [];
  const flush = async () => {
    for (let i = 0; i < batch.length; i += concurrency) {
      await Promise.all(batch.slice(i, i + concurrency).map((e) => one(e, true)));
    }
    batch.length = 0;
  };
  for (const event of events) {
    if (Date.now() >= deadline) break;
    const onlyStatuses = statusOnly(event.payload);
    // A customer message too young to re-answer waits for a later pass (H1).
    const receivedAt = event.received_at ? Date.parse(event.received_at) : NaN;
    if (!onlyStatuses && Number.isFinite(receivedAt) && receivedAt > messageCutoff) continue;
    if (concurrency > 1 && onlyStatuses) {
      batch.push(event);
      if (batch.length >= concurrency) await flush();
      continue;
    }
    await flush();
    await one(event, onlyStatuses);
  }
  await flush();
  return handled;
}

