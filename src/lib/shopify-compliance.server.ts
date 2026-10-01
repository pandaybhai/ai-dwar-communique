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
  const { verifyWebhookForShop, normalizeShopDomain, getServiceClient } =
    await import("@/lib/shopify.server");

  const rawBody = await request.text();
  const signature = request.headers.get("x-shopify-hmac-sha256");
  const shopDomain = normalizeShopDomain(request.headers.get("x-shopify-shop-domain"));
  if (!(await verifyWebhookForShop(rawBody, signature, shopDomain))) {
    return { response: Response.json({ error: "Invalid signature" }, { status: 401 }) };
  }

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
  if (error) return { response: Response.json({ ok: true, duplicate: true }, { status: 200 }) };

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
): Promise<Array<{ id: string; source: string; source_detail: AnyRecord | null }>> {
  type Row = { id: string; source: string; source_detail: AnyRecord | null };
  const results = new Map<string, Row>();

  if (phone) {
    const { data } = await service
      .from("contacts")
      .select("id, source, source_detail")
      .eq("organization_id", organizationId)
      .eq("phone", phone);
    for (const row of (data ?? []) as Row[]) {
      results.set(row.id, row);
    }
  }

  if (email) {
    const { data } = await service
      .from("contacts")
      .select("id, source, source_detail")
      .eq("organization_id", organizationId)
      .eq("attributes->>email", email);
    for (const row of (data ?? []) as Row[]) {
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

const CHUNK = 200;

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

async function ids(query: PromiseLike<{ data: unknown }>): Promise<string[]> {
  const { data } = await query;
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

/**
 * Of these contacts, the ones this shop's sync created (source 'shopify',
 * source_detail.shop_domain = this shop) and that never chatted with the
 * workspace. A contact the merchant added, or one with a WhatsApp
 * conversation, is the workspace's own relationship and is never deleted.
 */
async function shopOnlyContacts(
  service: SupabaseClient,
  organizationId: string,
  shopDomain: string,
  candidates: Array<{ id: string; source: string; source_detail?: AnyRecord | null }>,
): Promise<string[]> {
  const fromShop = candidates
    .filter((c) => c.source === "shopify" && str(c.source_detail?.["shop_domain"]) === shopDomain)
    .map((c) => c.id);
  const chatted = new Set<string>();
  for (const part of chunks(fromShop)) {
    const { data } = await service
      .from("conversations")
      .select("contact_id")
      .eq("organization_id", organizationId)
      .in("contact_id", part);
    for (const r of (data ?? []) as Array<{ contact_id: string }>) chatted.add(r.contact_id);
  }
  return fromShop.filter((id) => !chatted.has(id));
}

async function deleteContacts(service: SupabaseClient, organizationId: string, contactIds: string[]): Promise<void> {
  for (const part of chunks(contactIds)) {
    await service.from("contact_tags").delete().in("contact_id", part);
    await service.from("contacts").delete().eq("organization_id", organizationId).in("id", part);
  }
}

export type CustomerRedactResult = {
  organizationId: string;
  integrationId: string;
  ordersDeleted: number;
  checkoutsDeleted: number;
  contactsDeleted: number;
};

/**
 * customers/redact: erase one shopper's shop-sourced data, in every
 * workspace connected to this shop. Orders and abandoned checkouts are
 * matched within that shop's integration by Shopify customer id, email, or a
 * contact with the shopper's phone/email; the contact itself is deleted only
 * when this shop's sync created it (see shopOnlyContacts). Raw webhook
 * deliveries from this shop about this customer go too (keepEventId — the
 * redact request itself — stays as the audit/idempotency record).
 */
export async function redactShopCustomer(
  service: SupabaseClient,
  shopDomain: string,
  payload: AnyRecord,
  keepEventId: string | null = null,
): Promise<CustomerRedactResult[]> {
  const customer = (payload["customer"] as AnyRecord | undefined) ?? {};
  const externalCustomerId = str(customer["id"]);
  const phone = normalizePhone(str(customer["phone"]));
  const email = str(customer["email"]).toLowerCase();
  const results: CustomerRedactResult[] = [];
  if (!shopDomain || (!externalCustomerId && !phone && !email)) return results;

  for (const integration of await findIntegrations(service, shopDomain)) {
    const orgId = integration.organization_id;
    const contacts = await matchingContacts(service, orgId, phone, email);
    const contactIds = contacts.map((c) => c.id);

    const scoped = (table: "orders" | "abandoned_checkouts") =>
      service.from(table).select("id").eq("organization_id", orgId).eq("integration_id", integration.id);

    let orderIds: string[] = [];
    let checkoutIds: string[] = [];
    if (externalCustomerId) {
      orderIds.push(...(await ids(scoped("orders").eq("external_customer_id", externalCustomerId))));
      // Checkouts carry no external_customer_id column: read it off the payload.
      checkoutIds.push(...(await ids(scoped("abandoned_checkouts").eq("raw->customer->>id", externalCustomerId))));
    }
    if (email) {
      // Case-insensitive exact match (LIKE wildcards escaped).
      const exact = email.replace(/[\\%_]/g, "\\$&");
      orderIds.push(...(await ids(scoped("orders").ilike("raw->>email", exact))));
      checkoutIds.push(...(await ids(scoped("abandoned_checkouts").ilike("raw->>email", exact))));
    }
    if (contactIds.length) {
      orderIds.push(...(await ids(scoped("orders").in("contact_id", contactIds))));
      checkoutIds.push(...(await ids(scoped("abandoned_checkouts").in("contact_id", contactIds))));
    }
    orderIds = Array.from(new Set(orderIds));
    checkoutIds = Array.from(new Set(checkoutIds));

    for (const part of chunks(orderIds)) {
      await service.from("order_items").delete().eq("organization_id", orgId).in("order_id", part);
      await service.from("orders").delete().eq("organization_id", orgId).eq("integration_id", integration.id).in("id", part);
    }
    for (const part of chunks(checkoutIds)) {
      await service.from("abandoned_checkouts").delete().eq("organization_id", orgId).eq("integration_id", integration.id).in("id", part);
    }

    const removable = await shopOnlyContacts(service, orgId, shopDomain, contacts);
    await deleteContacts(service, orgId, removable);

    results.push({
      organizationId: orgId,
      integrationId: integration.id,
      ordersDeleted: orderIds.length,
      checkoutsDeleted: checkoutIds.length,
      contactsDeleted: removable.length,
    });
  }

  // Raw deliveries from this shop that carry this shopper's details.
  if (externalCustomerId) {
    const events = () => {
      const q = service.from("webhook_events").delete().eq("provider", "shopify").eq("payload->>shop_domain", shopDomain);
      return keepEventId ? q.neq("id", keepEventId) : q;
    };
    await events().eq("payload->body->customer->>id", externalCustomerId);
    await events().in("payload->>topic", ["customers/create", "customers/update"]).eq("payload->body->>id", externalCustomerId);
  }
  return results;
}

export type ShopRedactResult = {
  organizationId: string;
  integrationId: string;
  ordersDeleted: number;
  contactsDeleted: number;
};

/**
 * shop/redact (48h after uninstall): everything imported from this shop, in
 * every workspace connected to it, all scoped by that shop's integration id
 * (or source_detail.shop_domain for contacts): orders + items, abandoned
 * checkouts, synced products, sync jobs, the stored token, contacts this
 * shop's sync created that never chatted, and the integration itself; then
 * this shop's raw webhook deliveries. Data the merchant created in AiDwar
 * (crawled/manual products, WhatsApp contacts and chats) is untouched.
 */
export async function redactShopData(
  service: SupabaseClient,
  shopDomain: string,
  keepEventId: string | null = null,
): Promise<ShopRedactResult[]> {
  const results: ShopRedactResult[] = [];
  if (!shopDomain) return results;

  for (const integration of await findIntegrations(service, shopDomain)) {
    const orgId = integration.organization_id;
    const orderIds = await ids(
      service.from("orders").select("id").eq("organization_id", orgId).eq("integration_id", integration.id),
    );
    for (const part of chunks(orderIds)) {
      await service.from("order_items").delete().eq("organization_id", orgId).in("order_id", part);
    }
    await service.from("orders").delete().eq("organization_id", orgId).eq("integration_id", integration.id);
    await service.from("abandoned_checkouts").delete().eq("organization_id", orgId).eq("integration_id", integration.id);
    await service.from("products").delete().eq("organization_id", orgId).eq("integration_id", integration.id);
    await service.from("integration_sync_jobs").delete().eq("organization_id", orgId).eq("integration_id", integration.id);
    await service.from("integration_credentials").delete().eq("integration_id", integration.id);

    const { data: imported } = await service
      .from("contacts")
      .select("id, source, source_detail")
      .eq("organization_id", orgId)
      .eq("source", "shopify")
      .eq("source_detail->>shop_domain", shopDomain);
    const removable = await shopOnlyContacts(
      service,
      orgId,
      shopDomain,
      (imported ?? []) as Array<{ id: string; source: string; source_detail: AnyRecord | null }>,
    );
    await deleteContacts(service, orgId, removable);

    await service.from("integrations").delete().eq("organization_id", orgId).eq("id", integration.id);
    results.push({ organizationId: orgId, integrationId: integration.id, ordersDeleted: orderIds.length, contactsDeleted: removable.length });
  }

  const events = service.from("webhook_events").delete().eq("provider", "shopify").eq("payload->>shop_domain", shopDomain);
  await (keepEventId ? events.neq("id", keepEventId) : events);
  return results;
}

/** customers/redact — erase that one shopper's shop-sourced data. */
export async function handleCustomersRedact(delivery: VerifiedDelivery): Promise<void> {
  const { service, shopDomain, payload, eventRowId } = delivery;
  const customer = (payload["customer"] as AnyRecord | undefined) ?? {};
  const externalCustomerId = str(customer["id"]);

  try {
    for (const r of await redactShopCustomer(service, shopDomain, payload, eventRowId)) {
      await service.from("activity_log").insert({
        organization_id: r.organizationId,
        action: "shopify_customer_redacted",
        details: {
          provider: "shopify",
          shop_domain: shopDomain,
          external_customer_id: externalCustomerId || null,
          contacts_deleted: r.contactsDeleted,
          orders_deleted: r.ordersDeleted,
          checkouts_deleted: r.checkoutsDeleted,
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
    for (const r of await redactShopData(service, shopDomain, eventRowId)) {
      await service.from("activity_log").insert({
        organization_id: r.organizationId,
        action: "shopify_shop_redacted",
        details: { provider: "shopify", shop_domain: shopDomain, orders_deleted: r.ordersDeleted, contacts_deleted: r.contactsDeleted },
      });
    }
    await markProcessed(service, eventRowId);
  } catch (err) {
    await markProcessed(service, eventRowId, err instanceof Error ? err.message : "Failed");
  }
}
