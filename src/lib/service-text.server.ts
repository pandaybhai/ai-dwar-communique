import type { SupabaseClient } from "@supabase/supabase-js";
import { isServiceWindowOpen } from "@/lib/service-window";

type AnyRecord = Record<string, unknown>;

export type ServiceTextResult = {
  ok: boolean;
  messageId: string | null;
  error: string | null;
};

/**
 * Sends a single plain-text message through one specific connected number.
 * Used for opt-out / opt-in confirmations and automation replies — always a
 * session message, never a template. The caller resolves the number and its
 * token through getWhatsAppConnection, so this never guesses which number to
 * reply from.
 */
export async function sendServiceText(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    phoneNumberId: string;
    accessToken: string;
    conversationId: string;
    to: string;
    body: string;
    /** Stored on the message row, e.g. { kind: "stranger_greeting" }. */
    metadata?: Record<string, unknown>;
  },
): Promise<ServiceTextResult> {
  if (!args.accessToken) return { ok: false, messageId: null, error: "no_credentials" };

  // Free-form messages are only allowed inside the 24-hour service window.
  const { data: conversation } = await supabase
    .from("conversations")
    .select("last_customer_message_at")
    .eq("id", args.conversationId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (!isServiceWindowOpen(conversation)) {
    return { ok: false, messageId: null, error: "service_window_closed" };
  }


  const res = await fetch(
    `https://graph.facebook.com/v25.0/${args.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: args.to,
        type: "text",
        text: { body: args.body },
      }),
    },
  );

  let json: AnyRecord = {};
  try {
    json = (await res.json()) as AnyRecord;
  } catch {
    json = {};
  }
  const metaMessageId =
    ((json["messages"] as Array<AnyRecord> | undefined)?.[0]?.["id"] as string) ?? null;
  const nowIso = new Date().toISOString();

  const { data: inserted } = await supabase
    .from("messages")
    .insert({
      organization_id: args.organizationId,
      conversation_id: args.conversationId,
      meta_message_id: metaMessageId,
      direction: "outbound",
      type: "text",
      body: args.body,
      ...(args.metadata ? { metadata: args.metadata } : {}),
      status: res.ok ? "pending" : "failed",
      status_updated_at: nowIso,
      ...(res.ok ? {} : { error_detail: JSON.stringify(json).slice(0, 300) }),
    })
    .select("id")
    .maybeSingle();

  await supabase
    .from("conversations")
    .update({ last_message_at: nowIso })
    .eq("id", args.conversationId);

  return {
    ok: res.ok,
    messageId: (inserted?.id as string | undefined) ?? null,
    error: res.ok ? null : JSON.stringify(json).slice(0, 300),
  };
}

/**
 * Sends one message with up to three tap-to-reply buttons, and optionally a
 * picture above the words. Same 24-hour rule as any other session message: a
 * button message is still free-form, not a template.
 */
export async function sendServiceButtons(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    phoneNumberId: string;
    accessToken: string;
    conversationId: string;
    to: string;
    body: string;
    buttons: Array<{ id: string; title: string }>;
    imageUrl?: string | null;
  },
): Promise<ServiceTextResult> {
  if (!args.accessToken) return { ok: false, messageId: null, error: "no_credentials" };

  const buttons = args.buttons.slice(0, 3);
  for (const button of buttons) {
    if (button.title.length > 20) {
      throw new Error(`Button title too long for WhatsApp (max 20): "${button.title}"`);
    }
  }

  const { data: conversation } = await supabase
    .from("conversations")
    .select("last_customer_message_at")
    .eq("id", args.conversationId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (!isServiceWindowOpen(conversation)) {
    return { ok: false, messageId: null, error: "service_window_closed" };
  }

  const res = await fetch(`https://graph.facebook.com/v25.0/${args.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: args.to,
      type: "interactive",
      interactive: {
        type: "button",
        ...(args.imageUrl
          ? { header: { type: "image", image: { link: args.imageUrl } } }
          : {}),
        body: { text: args.body },
        action: {
          buttons: buttons.map((b) => ({
            type: "reply",
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    }),
  });

  let json: AnyRecord = {};
  try {
    json = (await res.json()) as AnyRecord;
  } catch {
    json = {};
  }
  const metaMessageId =
    ((json["messages"] as Array<AnyRecord> | undefined)?.[0]?.["id"] as string) ?? null;
  const nowIso = new Date().toISOString();
  const recordedBody = `${args.body} [buttons: ${buttons.map((b) => b.title).join(", ")}]`;

  const { data: inserted } = await supabase
    .from("messages")
    .insert({
      organization_id: args.organizationId,
      conversation_id: args.conversationId,
      meta_message_id: metaMessageId,
      direction: "outbound",
      type: args.imageUrl ? "image" : "text",
      body: recordedBody,
      ...(args.imageUrl ? { media_url: args.imageUrl, media_mime: "image" } : {}),
      status: res.ok ? "pending" : "failed",
      status_updated_at: nowIso,
      ...(res.ok ? {} : { error_detail: JSON.stringify(json).slice(0, 300) }),
    })
    .select("id")
    .maybeSingle();

  await supabase
    .from("conversations")
    .update({ last_message_at: nowIso })
    .eq("id", args.conversationId);

  return {
    ok: res.ok,
    messageId: (inserted?.id as string | undefined) ?? null,
    error: res.ok ? null : JSON.stringify(json).slice(0, 300),
  };
}


/**
 * Sends one product picture as a session image message, with the product name
 * (and price, when we have one) as the caption. Used when the AI answers a
 * catalogue question — a picture says more than a line of text.
 */
export async function sendServiceImage(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    phoneNumberId: string;
    accessToken: string;
    conversationId: string;
    to: string;
    imageUrl: string;
    caption: string;
  },
): Promise<ServiceTextResult> {
  if (!args.accessToken) return { ok: false, messageId: null, error: "no_credentials" };

  // Free-form messages are only allowed inside the 24-hour service window.
  const { data: conversation } = await supabase
    .from("conversations")
    .select("last_customer_message_at")
    .eq("id", args.conversationId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (!isServiceWindowOpen(conversation)) {
    return { ok: false, messageId: null, error: "service_window_closed" };
  }

  const res = await fetch(`https://graph.facebook.com/v25.0/${args.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: args.to,
      type: "image",
      image: { link: args.imageUrl, caption: args.caption.slice(0, 1024) },
    }),
  });

  let json: AnyRecord = {};
  try {
    json = (await res.json()) as AnyRecord;
  } catch {
    json = {};
  }
  const metaMessageId =
    ((json["messages"] as Array<AnyRecord> | undefined)?.[0]?.["id"] as string) ?? null;
  const nowIso = new Date().toISOString();

  const { data: inserted } = await supabase
    .from("messages")
    .insert({
      organization_id: args.organizationId,
      conversation_id: args.conversationId,
      meta_message_id: metaMessageId,
      direction: "outbound",
      type: "image",
      body: args.caption,
      media_url: args.imageUrl,
      media_mime: "image",
      status: res.ok ? "pending" : "failed",
      status_updated_at: nowIso,
      ...(res.ok ? {} : { error_detail: JSON.stringify(json).slice(0, 300) }),
    })
    .select("id")
    .maybeSingle();

  await supabase
    .from("conversations")
    .update({ last_message_at: nowIso })
    .eq("id", args.conversationId);

  return {
    ok: res.ok,
    messageId: (inserted?.id as string | undefined) ?? null,
    error: res.ok ? null : JSON.stringify(json).slice(0, 300),
  };
}

/**
 * Sends one PDF as a session document message — used for an invoice inside the
 * 24-hour window, where the merchant gets the document itself instead of a
 * link to go and fetch it.
 */
export async function sendServiceDocument(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    phoneNumberId: string;
    accessToken: string;
    conversationId: string;
    to: string;
    documentUrl: string;
    fileName: string;
    caption: string;
  },
): Promise<ServiceTextResult> {
  if (!args.accessToken) return { ok: false, messageId: null, error: "no_credentials" };

  const { data: conversation } = await supabase
    .from("conversations")
    .select("last_customer_message_at")
    .eq("id", args.conversationId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (!isServiceWindowOpen(conversation)) {
    return { ok: false, messageId: null, error: "service_window_closed" };
  }

  const res = await fetch(`https://graph.facebook.com/v25.0/${args.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: args.to,
      type: "document",
      document: {
        link: args.documentUrl,
        filename: args.fileName,
        caption: args.caption.slice(0, 1024),
      },
    }),
  });

  let json: AnyRecord = {};
  try {
    json = (await res.json()) as AnyRecord;
  } catch {
    json = {};
  }
  const metaMessageId =
    ((json["messages"] as Array<AnyRecord> | undefined)?.[0]?.["id"] as string) ?? null;
  const nowIso = new Date().toISOString();

  const { data: inserted } = await supabase
    .from("messages")
    .insert({
      organization_id: args.organizationId,
      conversation_id: args.conversationId,
      meta_message_id: metaMessageId,
      direction: "outbound",
      type: "document",
      body: args.caption,
      media_url: args.documentUrl,
      media_mime: "application/pdf",
      status: res.ok ? "pending" : "failed",
      status_updated_at: nowIso,
      ...(res.ok ? {} : { error_detail: JSON.stringify(json).slice(0, 300) }),
    })
    .select("id")
    .maybeSingle();

  await supabase
    .from("conversations")
    .update({ last_message_at: nowIso })
    .eq("id", args.conversationId);

  return {
    ok: res.ok,
    messageId: (inserted?.id as string | undefined) ?? null,
    error: res.ok ? null : JSON.stringify(json).slice(0, 300),
  };
}

/**
 * Sends one message with a tap-to-choose list — used when the owner has more
 * than one question waiting for an answer, or more than one business. Same
 * 24-hour rule as any other session message.
 */
export async function sendServiceList(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    phoneNumberId: string;
    accessToken: string;
    conversationId: string;
    to: string;
    body: string;
    buttonText: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  },
): Promise<ServiceTextResult> {
  if (!args.accessToken) return { ok: false, messageId: null, error: "no_credentials" };

  const rows = args.rows.slice(0, 10).map((r) => ({
    id: r.id,
    title: r.title.slice(0, 24),
    ...(r.description ? { description: r.description.slice(0, 72) } : {}),
  }));
  if (rows.length === 0) return { ok: false, messageId: null, error: "no_rows" };

  const { data: conversation } = await supabase
    .from("conversations")
    .select("last_customer_message_at")
    .eq("id", args.conversationId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (!isServiceWindowOpen(conversation)) {
    return { ok: false, messageId: null, error: "service_window_closed" };
  }

  const res = await fetch(`https://graph.facebook.com/v25.0/${args.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: args.to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: args.body },
        action: {
          button: args.buttonText.slice(0, 20),
          sections: [{ title: "Choose one", rows }],
        },
      },
    }),
  });

  let json: AnyRecord = {};
  try {
    json = (await res.json()) as AnyRecord;
  } catch {
    json = {};
  }
  const metaMessageId =
    ((json["messages"] as Array<AnyRecord> | undefined)?.[0]?.["id"] as string) ?? null;
  const nowIso = new Date().toISOString();

  const { data: inserted } = await supabase
    .from("messages")
    .insert({
      organization_id: args.organizationId,
      conversation_id: args.conversationId,
      meta_message_id: metaMessageId,
      direction: "outbound",
      type: "text",
      body: `${args.body} [list: ${rows.map((r) => r.title).join(", ")}]`,
      status: res.ok ? "pending" : "failed",
      status_updated_at: nowIso,
      ...(res.ok ? {} : { error_detail: JSON.stringify(json).slice(0, 300) }),
    })
    .select("id")
    .maybeSingle();

  await supabase
    .from("conversations")
    .update({ last_message_at: nowIso })
    .eq("id", args.conversationId);

  return {
    ok: res.ok,
    messageId: (inserted?.id as string | undefined) ?? null,
    error: res.ok ? null : JSON.stringify(json).slice(0, 300),
  };
}

/**
 * Sends products straight from the connected number's WhatsApp catalogue:
 * one product card when there is a single match, otherwise a product list
 * grouped into sections. Only used when the catalogue is live and the items
 * are actually in it — otherwise the caller falls back to plain pictures.
 */
export async function sendServiceProducts(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    phoneNumberId: string;
    accessToken: string;
    conversationId: string;
    to: string;
    catalogId: string;
    header: string;
    body: string;
    items: Array<{ retailerId: string; section: string; title: string }>;
  },
): Promise<ServiceTextResult> {
  if (!args.accessToken) return { ok: false, messageId: null, error: "no_credentials" };
  const items = args.items.slice(0, 30);
  if (items.length === 0) return { ok: false, messageId: null, error: "no_items" };

  const { data: conversation } = await supabase
    .from("conversations")
    .select("last_customer_message_at")
    .eq("id", args.conversationId)
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (!isServiceWindowOpen(conversation)) {
    return { ok: false, messageId: null, error: "service_window_closed" };
  }

  let interactive: AnyRecord;
  if (items.length === 1) {
    interactive = {
      type: "product",
      body: { text: args.body.slice(0, 1024) },
      action: {
        catalog_id: args.catalogId,
        product_retailer_id: items[0]!.retailerId,
      },
    };
  } else {
    // Meta allows up to 10 sections; anything past that joins the last one.
    const order: string[] = [];
    const grouped = new Map<string, Array<{ retailerId: string }>>();
    for (const item of items) {
      const key = (item.section || "Products").slice(0, 24);
      if (!grouped.has(key)) {
        grouped.set(key, []);
        order.push(key);
      }
      grouped.get(key)!.push({ retailerId: item.retailerId });
    }
    const sections = order.slice(0, 10).map((title) => ({
      title,
      product_items: (grouped.get(title) ?? []).map((p) => ({
        product_retailer_id: p.retailerId,
      })),
    }));
    interactive = {
      type: "product_list",
      header: { type: "text", text: args.header.slice(0, 60) },
      body: { text: args.body.slice(0, 1024) },
      action: { catalog_id: args.catalogId, sections },
    };
  }

  const res = await fetch(`https://graph.facebook.com/v25.0/${args.phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: args.to,
      type: "interactive",
      interactive,
    }),
  });

  let json: AnyRecord = {};
  try {
    json = (await res.json()) as AnyRecord;
  } catch {
    json = {};
  }
  const metaMessageId =
    ((json["messages"] as Array<AnyRecord> | undefined)?.[0]?.["id"] as string) ?? null;
  const nowIso = new Date().toISOString();

  const { data: inserted } = await supabase
    .from("messages")
    .insert({
      organization_id: args.organizationId,
      conversation_id: args.conversationId,
      meta_message_id: metaMessageId,
      direction: "outbound",
      type: "text",
      body: `${args.body} [catalogue: ${items.map((i) => i.title).join(", ")}]`,
      status: res.ok ? "pending" : "failed",
      status_updated_at: nowIso,
      ...(res.ok ? {} : { error_detail: JSON.stringify(json).slice(0, 300) }),
    })
    .select("id")
    .maybeSingle();

  await supabase
    .from("conversations")
    .update({ last_message_at: nowIso })
    .eq("id", args.conversationId);

  return {
    ok: res.ok,
    messageId: (inserted?.id as string | undefined) ?? null,
    error: res.ok ? null : JSON.stringify(json).slice(0, 300),
  };
}
