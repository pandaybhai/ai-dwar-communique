import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone, toWaId } from "@/lib/phone";

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
    let routedAny = false;

    for (const entry of entries) {
      for (const change of (entry["changes"] as AnyRecord[] | undefined) ?? []) {
        const value = (change["value"] as AnyRecord | undefined) ?? {};

        // ---- template status updates (routed by WABA id, not phone number) ----
        if (String(change["field"] ?? "") === "message_template_status_update") {
          const wabaId = String(entry["id"] ?? "");
          const { data: wabaAccount } = await supabase
            .from("whatsapp_accounts")
            .select("organization_id")
            .eq("waba_id", wabaId)
            .maybeSingle();
          if (!wabaAccount) continue;
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
            .eq("organization_id", wabaAccount.organization_id as string);

          if (metaTemplateId !== undefined && metaTemplateId !== null) {
            update = update.eq("meta_template_id", String(metaTemplateId));
          } else if (templateName) {
            update = update.eq("name", templateName);
            if (templateLanguage) update = update.eq("language", templateLanguage);
          } else {
            continue;
          }
          await update;
          continue;
        }

        const metadata = (value["metadata"] as AnyRecord | undefined) ?? {};
        const phoneNumberId = metadata["phone_number_id"] as string | undefined;
        if (!phoneNumberId) continue;

        const { data: account } = await supabase
          .from("whatsapp_accounts")
          .select("id, organization_id")
          .eq("phone_number_id", phoneNumberId)
          .maybeSingle();

        if (!account) continue;
        routedAny = true;
        const orgId = account.organization_id as string;
        const accountId = account.id as string;

        // ---- inbound messages ----
        const contactsMeta = (value["contacts"] as AnyRecord[] | undefined) ?? [];
        for (const msg of (value["messages"] as AnyRecord[] | undefined) ?? []) {
          const waId = toWaId(msg["from"] as string | undefined);
          if (!waId) continue;
          const profile = contactsMeta.find((c) => c["wa_id"] === waId);
          const profileName =
            ((profile?.["profile"] as AnyRecord | undefined)?.["name"] as string | undefined) ??
            null;

          const { data: contact } = await supabase
            .from("contacts")
            .upsert(
              {
                organization_id: orgId,
                phone: normalizePhone(waId),
                wa_id: waId,
                ...(profileName ? { name: profileName } : {}),
                updated_at: new Date().toISOString(),
              },
              { onConflict: "organization_id,phone" },
            )
            .select("id")
            .single();
          if (!contact) continue;

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
          }
          if (!conversation) continue;

          const { type, body } = messageBody(msg);
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
          }

        }

        // ---- status updates ----
        for (const st of (value["statuses"] as AnyRecord[] | undefined) ?? []) {
          const metaId = st["id"] as string | undefined;
          const nextStatus = String(st["status"] ?? "");
          if (!metaId || !nextStatus) continue;

          const { data: existing } = await supabase
            .from("messages")
            .select("id, status")
            .eq("meta_message_id", metaId)
            .eq("organization_id", orgId)
            .maybeSingle();
          if (!existing) continue;

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
            continue;
          }

          const current = STATUS_RANK[String(existing.status)] ?? -1;
          const incoming = STATUS_RANK[nextStatus];
          if (incoming === undefined || incoming <= current) continue; // never downgrade
          if (existing.status === "failed") continue;

          await supabase
            .from("messages")
            .update({ status: nextStatus, status_updated_at: at })
            .eq("id", existing.id);
          await applyCampaignStatus(supabase, existing.id, nextStatus, null);
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
