import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { detectLanguage } from "@/lib/languages";
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
import { getWhatsAppConnection } from "@/lib/whatsapp-numbers.server";
import {
  evaluateAutomations,
  loadAutomations,
  loadOrgTimezone,
} from "@/lib/automations.server";
import type { AutomationRow } from "@/lib/automations";
import { emitEvent } from "@/lib/events.server";

/** Service-role client for the AiDwar (Mumbai) backend. Server-only. */
export function getServiceClient(): SupabaseClient {
  const url = new URL(process.env["AIDWAR_SUPABASE_URL"]!).origin;
  return createClient(url, process.env["AIDWAR_SUPABASE_SERVICE_ROLE_KEY"]!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
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

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  read: 3,
};

const RECIPIENT_RANK: Record<string, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

const REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Mirrors a message status onto its campaign recipient (monotonic) and bumps
 * the campaign's delivered/read counters exactly once per transition.
 */
async function applyCampaignStatus(
  supabase: SupabaseClient,
  messageId: string,
  nextStatus: string,
  errorDetail: string | null,
): Promise<void> {
  const { data: recipient } = await supabase
    .from("campaign_recipients")
    .select("id, campaign_id, status")
    .eq("message_id", messageId)
    .maybeSingle();
  if (!recipient) return;

  if (nextStatus === "failed") {
    if (recipient.status === "failed") return;
    await supabase
      .from("campaign_recipients")
      .update({ status: "failed", error: (errorDetail ?? "Delivery failed").slice(0, 300) })
      .eq("id", recipient.id);
    await supabase.rpc("bump_campaign_counters", {
      p_campaign_id: recipient.campaign_id,
      p_failed: 1,
    });
    return;
  }

  const current = RECIPIENT_RANK[String(recipient.status)] ?? -1;
  const incoming = RECIPIENT_RANK[nextStatus];
  if (incoming === undefined || incoming <= current) return;

  await supabase
    .from("campaign_recipients")
    .update({ status: nextStatus })
    .eq("id", recipient.id);

  await supabase.rpc("bump_campaign_counters", {

    p_campaign_id: recipient.campaign_id,
    ...(nextStatus === "delivered" ? { p_delivered: 1 } : {}),
    ...(nextStatus === "read"
      ? { p_read: 1, ...(current < RECIPIENT_RANK["delivered"]! ? { p_delivered: 1 } : {}) }
      : {}),
  });
}

/**
 * Shared dimensions for message.sent/delivered/read/failed: which campaign or
 * flow the message belonged to, the template, the business account, the billing
 * category and the marketing/transactional class. Attribution now lives on the
 * messages row itself, so the status callbacks carry exactly the same
 * dimensions the send path emitted. Lookup failures degrade to nulls — capture
 * never blocks the webhook.
 */
async function messageEventDimensions(
  supabase: SupabaseClient,
  organizationId: string,
  wabaId: string | null,
  message: {
    id: string;
    type?: string | null;
    template_name?: string | null;
    conversation_id?: string | null;
    campaign_id?: string | null;
    flow_id?: string | null;
    flow_step_id?: string | null;
    scheduled_send_id?: string | null;
  },
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
    if (!campaignId && !flowId) {
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

    if (message.conversation_id) {
      const { data: conv } = await supabase
        .from("conversations")
        .select("contact_id, whatsapp_account_id")
        .eq("id", message.conversation_id)
        .maybeSingle();
      contactId = contactId ?? ((conv?.contact_id as string) ?? null);
      accountId = (conv?.whatsapp_account_id as string) ?? null;
    }

    if (templateName) {
      let query = supabase
        .from("message_templates")
        .select("category")
        .eq("organization_id", organizationId)
        .eq("name", templateName);
      if (wabaId) query = query.eq("waba_id", wabaId);
      const { data: tpl } = await query.limit(1).maybeSingle();
      billingCategory = String((tpl as { category?: string } | null)?.category ?? "utility");
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


/** Counts one reply per contact per campaign for campaigns sent in the last 7 days. */
async function applyCampaignReply(
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
    await supabase
      .from("campaign_recipients")
      .update({ replied_at: new Date().toISOString() })
      .eq("id", r["id"] as string);
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

async function loadMarkers(
  supabase: SupabaseClient,
  organizationId: string,
  cache: Map<string, MarkerRow[]>,
): Promise<MarkerRow[]> {
  const cached = cache.get(organizationId);
  if (cached) return cached;
  const { data } = await supabase
    .from("lead_source_markers")
    .select("marker, source")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: true });
  const rows = ((data as MarkerRow[]) ?? []).filter((r) => r.marker && r.source);
  cache.set(organizationId, rows);
  return rows;
}

type KeywordSets = { optOut: string[]; optIn: string[] };

/** Built-in keywords plus the organization's own configured list. */
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
  const rows = (data as Array<{ keyword: string; action: string }> | null) ?? [];
  const sets: KeywordSets = {
    optOut: [
      ...DEFAULT_OPT_OUT_KEYWORDS,
      ...rows.filter((r) => r.action === "opt_out").map((r) => r.keyword),
    ],
    optIn: [
      ...DEFAULT_OPT_IN_KEYWORDS,
      ...rows.filter((r) => r.action === "opt_in").map((r) => r.keyword),
    ],
  };
  cache.set(organizationId, sets);
  return sets;
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

function mediaOf(msg: AnyRecord): { media_url: string | null; media_mime: string | null } {
  const type = String(msg["type"] ?? "");
  const m = msg[type] as AnyRecord | undefined;
  if (!m || typeof m !== "object") return { media_url: null, media_mime: null };
  const id = m["id"] as string | undefined;
  return {
    media_url: id ? `meta:${id}` : null,
    media_mime: (m["mime_type"] as string | undefined) ?? null,
  };
}

/**
 * Process one webhook payload. Routes each change to an organization via
 * phone_number_id, writes inbound messages and applies monotonic status updates.
 */
export async function processWebhookPayload(
  supabase: SupabaseClient,
  eventId: string,
  payload: AnyRecord,
): Promise<void> {
  try {
    const entries = (payload["entry"] as AnyRecord[] | undefined) ?? [];
    const markerCache = new Map<string, MarkerRow[]>();
    const keywordCache = new Map<string, KeywordSets>();
    const automationCache = new Map<string, AutomationRow[]>();
    const timezoneCache = new Map<string, string>();
    const tokenCache = new Map<string, string>();
    let routedAny = false;

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


        // ---- template status updates (routed by WABA id, not phone number) ----
        if (String(change["field"] ?? "") === "message_template_status_update") {
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
          const event = String(value["event"] ?? "").toUpperCase();
          const allowed = ["PENDING", "APPROVED", "REJECTED", "PAUSED"];
          const nextStatus = allowed.includes(event)
            ? event
            : event === "FLAGGED" || event === "PENDING_DELETION"
              ? "PAUSED"
              : null;
          if (!nextStatus) continue;

          const reason = (value["reason"] as string | undefined) ?? null;
          let update = supabase
            .from("message_templates")
            .update({
              status: nextStatus,
              rejection_reason:
                nextStatus === "REJECTED" ? (reason && reason !== "NONE" ? reason : "Rejected by review") : null,
              updated_at: new Date().toISOString(),
            })
            .eq("organization_id", wabaOrgIds[0]!)
            // Templates live inside a WABA — never touch the other library.
            .eq("waba_id", wabaId);

          if (metaTemplateId !== undefined && metaTemplateId !== null) {
            update = update.eq("meta_template_id", String(metaTemplateId));
          } else if (templateName) {
            update = update.eq("name", templateName);
            if (templateLanguage) update = update.eq("language", templateLanguage);
          } else {
            continue;
          }
          await update;
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

        const { data: account } = await supabase
          .from("whatsapp_accounts")
          .select("id, organization_id, waba_id")
          .eq("phone_number_id", phoneNumberId)
          .maybeSingle();

        // phone_number_id is globally unique, so an unknown one means the
        // payload isn't ours: it stays recorded and unrouted, never attached
        // to some other account.
        if (!account) continue;
        routedAny = true;
        const orgId = account.organization_id as string;
        const accountId = account.id as string;
        const accountWabaId = (account.waba_id as string | null) ?? null;

        // Token for THIS number's WABA — replies always go back out on the
        // number the customer wrote to.
        let accessToken = tokenCache.get(accountId);
        if (accessToken === undefined) {
          const { connection } = await getWhatsAppConnection(supabase, orgId, accountId);
          accessToken = connection?.accessToken ?? "";
          tokenCache.set(accountId, accessToken);
        }

        // ---- inbound messages ----
        const contactsMeta = (value["contacts"] as AnyRecord[] | undefined) ?? [];
        for (const msg of (value["messages"] as AnyRecord[] | undefined) ?? []) {
          const waId = toWaId(msg["from"] as string | undefined);
          if (!waId) continue;
          // Our own number appearing as the sender means this is an echo of a
          // message we sent (confirmation, automation reply). Never automate on it.
          const selfWaId = toWaId(metadata["display_phone_number"] as string | undefined);
          const isSystemEcho = Boolean(selfWaId && selfWaId === waId);
          const profile = contactsMeta.find((c) => c["wa_id"] === waId);
          const profileName =
            ((profile?.["profile"] as AnyRecord | undefined)?.["name"] as string | undefined) ??
            null;

          const parsed = messageBody(msg);
          const attribution = inboundSource(
            msg,
            parsed.body,
            await loadMarkers(supabase, orgId, markerCache),
          );

          // source / source_detail are frozen after insert by a DB trigger,
          // so this only ever applies to brand-new contacts (first touch).
          const { data: contact } = await supabase
            .from("contacts")
            .upsert(
              {
                organization_id: orgId,
                phone: normalizePhone(waId),
                wa_id: waId,
                ...(profileName ? { name: profileName } : {}),
                source: attribution.source,
                source_detail: attribution.source_detail,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "organization_id,phone" },
            )
            .select("id, opt_in_status, created_at")
            .single();
          if (!contact) continue;

          // The upsert can't tell us whether it inserted, so a freshly stamped
          // created_at is the signal for a genuinely new contact.
          const contactAge = Date.now() - new Date(String(contact.created_at)).getTime();
          if (contactAge >= 0 && contactAge < 10_000) {
            await emitEvent(supabase, "contact.created", {
              organizationId: orgId,
              whatsappAccountId: accountId,
              entityType: "contact",
              entityId: contact.id as string,
              properties: { contact_source: attribution.source },
            });
          }

          let { data: conversation } = await supabase
            .from("conversations")
            .select("id, unread_count")
            .eq("organization_id", orgId)
            .eq("contact_id", contact.id)
            .eq("whatsapp_account_id", accountId)
            .eq("status", "open")
            .maybeSingle();

          if (!conversation) {
            const { data: created } = await supabase
              .from("conversations")
              .insert({
                organization_id: orgId,
                contact_id: contact.id,
                whatsapp_account_id: accountId,
                status: "open",
              })
              .select("id, unread_count")
              .single();
            conversation = created;
            if (created) {
              await emitEvent(supabase, "conversation.opened", {
                organizationId: orgId,
                whatsappAccountId: accountId,
                entityType: "conversation",
                entityId: created.id as string,
                properties: { opened_by: "inbound" },
              });
            }
          }
          if (!conversation) continue;

          const { type, body } = parsed;
          const media = mediaOf(msg);
          const tsSeconds = Number(msg["timestamp"] ?? 0);
          const occurredAt = tsSeconds
            ? new Date(tsSeconds * 1000).toISOString()
            : new Date().toISOString();

          const { data: inserted } = await supabase
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
            .select("id");

          // Only bump counters when this message was genuinely new.
          if (inserted && inserted.length > 0) {
            await supabase
              .from("conversations")
              .update({
                last_message_at: occurredAt,
                last_customer_message_at: occurredAt,
                unread_count: (conversation.unread_count ?? 0) + 1,
              })
              .eq("id", conversation.id);
            await applyCampaignReply(supabase, orgId, contact.id);
            await emitEvent(supabase, "message.received", {
              organizationId: orgId,
              whatsappAccountId: accountId,
              entityType: "message",
              entityId: inserted[0]!.id as string,
              occurredAt,
              properties: { message_type: type, conversation_id: conversation.id },
            });
          }

          // Opt-out / opt-in runs on EVERY inbound text, independent of whether
          // the message row was new — it is idempotent (no-op when the status
          // already matches), so duplicate deliveries cannot swallow a "STOP".
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
            keywords: await loadOptKeywords(supabase, orgId, keywordCache),
          });

          // Cash-on-delivery answers. Button replies quote the message that
          // asked, which is how the answer finds its order; anything typed is
          // still stored verbatim so nothing is lost.
          let codHandled = false;
          if (!isSystemEcho && !optKeywordMatched) {
            const { applyCodReply } = await import("@/lib/cod.server");
            const interactive = msg["interactive"] as AnyRecord | undefined;
            const buttonReply = interactive?.["button_reply"] as AnyRecord | undefined;
            const payload =
              ((msg["button"] as AnyRecord | undefined)?.["payload"] as string | undefined) ??
              (buttonReply?.["id"] as string | undefined) ??
              null;
            const contextMetaId =
              ((msg["context"] as AnyRecord | undefined)?.["id"] as string | undefined) ?? null;
            codHandled = await applyCodReply(supabase, {
              organizationId: orgId,
              contactId: contact.id as string,
              contextMetaId,
              body,
              payload,
            });
          }

          // A customer who sends the coupon code back has taken the offer.
          // Only new messages count, so a redelivered webhook can't inflate it.
          if (inserted && inserted.length > 0 && !isSystemEcho) {
            const { recordOfferTap } = await import("@/lib/offers.server");
            const interactiveTap = msg["interactive"] as AnyRecord | undefined;
            await recordOfferTap(supabase, {
              organizationId: orgId,
              contactId: contact.id as string,
              body,
              payload:
                ((msg["button"] as AnyRecord | undefined)?.["payload"] as string | undefined) ??
                ((interactiveTap?.["button_reply"] as AnyRecord | undefined)?.["id"] as
                  | string
                  | undefined) ??
                null,
            });
          }


          // Automations run last, and never for a message that was an opt-out /
          // opt-in keyword or a cash-on-delivery answer. Inbound only — our own
          // outbound sends (including opt-out confirmations and automation
          // replies) never reach here.
          const beforeAutomations = new Date().toISOString();
          await evaluateAutomations(supabase, {
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
            orgTimezone: await loadOrgTimezone(supabase, orgId, timezoneCache),
            automations: await loadAutomations(supabase, orgId, automationCache),
          });

          // The AI employee gets the last word, and only when nothing else
          // answered this message. Never on our own echoes or on a duplicate
          // delivery, and never after an automation already replied.
          if (!isSystemEcho && inserted && inserted.length > 0) {
            const { count: repliedCount } = await supabase
              .from("messages")
              .select("id", { count: "exact", head: true })
              .eq("conversation_id", conversation.id)
              .eq("direction", "outbound")
              .gte("created_at", beforeAutomations);

            try {
              const { runAgentOnInbound } = await import("@/lib/ai-agent.server");
              await runAgentOnInbound(supabase, {
                organizationId: orgId,
                conversationId: conversation.id as string,
                contactId: contact.id as string,
                phoneNumberId,
                accessToken,
                waId,
                body,
                alreadyHandled: optKeywordMatched || codHandled || (repliedCount ?? 0) > 0,
                optedOut:
                  (contact as { opt_in_status?: string }).opt_in_status === "opted_out",
              });
            } catch (error) {
              console.error(
                "[ai-agent] failed",
                error instanceof Error ? error.message : String(error),
              );
            }
          }
        }


        // ---- status updates ----
        for (const st of (value["statuses"] as AnyRecord[] | undefined) ?? []) {
          const metaId = st["id"] as string | undefined;
          const nextStatus = String(st["status"] ?? "");
          if (!metaId || !nextStatus) continue;

          const { data: existing } = await supabase
            .from("messages")
            .select("id, status, type, template_name, conversation_id, campaign_id, flow_id, flow_step_id, scheduled_send_id")
            .eq("meta_message_id", metaId)
            .eq("organization_id", orgId)
            .maybeSingle();
          if (!existing) continue;

          // Every per-message event carries the same dimensions as the send.
          const statusProps = await messageEventDimensions(supabase, orgId, accountWabaId, existing);

          const tsSeconds = Number(st["timestamp"] ?? 0);
          const at = tsSeconds
            ? new Date(tsSeconds * 1000).toISOString()
            : new Date().toISOString();

          if (nextStatus === "failed") {
            const errs = (st["errors"] as AnyRecord[] | undefined) ?? [];
            const detail = errs.length ? JSON.stringify(errs) : "unknown_error";
            await supabase
              .from("messages")
              .update({ status: "failed", status_updated_at: at, error_detail: detail })
              .eq("id", existing.id);
            await applyCampaignStatus(supabase, existing.id, "failed", detail);
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

          const current = STATUS_RANK[String(existing.status)] ?? -1;
          const incoming = STATUS_RANK[nextStatus];
          if (incoming === undefined || incoming <= current) continue; // never downgrade
          if (existing.status === "failed") continue;

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

          await supabase
            .from("messages")
            .update({ status: nextStatus, status_updated_at: at, ...pricingPatch })
            .eq("id", existing.id);
          await applyCampaignStatus(supabase, existing.id, nextStatus, null);

          // Priced from the rate card, in the database, so a missing rate is a
          // warning and never a guessed number.
          if (nextStatus === "delivered" || nextStatus === "read") {
            const { data: priced, error: priceError } = await supabase.rpc("price_message", {
              p_message_id: existing.id,
            });
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

        }

      }
    }

    await supabase
      .from("webhook_events")
      .update({
        processed_at: new Date().toISOString(),
        error: routedAny ? null : "unknown_phone_number_id",
      })
      .eq("id", eventId);
  } catch (err) {
    await supabase
      .from("webhook_events")
      .update({
        processed_at: new Date().toISOString(),
        error: err instanceof Error ? err.message.slice(0, 500) : "processing_error",
      })
      .eq("id", eventId);
  }
}

/**
 * Catch-up processing: re-run processing for stored events that have a valid
 * signature and were never processed. Used by each incoming webhook (for
 * events older than `olderThanSeconds`) and after a WhatsApp account is
 * connected (with `olderThanSeconds: 0`, so earlier messages get routed).
 */
export async function reprocessUnprocessedEvents(
  supabase: SupabaseClient,
  options: { olderThanSeconds?: number; limit?: number } = {},
): Promise<number> {
  const olderThanSeconds = options.olderThanSeconds ?? 60;
  const limit = options.limit ?? 50;
  const cutoff = new Date(Date.now() - olderThanSeconds * 1000).toISOString();

  const { data: events } = await supabase
    .from("webhook_events")
    .select("id, payload")
    .is("processed_at", null)
    .eq("signature_valid", true)
    .lte("received_at", cutoff)
    .order("received_at", { ascending: true })
    .limit(limit);

  if (!events?.length) return 0;
  for (const event of events) {
    await processWebhookPayload(
      supabase,
      event.id as string,
      (event.payload ?? {}) as AnyRecord,
    );
  }
  return events.length;
}
