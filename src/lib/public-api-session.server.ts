import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiCaller, ApiReply } from "@/lib/public-api.server";
import { parseMediaInput, mediaFingerprint, type MediaInput } from "@/lib/public-api-media.server";
import { SEND_PATH, SESSION_PATH } from "@/lib/public-api";

/**
 * Batch 37 item 2: POST /api/v1/messages/session — a free-form message to a
 * customer inside their 24-hour window: text (WhatsApp's *bold* _italic_
 * ~strike~ ```mono``` as written), an image / video / audio file / document,
 * up to three reply buttons, or a list.
 *
 * Nothing here is a second sender: the message leaves through the session
 * senders every automatic reply uses (sendServiceText / sendServiceButtons /
 * sendServiceList / sendServiceMedia in service-text.server.ts), from the
 * number the customer last wrote to, and is an ordinary messages row carrying
 * metadata.source "api" — so its statuses reach the merchant's webhook like
 * an API template's. Charged as an inbox reply is: a locked or paused
 * workspace sends nothing (402); otherwise there is no credit check, the
 * "service" meter and message.sent are recorded as the inbox records them,
 * and the wallet is debited, if Meta prices it at all, by the same database
 * trigger on delivery. Outside the window it is 409 window_closed: send a
 * template instead. Idempotent with the same reservation as the template send.
 *
 * Never logs a key, a message's words or a file.
 */

const MAX_TEXT = 4096;
const MAX_INTERACTIVE_BODY = 1024;
const MAX_LIST_BODY = 4096;

type Fail = ApiReply;
const fail = (status: number, code: string, error: string): Fail => ({
  status,
  body: { error, code },
});

type Row = { id: string; title: string; description?: string };

export type SessionRequest = {
  to: string;
  idempotencyKey: string | null;
} & (
  | { type: "text"; text: string; previewUrl: boolean }
  | { type: "image" | "video" | "audio" | "document"; media: MediaInput }
  | { type: "buttons"; body: string; buttons: Array<{ id: string; title: string }> }
  | {
      type: "list";
      body: string;
      button: string;
      sections: Array<{ title: string; rows: Row[] }>;
    }
);

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** The request body, checked for shape. Never reads anything else. */
export function parseSessionRequest(raw: unknown, headerKey: string | null): SessionRequest | Fail {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail(400, "invalid_json", "The request body must be a JSON object.");
  const body = raw as Record<string, unknown>;
  const to = str(body["to"]).trim();
  if (!to)
    return fail(
      400,
      "invalid_to",
      "`to` is required: the customer's WhatsApp number with its country code.",
    );

  const keyRaw = body["idempotency_key"] ?? headerKey;
  let idempotencyKey: string | null = null;
  if (keyRaw !== undefined && keyRaw !== null && keyRaw !== "") {
    if (typeof keyRaw !== "string" || !/^[A-Za-z0-9_\-.:]{1,255}$/.test(keyRaw)) {
      return fail(
        400,
        "invalid_idempotency_key",
        "`idempotency_key` must be 1–255 letters, digits or _ - . :",
      );
    }
    idempotencyKey = keyRaw;
  }

  const type = str(body["type"]).toLowerCase();
  const base = { to, idempotencyKey };
  const bad = (error: string) => fail(400, "invalid_message", error);

  if (type === "text") {
    const text = str(body["text"]);
    if (!text.trim()) return bad("`text` is required: the message's words.");
    if (text.length > MAX_TEXT) return bad(`\`text\` is longer than ${MAX_TEXT} characters.`);
    return { ...base, type, text, previewUrl: body["preview_url"] === true };
  }

  if (type === "image" || type === "video" || type === "audio" || type === "document") {
    const media = parseMediaInput(body[type], {
      kind: type,
      field: type,
      invalid: type === "document" ? "invalid_document" : "invalid_media",
      required: `\`${type}\` is required: { url } (https) or { base64 }.`,
    });
    if ("status" in media) return media;
    if (type === "audio" && media.caption)
      return bad("WhatsApp doesn't show a caption on an audio file: leave `audio.caption` out.");
    return { ...base, type, media };
  }

  if (type === "buttons") {
    const text = str(body["body"]).trim();
    if (!text) return bad("`body` is required: the words above the buttons.");
    if (text.length > MAX_INTERACTIVE_BODY)
      return bad(`\`body\` is longer than ${MAX_INTERACTIVE_BODY} characters.`);
    const list = body["buttons"];
    if (!Array.isArray(list) || list.length < 1 || list.length > 3)
      return bad("`buttons` must hold 1 to 3 reply buttons.");
    const buttons: Array<{ id: string; title: string }> = [];
    for (const [i, b] of list.entries()) {
      const id = str((b as Record<string, unknown> | null)?.["id"]).trim();
      const title = str((b as Record<string, unknown> | null)?.["title"]).trim();
      if (!id || id.length > 256) return bad(`buttons[${i}].id must be 1–256 characters.`);
      if (!title || title.length > 20) return bad(`buttons[${i}].title must be 1–20 characters.`);
      if (buttons.some((x) => x.id === id)) return bad(`buttons[${i}].id "${id}" is used twice.`);
      if (buttons.some((x) => x.title === title))
        return bad(`buttons[${i}].title "${title}" is used twice.`);
      buttons.push({ id, title });
    }
    return { ...base, type, body: text, buttons };
  }

  if (type === "list") {
    const text = str(body["body"]).trim();
    if (!text) return bad("`body` is required: the words above the list.");
    if (text.length > MAX_LIST_BODY)
      return bad(`\`body\` is longer than ${MAX_LIST_BODY} characters.`);
    const button = str(body["button"]).trim();
    if (!button || button.length > 20)
      return bad('`button` (the list\'s button, e.g. "Choose") must be 1–20 characters.');
    const rawSections = body["sections"];
    if (!Array.isArray(rawSections) || rawSections.length < 1 || rawSections.length > 10)
      return bad("`sections` must hold 1 to 10 sections.");
    const sections: Array<{ title: string; rows: Row[] }> = [];
    const ids = new Set<string>();
    let total = 0;
    for (const [s, sec] of rawSections.entries()) {
      const record = (sec ?? {}) as Record<string, unknown>;
      const title = str(record["title"]).trim();
      if (title.length > 24) return bad(`sections[${s}].title is longer than 24 characters.`);
      if (!title && rawSections.length > 1)
        return bad(`sections[${s}].title is required when there is more than one section.`);
      const rawRows = record["rows"];
      if (!Array.isArray(rawRows) || rawRows.length < 1)
        return bad(`sections[${s}].rows must hold at least one row.`);
      const rows: Row[] = [];
      for (const [r, row] of rawRows.entries()) {
        const rec = (row ?? {}) as Record<string, unknown>;
        const id = str(rec["id"]).trim();
        const rowTitle = str(rec["title"]).trim();
        const description = str(rec["description"]).trim();
        const at = `sections[${s}].rows[${r}]`;
        if (!id || id.length > 200) return bad(`${at}.id must be 1–200 characters.`);
        if (ids.has(id)) return bad(`${at}.id "${id}" is used twice.`);
        if (!rowTitle || rowTitle.length > 24) return bad(`${at}.title must be 1–24 characters.`);
        if (description.length > 72) return bad(`${at}.description is longer than 72 characters.`);
        ids.add(id);
        rows.push({ id, title: rowTitle, ...(description ? { description } : {}) });
      }
      total += rows.length;
      sections.push({ title, rows });
    }
    if (total > 10) return bad("A list holds at most 10 rows in all.");
    return { ...base, type, body: text, button, sections };
  }

  return bad("`type` must be one of: text, image, video, audio, document, buttons, list.");
}

/** What the reservation fingerprints: every field the message is made of. */
function fingerprintFields(parsed: SessionRequest, waId: string): Record<string, unknown> {
  const { idempotencyKey: _key, to: _to, ...rest } = parsed;
  if ("media" in rest) return { to: waId, type: rest.type, media: mediaFingerprint(rest.media) };
  return { ...rest, to: waId };
}

export function windowClosed(): Fail {
  return fail(
    409,
    "window_closed",
    `The customer hasn't written to you in the last 24 hours, so a free-form message can't be sent. Send a template instead (POST ${SEND_PATH}). Nothing was sent.`,
  );
}

type Conversation = {
  id: string;
  whatsapp_account_id: string | null;
  last_customer_message_at: string | null;
};

/**
 * The thread the customer last wrote in, on any of the workspace's numbers,
 * when that was within 24 hours (a reply always leaves on the number the
 * customer wrote to). Null: no contact, no thread, or the window is shut.
 */
export async function openWindowFor(
  supabase: SupabaseClient,
  organizationId: string,
  phone: string,
): Promise<{ contactId: string; conversation: Conversation } | null | "error"> {
  const { isServiceWindowOpen } = await import("@/lib/service-window");
  const { data: contact, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("phone", phone)
    .maybeSingle();
  if (error) return "error";
  const contactId = (contact as { id?: string } | null)?.id;
  if (!contactId) return null;
  const { data: threads, error: threadError } = await supabase
    .from("conversations")
    .select("id, whatsapp_account_id, last_customer_message_at")
    .eq("organization_id", organizationId)
    .eq("contact_id", contactId)
    // The window is WhatsApp's, per number: a chat closed in the Inbox still has it.
    .not("last_customer_message_at", "is", null)
    .order("last_customer_message_at", { ascending: false, nullsFirst: false })
    .limit(10);
  if (threadError) return "error";
  const latest = ((threads ?? []) as Conversation[])
    .filter((t) => t.last_customer_message_at)
    .sort(
      (a, b) => Date.parse(b.last_customer_message_at!) - Date.parse(a.last_customer_message_at!),
    )[0];
  if (!latest || !isServiceWindowOpen(latest)) return null;
  return { contactId, conversation: latest };
}

/**
 * The whole send, for one authenticated caller (the route checked the key,
 * the flag and the rate limit). `raw` is the parsed JSON body.
 */
export async function sendSessionViaApi(
  supabase: SupabaseClient,
  caller: ApiCaller,
  raw: unknown,
  options: { idempotencyHeader?: string | null } = {},
): Promise<ApiReply> {
  const parsed = parseSessionRequest(raw, options.idempotencyHeader ?? null);
  if ("status" in parsed) return parsed;
  const orgId = caller.organizationId;
  const { normalizePhone, toWaId, logServerActivity } = await import("@/lib/whatsapp-api.server");
  const phone = normalizePhone(parsed.to);
  const waId = toWaId(phone);
  if (waId.length < 8 || waId.length > 15) {
    return fail(
      400,
      "invalid_to",
      "`to` isn't a valid WhatsApp number. Include the country code, e.g. +919812345678.",
    );
  }

  const lib = await import("@/lib/public-api.server");
  let requestId: string | null = null;
  if (parsed.idempotencyKey) {
    const reserved = await lib.reserveIdempotency(supabase, caller, {
      key: parsed.idempotencyKey,
      requestHash: lib.requestFingerprint({
        path: SESSION_PATH,
        ...fingerprintFields(parsed, waId),
      }),
    });
    if ("status" in reserved) return reserved;
    requestId = reserved.id;
  }
  const refuse = async (answer: Fail): Promise<Fail> => {
    if (requestId) await lib.releaseIdempotency(supabase, requestId);
    return answer;
  };
  let sendStarted = false;
  try {
    // A locked or paused workspace spends nothing until a plan is chosen (as the inbox).
    const { data: org } = await supabase
      .from("organizations")
      .select("plan_status")
      .eq("id", orgId)
      .maybeSingle();
    const planStatus = (org as { plan_status?: string | null } | null)?.plan_status ?? null;
    if (planStatus === "locked" || planStatus === "paused") {
      return refuse(
        fail(
          402,
          "workspace_locked",
          "This workspace is locked — choose a plan in AiDwar to send again.",
        ),
      );
    }

    const open = await openWindowFor(supabase, orgId, phone);
    if (open === "error")
      return refuse(
        fail(
          503,
          "unavailable",
          "We couldn't read this customer's conversation. Please try again.",
        ),
      );
    if (!open) return refuse(windowClosed());

    const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
    const { connection, error: connectionError } = await getWhatsAppConnection(
      supabase,
      orgId,
      open.conversation.whatsapp_account_id,
    );
    if (!connection)
      return refuse(
        fail(
          400,
          "no_whatsapp_number",
          connectionError ?? "Connect a WhatsApp number in AiDwar first.",
        ),
      );

    // ---- a file: read, then Meta's copy of it, by media id ----
    let file: import("@/lib/public-api-media.server").MediaFile | null = null;
    let mediaId: string | null = null;
    if ("media" in parsed) {
      const { readMediaFile } = await import("@/lib/public-api-media.server");
      const read = await readMediaFile(parsed.media);
      if ("status" in read) return refuse(read);
      file = read;
      const { uploadMessageMedia } = await import("@/lib/whatsapp-api.server");
      const uploaded = await uploadMessageMedia(connection.phoneNumberId, connection.accessToken, {
        bytes: file.bytes,
        mime: file.mime,
        filename: file.filename,
      });
      if (!uploaded.ok) {
        return refuse(
          fail(
            502,
            "whatsapp_upload_failed",
            `WhatsApp didn't accept the ${parsed.type}: ${uploaded.error} Nothing was sent.`,
          ),
        );
      }
      mediaId = uploaded.id;
    }

    const metadata = {
      // "api_console" for the Try-it console (Batch 38).
      source: caller.source ?? "api",
      api_key_id: caller.keyId,
      idempotency_key: parsed.idempotencyKey,
      ...(requestId ? { api_request_id: requestId } : {}),
      to: phone,
    };
    const common = {
      organizationId: orgId,
      phoneNumberId: connection.phoneNumberId,
      accessToken: connection.accessToken,
      conversationId: open.conversation.id,
      to: waId,
      metadata,
    };
    const senders = await import("@/lib/service-text.server");
    sendStarted = true;
    let result: import("@/lib/service-text.server").ServiceTextResult;
    if (parsed.type === "text") {
      result = await senders.sendServiceText(supabase, {
        ...common,
        body: parsed.text,
        previewUrl: parsed.previewUrl,
      });
    } else if (parsed.type === "buttons") {
      result = await senders.sendServiceButtons(supabase, {
        ...common,
        body: parsed.body,
        buttons: parsed.buttons,
      });
    } else if (parsed.type === "list") {
      result = await senders.sendServiceList(supabase, {
        ...common,
        body: parsed.body,
        buttonText: parsed.button,
        rows: [],
        sections: parsed.sections,
      });
    } else {
      result = await senders.sendServiceMedia(supabase, {
        ...common,
        kind: parsed.type,
        mediaId: mediaId!,
        mime: file!.mime,
        caption: parsed.media.caption,
        filename: file!.filename,
      });
    }

    // The window shut between our read and the send: nothing left.
    if (!result.ok && result.error === "service_window_closed") {
      sendStarted = false;
      return refuse(windowClosed());
    }

    const messageId = result.messageId;
    let wamid: string | null = null;
    if (messageId && file) {
      const { keepMediaCopy } = await import("@/lib/public-api-media.server");
      ({ wamid } = await keepMediaCopy(supabase, {
        organizationId: orgId,
        messageId,
        bytes: file.bytes,
        mime: file.mime,
      }));
    } else if (messageId) {
      const { data: row } = await supabase
        .from("messages")
        .select("meta_message_id")
        .eq("id", messageId)
        .maybeSingle();
      wamid = (row as { meta_message_id?: string | null } | null)?.meta_message_id ?? null;
    }

    // Recorded as an inbox reply is: the event and the "service" meter.
    const { emitEvent, recordUsage } = await import("@/lib/events.server");
    const { meterForMessageCategory } = await import("@/lib/events");
    const { outboundMessageDimensions } = await import("@/lib/message-events");
    const dimensions = outboundMessageDimensions({
      messageId,
      conversationId: open.conversation.id,
      contactId: open.contactId,
      wabaId: connection.wabaId,
      whatsappAccountId: connection.accountId,
      templateName: null,
      messageType: parsed.type,
      billingCategory: "service",
    });

    if (!result.ok) {
      await emitEvent(supabase, "message.failed", {
        organizationId: orgId,
        whatsappAccountId: connection.accountId,
        entityType: "message",
        entityId: messageId,
        properties: dimensions,
      });
      if (messageId) {
        const { enqueueApiWebhookEvent } = await import("@/lib/public-api-webhooks.server");
        await enqueueApiWebhookEvent(supabase, {
          organizationId: orgId,
          messageId,
          event: "message.failed",
          occurredAt: new Date().toISOString(),
          metadata,
          error: result.error,
        });
      }
      const answer: Fail = {
        status: 502,
        body: {
          error: "WhatsApp rejected the message.",
          code: "whatsapp_rejected",
          message_id: messageId,
          status: "failed",
        },
      };
      if (requestId) await lib.finishIdempotency(supabase, requestId, { ...answer, messageId });
      return answer;
    }

    await emitEvent(supabase, "message.sent", {
      organizationId: orgId,
      whatsappAccountId: connection.accountId,
      entityType: "message",
      entityId: messageId,
      properties: dimensions,
    });
    await recordUsage(supabase, meterForMessageCategory("service"), {
      organizationId: orgId,
      quantity: 1,
      metadata: {
        whatsapp_account_id: connection.accountId,
        waba_id: connection.wabaId,
        conversation_id: open.conversation.id,
        contact_id: open.contactId,
        message_id: messageId,
        message_type: parsed.type,
        billing_category: "service",
        source: caller.source ?? "api",
      },
    });
    await logServerActivity(supabase, orgId, null, "message_sent", {
      message_type: parsed.type,
      source: caller.source ?? "api",
      api_key_id: caller.keyId,
      whatsapp_account_id: connection.accountId,
    });

    const answer: Fail = {
      status: 202,
      body: {
        message_id: messageId,
        status: "queued",
        wamid,
        idempotency_key: parsed.idempotencyKey,
      },
    };
    if (requestId) await lib.finishIdempotency(supabase, requestId, { ...answer, messageId });
    return answer;
  } catch (error) {
    if (requestId && !sendStarted) await lib.releaseIdempotency(supabase, requestId);
    throw error;
  }
}
