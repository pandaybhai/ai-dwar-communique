import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone } from "@/lib/phone";

/**
 * Shopify's three mandatory compliance webhooks.
 *
 * Shared discipline for all three: verify the HMAC with a timing-safe compare,
 * record the raw delivery in webhook_events (provider='shopify'), act, and
 * answer 200. Nothing is read or written before the signature verifies.
 */

type AnyRecord = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

export const PRIVACY_EMAIL = "privacy@aidwar.in";

export type ComplianceTopic =
  | "customers/data_request"
  | "customers/redact"
  | "shop/redact";

export type VerifiedDelivery = {
  service: SupabaseClient;
  topic: ComplianceTopic;
  shopDomain: string;
  payload: AnyRecord;
  eventRowId: string | null;
};

/**
 * Verifies the delivery and logs it. Returns either a Response to send back
 * immediately (401 / 503 / duplicate-200) or the verified delivery context.
 */
export async function receiveComplianceWebhook(
  request: Request,
  topic: ComplianceTopic,
): Promise<{ response: Response } | { delivery: VerifiedDelivery }> {
  const { shopifyCredentials, verifyWebhookHmac, normalizeShopDomain, getServiceClient } =
    await import("@/lib/shopify.server");

  const creds = shopifyCredentials();
  if (!creds) return { response: new Response("Not configured", { status: 503 }) };

  const rawBody = await request.text();
  const signature = request.headers.get("x-shopify-hmac-sha256");
  if (!(await verifyWebhookHmac(rawBody, signature, creds.apiSecret))) {
    return { response: new Response("Invalid signature", { status: 401 }) };
  }

  const shopDomain = normalizeShopDomain(request.headers.get("x-shopify-shop-domain"));
  const eventId =
    request.headers.get("x-shopify-event-id") ??
    request.headers.get("x-shopify-webhook-id") ??
    `${topic}:${shopDomain}:${Date.now()}`;

  let payload: AnyRecord = {};
  try {
    payload = JSON.parse(rawBody) as AnyRecord;
  } catch {
    payload = {};
  }

  const service = getServiceClient();
  const { data: inserted, error } = await service
    .from("webhook_events")
    .insert({
      provider: "shopify",
      external_event_id: eventId,
      signature_valid: true,
      payload: { topic, shop_domain: shopDomain, body: payload },
    })
    .select("id")
    .maybeSingle();

  // A repeat delivery of an event we already hold is acknowledged, not re-run.
  if (error) return { response: new Response("ok", { status: 200 }) };

  return {
    delivery: {
      service,
      topic,
      shopDomain,
      payload,
      eventRowId: (inserted as { id: string } | null)?.id ?? null,
    },
  };
}

async function markProcessed(
  service: SupabaseClient,
  eventRowId: string | null,
  error?: string,
): Promise<void> {
  if (!eventRowId) return;
  await service
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString(), error: error ?? null })
    .eq("id", eventRowId);
}

async function findIntegrations(
  service: SupabaseClient,
  shopDomain: string,
): Promise<Array<{ id: string; organization_id: string }>> {
  const { data } = await service
    .from("integrations")
    .select("id, organization_id")
    .eq("provider", "shopify")
    .eq("shop_domain", shopDomain);
  return (data ?? []) as Array<{ id: string; organization_id: string }>;
}

/** Contacts in this workspace that match the shopper's phone or email. */
async function matchingContacts(
  service: SupabaseClient,
  organizationId: string,
  phone: string,
  email: string,
): Promise<Array<{ id: string; source: string }>> {
  const results = new Map<string, { id: string; source: string }>();

  if (phone) {
    const { data } = await service
      .from("contacts")
      .select("id, source")
      .eq("organization_id", organizationId)
      .eq("phone", phone);
    for (const row of (data ?? []) as Array<{ id: string; source: string }>) {
      results.set(row.id, row);
    }
  }

  if (email) {
    const { data } = await service
      .from("contacts")
      .select("id, source")
      .eq("organization_id", organizationId)
      .eq("attributes->>email", email);
    for (const row of (data ?? []) as Array<{ id: string; source: string }>) {
      results.set(row.id, row);
    }
  }

  return Array.from(results.values());
}

/** Best-effort notification. Absence of a mail provider never fails a webhook. */
async function notifyPrivacyInbox(subject: string, lines: string[]): Promise<void> {
  const apiKey = process.env["RESEND_API_KEY"];
  if (!apiKey) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "AiDwar Compliance <privacy@aidwar.in>",
        to: [PRIVACY_EMAIL],
        subject,
        text: lines.join("\n"),
      }),
    });
  } catch {
    // never block the webhook on mail delivery
  }
}

/** customers/data_request — recorded and escalated; never auto-answered. */
export async function handleCustomersDataRequest(delivery: VerifiedDelivery): Promise<void> {
  const { service, shopDomain, payload, eventRowId } = delivery;
  const customer = (payload["customer"] as AnyRecord | undefined) ?? {};
  const externalCustomerId = str(customer["id"]);
  const phone = normalizePhone(str(customer["phone"]));
  const email = str(customer["email"]).toLowerCase();

  try {
    const integrations = await findIntegrations(service, shopDomain);
    let matched = 0;

    for (const integration of integrations) {
      const contacts = await matchingContacts(service, integration.organization_id, phone, email);
      matched += contacts.length;
      await service.from("activity_log").insert({
        organization_id: integration.organization_id,
        action: "shopify_data_request",
        details: {
          provider: "shopify",
          shop_domain: shopDomain,
          external_customer_id: externalCustomerId || null,
          matched_contacts: contacts.length,
          requested_at: new Date().toISOString(),
          due_by: new Date(Date.now() + 30 * 86400_000).toISOString(),
        },
      });
    }

    await notifyPrivacyInbox(`Shopify data request — ${shopDomain}`, [
      `Shop domain: ${shopDomain}`,
      `Shopify customer ID: ${externalCustomerId || "unknown"}`,
      `Matching AiDwar contacts: ${matched}`,
      `Must be fulfilled within 30 days of ${new Date().toISOString()}.`,
    ]);

    await markProcessed(service, eventRowId);
  } catch (err) {
    await markProcessed(service, eventRowId, err instanceof Error ? err.message : "Failed");
  }
}

/** customers/redact — hard-delete everything we hold about that one shopper. */
export async function handleCustomersRedact(delivery: VerifiedDelivery): Promise<void> {
  const { service, shopDomain, payload, eventRowId } = delivery;
  const customer = (payload["customer"] as AnyRecord | undefined) ?? {};
  const externalCustomerId = str(customer["id"]);
  const phone = normalizePhone(str(customer["phone"]));
  const email = str(customer["email"]).toLowerCase();

  try {
    for (const integration of await findIntegrations(service, shopDomain)) {
      const orgId = integration.organization_id;

      // Orders belonging to this shopper, plus their line items.
      let orderIds: string[] = [];
      if (externalCustomerId) {
        const { data } = await service
          .from("orders")
          .select("id")
          .eq("integration_id", integration.id)
          .eq("external_customer_id", externalCustomerId);
        orderIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
      }

      const contacts = await matchingContacts(service, orgId, phone, email);
      const contactIds = contacts.map((c) => c.id);

      if (contactIds.length) {
        const { data } = await service
          .from("orders")
          .select("id")
          .eq("integration_id", integration.id)
          .in("contact_id", contactIds);
        for (const row of (data ?? []) as Array<{ id: string }>) orderIds.push(row.id);
      }

      orderIds = Array.from(new Set(orderIds));
      if (orderIds.length) {
        await service.from("order_items").delete().in("order_id", orderIds);
        await service.from("orders").delete().in("id", orderIds);
      }

      if (contactIds.length) {
        await service
          .from("abandoned_checkouts")
          .delete()
          .eq("integration_id", integration.id)
          .in("contact_id", contactIds);

        const { data: convos } = await service
          .from("conversations")
          .select("id")
          .eq("organization_id", orgId)
          .in("contact_id", contactIds);
        const conversationIds = ((convos ?? []) as Array<{ id: string }>).map((c) => c.id);
        if (conversationIds.length) {
          await service.from("messages").delete().in("conversation_id", conversationIds);
          await service.from("conversations").delete().in("id", conversationIds);
        }

        await service.from("contact_tags").delete().in("contact_id", contactIds);
        await service.from("contacts").delete().in("id", contactIds);
      }

      await service.from("activity_log").insert({
        organization_id: orgId,
        action: "shopify_customer_redacted",
        details: {
          provider: "shopify",
          shop_domain: shopDomain,
          external_customer_id: externalCustomerId || null,
          contacts_deleted: contactIds.length,
          orders_deleted: orderIds.length,
        },
      });
    }

    await markProcessed(service, eventRowId);
  } catch (err) {
    await markProcessed(service, eventRowId, err instanceof Error ? err.message : "Failed");
  }
}

/** shop/redact — 48h after uninstall: remove everything synced from that shop. */
export async function handleShopRedact(delivery: VerifiedDelivery): Promise<void> {
  const { service, shopDomain, eventRowId } = delivery;

  try {
    for (const integration of await findIntegrations(service, shopDomain)) {
      const { data: orders } = await service
        .from("orders")
        .select("id")
        .eq("integration_id", integration.id);
      const orderIds = ((orders ?? []) as Array<{ id: string }>).map((r) => r.id);
      if (orderIds.length) await service.from("order_items").delete().in("order_id", orderIds);

      await service.from("orders").delete().eq("integration_id", integration.id);
      await service.from("abandoned_checkouts").delete().eq("integration_id", integration.id);
      await service.from("products").delete().eq("integration_id", integration.id);
      await service.from("integration_sync_jobs").delete().eq("integration_id", integration.id);
      await service.from("integration_credentials").delete().eq("integration_id", integration.id);
      await service.from("integrations").delete().eq("id", integration.id);

      await service.from("activity_log").insert({
        organization_id: integration.organization_id,
        action: "shopify_shop_redacted",
        details: { provider: "shopify", shop_domain: shopDomain, orders_deleted: orderIds.length },
      });
    }

    await markProcessed(service, eventRowId);
  } catch (err) {
    await markProcessed(service, eventRowId, err instanceof Error ? err.message : "Failed");
  }
}
