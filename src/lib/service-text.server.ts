import type { SupabaseClient } from "@supabase/supabase-js";

type AnyRecord = Record<string, unknown>;

export type ServiceTextResult = {
  ok: boolean;
  messageId: string | null;
  error: string | null;
};

/**
 * Sends a single plain-text message through the organization's connected
 * number. Used for opt-out / opt-in confirmations and automation replies —
 * always a session message, never a template.
 */
export async function sendServiceText(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    phoneNumberId: string;
    conversationId: string;
    to: string;
    body: string;
  },
): Promise<ServiceTextResult> {
  const { data: cred } = await supabase
    .from("whatsapp_credentials")
    .select("access_token")
    .eq("organization_id", args.organizationId)
    .maybeSingle();
  if (!cred?.access_token) return { ok: false, messageId: null, error: "no_credentials" };

  const res = await fetch(
    `https://graph.facebook.com/v25.0/${args.phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cred.access_token}`,
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
