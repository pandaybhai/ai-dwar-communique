import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Cash-on-delivery confirmation.
 *
 * A COD order is asked for on WhatsApp before it ships; the customer's answer
 * is recorded on public.cod_confirmations. Nothing here touches Shopify —
 * AiDwar holds read-only scopes, so a cancellation is recorded in AiDwar only
 * and the merchant cancels the order in Shopify themselves.
 */

export type CodStatus = "pending" | "confirmed" | "cancelled" | "no_response";

/** How long we wait for an answer before recording "no response". */
export const COD_NO_RESPONSE_AFTER_HOURS = 24;

type CodRow = {
  id: string;
  organization_id: string;
  order_id: string;
  contact_id: string | null;
  status: CodStatus;
  asked_at: string | null;
};

/** One row per COD order, created the moment the order lands. */
export async function ensureCodConfirmation(
  supabase: SupabaseClient,
  args: { organizationId: string; orderId: string; contactId: string | null },
): Promise<void> {
  const { error } = await supabase.from("cod_confirmations").insert({
    organization_id: args.organizationId,
    order_id: args.orderId,
    contact_id: args.contactId,
    status: "pending",
  });
  // 23505 = the row already exists, which is the normal case on a redelivered
  // Shopify webhook.
  if (error && error.code !== "23505") {
    console.error(
      JSON.stringify({ scope: "cod", stage: "ensure_failed", order_id: args.orderId, error: error.message }),
    );
  }
}

/** True while the customer still owes us an answer for this order. */
export async function codStillPending(
  supabase: SupabaseClient,
  orderId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("cod_confirmations")
    .select("status")
    .eq("order_id", orderId)
    .maybeSingle();
  return (data as { status?: string } | null)?.status === "pending";
}

/**
 * Called after a flow send goes out. When that send belonged to the COD flow,
 * the confirmation row remembers which message asked, so a button reply that
 * quotes it can be matched back.
 */
export async function noteCodAsk(
  supabase: SupabaseClient,
  args: {
    flowKey: string | null;
    triggerType: string;
    triggerId: string | null;
    scheduledSendId: string;
    messageId: string | null;
  },
): Promise<void> {
  if (args.flowKey !== "cod_confirmation") return;
  if (args.triggerType !== "order" || !args.triggerId) return;

  const patch: Record<string, unknown> = {
    asked_at: new Date().toISOString(),
    scheduled_send_id: args.scheduledSendId,
  };
  if (args.messageId) patch["message_id"] = args.messageId;

  await supabase
    .from("cod_confirmations")
    .update(patch)
    .eq("order_id", args.triggerId)
    .eq("status", "pending");
}

/** "Yes, confirm" / "No, cancel" — read from the button title or its payload. */
export function readCodIntent(raw: string | null | undefined): "confirmed" | "cancelled" | null {
  const text = String(raw ?? "").toLowerCase();
  if (!text.trim()) return null;
  if (/\b(no|cancel|don'?t ship|do not ship)\b/.test(text)) return "cancelled";
  if (/\b(yes|confirm|confirmed|ok|okay)\b/.test(text)) return "confirmed";
  return null;
}

async function orderProps(
  supabase: SupabaseClient,
  orderId: string,
): Promise<Record<string, unknown>> {
  const { data } = await supabase
    .from("orders")
    .select("order_number, total, currency, contact_id")
    .eq("id", orderId)
    .maybeSingle();
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    order_id: orderId,
    order_number: row["order_number"] ?? null,
    order_total: row["total"] ?? null,
    currency: row["currency"] ?? null,
  };
}

async function settle(
  supabase: SupabaseClient,
  row: CodRow,
  status: "confirmed" | "cancelled" | "no_response",
  responseRaw: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("cod_confirmations")
    .update({
      status,
      responded_at: new Date().toISOString(),
      ...(responseRaw ? { response_raw: responseRaw.slice(0, 2000) } : {}),
    })
    .eq("id", row.id)
    .eq("status", "pending");
  if (error) {
    console.error(
      JSON.stringify({ scope: "cod", stage: "settle_failed", id: row.id, error: error.message }),
    );
    return;
  }

  // An answer ends the conversation: the reminder must never arrive after it.
  const { cancelScheduledSends } = await import("@/lib/flows.server");
  await cancelScheduledSends(supabase, row.order_id, `cod_${status}`);

  const { emitEvent } = await import("@/lib/events.server");
  await emitEvent(supabase, `cod.${status}`, {
    organizationId: row.organization_id,
    entityType: "order",
    entityId: row.order_id,
    properties: {
      ...(await orderProps(supabase, row.order_id)),
      contact_id: row.contact_id,
      response_raw: responseRaw ?? null,
    },
  });
}

/**
 * Handles one inbound WhatsApp message that might be an answer to a COD ask.
 *
 * Matching goes through the quoted message first (context.id -> our outbound
 * message -> its scheduled send -> the order). When the customer typed instead
 * of tapping, or the quote is missing, the newest pending ask for that contact
 * is used. The raw text is stored either way, so an unexpected answer is never
 * lost.
 */
export async function applyCodReply(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    contactId: string;
    /** wamid of the message the customer replied to, when present. */
    contextMetaId: string | null;
    /** Button title, list title or plain text. */
    body: string | null;
    /** Button payload id, when the reply came from a button. */
    payload: string | null;
  },
): Promise<boolean> {
  const raw = [args.body, args.payload].filter(Boolean).join(" | ") || null;
  if (!raw) return false;

  let row: CodRow | null = null;

  if (args.contextMetaId) {
    const { data: quoted } = await supabase
      .from("messages")
      .select("id, scheduled_send_id")
      .eq("organization_id", args.organizationId)
      .eq("meta_message_id", args.contextMetaId)
      .maybeSingle();
    const sendId = (quoted as { scheduled_send_id?: string | null } | null)?.scheduled_send_id;
    if (sendId) {
      const { data: send } = await supabase
        .from("scheduled_sends")
        .select("trigger_type, trigger_id")
        .eq("id", sendId)
        .maybeSingle();
      const trigger = send as { trigger_type?: string; trigger_id?: string | null } | null;
      if (trigger?.trigger_type === "order" && trigger.trigger_id) {
        const { data } = await supabase
          .from("cod_confirmations")
          .select("id, organization_id, order_id, contact_id, status, asked_at")
          .eq("order_id", trigger.trigger_id)
          .maybeSingle();
        row = (data as CodRow | null) ?? null;
      }
    }
  }

  if (!row) {
    const { data } = await supabase
      .from("cod_confirmations")
      .select("id, organization_id, order_id, contact_id, status, asked_at")
      .eq("organization_id", args.organizationId)
      .eq("contact_id", args.contactId)
      .eq("status", "pending")
      .not("asked_at", "is", null)
      .order("asked_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    row = (data as CodRow | null) ?? null;
  }

  if (!row || row.status !== "pending") return false;

  const intent = readCodIntent(raw);
  if (!intent) {
    // Unrecognised answer: keep it verbatim, leave the ask open.
    await supabase
      .from("cod_confirmations")
      .update({ response_raw: raw.slice(0, 2000) })
      .eq("id", row.id)
      .eq("status", "pending");
    return false;
  }

  await settle(supabase, row, intent, raw);
  return true;
}

/**
 * Sweeps asks that were never answered. Runs on every worker tick, so the
 * 24-hour cut-off needs no separate schedule.
 */
export async function expireCodConfirmations(
  supabase: SupabaseClient,
  limit = 50,
): Promise<number> {
  const cutoff = new Date(Date.now() - COD_NO_RESPONSE_AFTER_HOURS * 3600_000).toISOString();
  const { data } = await supabase
    .from("cod_confirmations")
    .select("id, organization_id, order_id, contact_id, status, asked_at")
    .eq("status", "pending")
    .not("asked_at", "is", null)
    .lt("asked_at", cutoff)
    .limit(limit);

  const rows = (data as CodRow[]) ?? [];
  for (const row of rows) await settle(supabase, row, "no_response", null);
  return rows.length;
}
