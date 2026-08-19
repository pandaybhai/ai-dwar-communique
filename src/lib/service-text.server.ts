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
