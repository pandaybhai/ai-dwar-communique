import type { SupabaseClient } from "@supabase/supabase-js";
import { logServerActivity } from "@/lib/whatsapp-api.server";
import { sendServiceText } from "@/lib/service-text.server";

type AnyRecord = Record<string, unknown>;

type OrderItem = {
  product_retailer_id: string;
  quantity: number;
  item_price: number;
  currency: string;
};

function readItems(order: AnyRecord): OrderItem[] {
  const raw = order["product_items"];
  if (!Array.isArray(raw)) return [];
  const items: OrderItem[] = [];
  for (const entry of raw as AnyRecord[]) {
    const retailerId =
      typeof entry["product_retailer_id"] === "string" ? entry["product_retailer_id"] : "";
    if (!retailerId) continue;
    items.push({
      product_retailer_id: retailerId,
      quantity: Number(entry["quantity"] ?? 1) || 1,
      item_price: Number(entry["item_price"] ?? 0) || 0,
      currency: typeof entry["currency"] === "string" ? entry["currency"] : "INR",
    });
  }
  return items;
}

function money(total: number, currency: string): string {
  const rounded = Number.isInteger(total) ? String(total) : total.toFixed(2);
  return currency.toUpperCase() === "INR" ? `₹${rounded}` : `${rounded} ${currency.toUpperCase()}`;
}

/**
 * A customer sent a cart from the WhatsApp catalogue. We record the order,
 * put the conversation in front of a human and acknowledge it ourselves —
 * the AI employee never answers an order message.
 */
export async function handleCatalogOrder(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    contactId: string | null;
    metaMessageId: string;
    order: AnyRecord;
    phoneNumberId: string;
    accessToken: string;
    to: string;
  },
): Promise<{ handled: boolean }> {
  const items = readItems(args.order);
  if (items.length === 0) return { handled: false };

  const currency = items[0]!.currency || "INR";
  const total = items.reduce((sum, i) => sum + i.item_price * i.quantity, 0);
  const externalId = `wa:${args.metaMessageId}`;

  // Same message twice (Meta retries) must not create a second order.
  const { data: existing } = await supabase
    .from("orders")
    .select("id")
    .eq("organization_id", args.organizationId)
    .eq("external_id", externalId)
    .maybeSingle();

  let orderId = (existing as { id?: string } | null)?.id ?? null;

  if (!orderId) {
    const { data: inserted } = await supabase
      .from("orders")
      .insert({
        organization_id: args.organizationId,
        integration_id: null,
        external_id: externalId,
        order_number: args.metaMessageId.slice(-10),
        contact_id: args.contactId,
        financial_status: "pending",
        currency,
        total,
        placed_at: new Date().toISOString(),
        raw: args.order,
      })
      .select("id")
      .maybeSingle();
    orderId = (inserted as { id?: string } | null)?.id ?? null;
    if (!orderId) return { handled: false };

    const retailerIds = items.map((i) => i.product_retailer_id);
    const { data: known } = await supabase
      .from("products")
      .select("external_id, title, image_url")
      .eq("organization_id", args.organizationId)
      .in("external_id", retailerIds);
    const byId = new Map(
      ((known ?? []) as Array<{ external_id: string; title: string; image_url: string | null }>).map(
        (p) => [p.external_id, p],
      ),
    );

    await supabase.from("order_items").insert(
      items.map((i) => ({
        order_id: orderId,
        organization_id: args.organizationId,
        external_product_id: i.product_retailer_id,
        title: byId.get(i.product_retailer_id)?.title ?? i.product_retailer_id,
        quantity: i.quantity,
        price: i.item_price,
        image_url: byId.get(i.product_retailer_id)?.image_url ?? null,
      })),
    );

    const names = items
      .map((i) => {
        const title = byId.get(i.product_retailer_id)?.title ?? i.product_retailer_id;
        return i.quantity > 1 ? `${title} ×${i.quantity}` : title;
      })
      .join(", ");

    await supabase
      .from("conversations")
      .update({
        needs_human: true,
        needs_human_reason: "catalog_order",
        needs_human_question: `Order from WhatsApp catalogue: ${names} · ${money(total, currency)}`,
        needs_human_at: new Date().toISOString(),
      })
      .eq("id", args.conversationId)
      .eq("organization_id", args.organizationId);

    await logServerActivity(
      supabase,
      args.organizationId,
      null,
      "whatsapp_catalog_order_received",
      {
        order_id: orderId,
        conversation_id: args.conversationId,
        items: items.length,
        total,
        currency,
      },
    );

    await sendServiceText(supabase, {
      organizationId: args.organizationId,
      phoneNumberId: args.phoneNumberId,
      accessToken: args.accessToken,
      conversationId: args.conversationId,
      to: args.to,
      body: "Got your order — the team will confirm payment and delivery here.",
    });
  }

  return { handled: true };
}
