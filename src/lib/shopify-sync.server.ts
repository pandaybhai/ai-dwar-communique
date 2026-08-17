import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhone, toWaId } from "@/lib/phone";
import { emitEvent, recordUsage } from "@/lib/events.server";
import { shopifyRest, type RestResult } from "@/lib/shopify.server";

/**
 * Turning Shopify objects into AiDwar rows.
 *
 * The consent rule in resolveOptInStatus is the highest-risk line in this
 * feature: a purchase is not consent, and a Shopify sync must never
 * resubscribe somebody who opted out on WhatsApp.
 */

type AnyRecord = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const numOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isoOrNull = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Shopify records consent per channel; only "subscribed" is explicit consent. */
export function shopifyConsentGiven(customer: AnyRecord | null | undefined): boolean {
  if (!customer) return false;
  const states = [
    (customer["sms_marketing_consent"] as AnyRecord | undefined)?.["state"],
    (customer["email_marketing_consent"] as AnyRecord | undefined)?.["state"],
  ];
  return states.some((s) => str(s).toLowerCase() === "subscribed");
}

/**
 * The consent state to write for a contact.
 *  - existing 'opted_out' is never touched. Ever.
 *  - existing 'opted_in' stays opted in.
 *  - otherwise: 'opted_in' only where Shopify records explicit marketing
 *    consent, else 'unknown'. Buying something is not subscribing.
 */
export function resolveOptInStatus(
  currentStatus: string | null | undefined,
  consentGiven: boolean,
): string {
  const current = str(currentStatus);
  if (current === "opted_out") return "opted_out";
  if (current === "opted_in") return "opted_in";
  return consentGiven ? "opted_in" : "unknown";
}

/** First phone Shopify offers, in order of reliability. */
export function extractPhone(payload: AnyRecord): string {
  const customer = (payload["customer"] as AnyRecord | undefined) ?? {};
  const shipping = (payload["shipping_address"] as AnyRecord | undefined) ?? {};
  const billing = (payload["billing_address"] as AnyRecord | undefined) ?? {};
  const candidates = [
    customer["phone"],
    payload["phone"],
    shipping["phone"],
    billing["phone"],
    (customer["default_address"] as AnyRecord | undefined)?.["phone"],
  ];
  for (const candidate of candidates) {
    const normalized = normalizePhone(str(candidate));
    // A bare local number without a country code can't be matched safely.
    if (normalized.length >= 9) return normalized;
  }
  return "";
}

function displayName(payload: AnyRecord): string | null {
  const customer = (payload["customer"] as AnyRecord | undefined) ?? {};
  const first = str(customer["first_name"]) || str(payload["first_name"]);
  const last = str(customer["last_name"]) || str(payload["last_name"]);
  const full = `${first} ${last}`.trim();
  return full || null;
}

export type ContactMatch = { contactId: string | null; created: boolean };

/**
 * Match a Shopify customer to a contact by E.164 phone, creating it when it
 * doesn't exist. Never widens consent beyond what Shopify recorded and never
 * narrows or clears an existing opt-out.
 */
export async function matchContact(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    shopDomain: string;
    externalCustomerId: string | null;
    payload: AnyRecord;
  },
): Promise<ContactMatch> {
  const phone = extractPhone(args.payload);
  if (!phone) return { contactId: null, created: false };

  const customer = (args.payload["customer"] as AnyRecord | undefined) ?? args.payload;
  const consentGiven = shopifyConsentGiven(customer);
  const name = displayName(args.payload);

  const { data: existing } = await supabase
    .from("contacts")
    .select("id, name, opt_in_status")
    .eq("organization_id", args.organizationId)
    .eq("phone", phone)
    .maybeSingle();

  if (existing) {
    const row = existing as { id: string; name: string | null; opt_in_status: string };
    const nextStatus = resolveOptInStatus(row.opt_in_status, consentGiven);
    const patch: AnyRecord = { updated_at: new Date().toISOString() };
    if (!row.name && name) patch["name"] = name;
    if (nextStatus !== row.opt_in_status) patch["opt_in_status"] = nextStatus;
    if (Object.keys(patch).length > 1) {
      await supabase.from("contacts").update(patch).eq("id", row.id);
    }
    return { contactId: row.id, created: false };
  }

  const { data: inserted } = await supabase
    .from("contacts")
    .insert({
      organization_id: args.organizationId,
      phone,
      wa_id: toWaId(phone),
      name,
      // Source is first-touch and frozen by trigger; this is where it starts.
      source: "shopify",
      source_detail: {
        shop_domain: args.shopDomain,
        external_customer_id: args.externalCustomerId,
      },
      opt_in_status: resolveOptInStatus(null, consentGiven),
    })
    .select("id")
    .maybeSingle();

  if (inserted) return { contactId: (inserted as { id: string }).id, created: true };

  // Lost a race with another webhook for the same phone — read it back.
  const { data: raced } = await supabase
    .from("contacts")
    .select("id")
    .eq("organization_id", args.organizationId)
    .eq("phone", phone)
    .maybeSingle();
  return { contactId: (raced as { id: string } | null)?.id ?? null, created: false };
}

export type SyncContext = {
  supabase: SupabaseClient;
  organizationId: string;
  integrationId: string;
  shopDomain: string;
};

function isCodOrder(order: AnyRecord): boolean {
  const names = Array.isArray(order["payment_gateway_names"])
    ? (order["payment_gateway_names"] as unknown[]).map((n) => str(n).toLowerCase())
    : [];
  const gateway = str(order["gateway"]).toLowerCase();
  const haystack = [...names, gateway].join(" ");
  return /cash on delivery|\bcod\b/.test(haystack);
}

function deliveredAt(order: AnyRecord): string | null {
  const fulfillments = Array.isArray(order["fulfillments"])
    ? (order["fulfillments"] as AnyRecord[])
    : [];
  for (const f of fulfillments) {
    if (str(f["shipment_status"]).toLowerCase() === "delivered") {
      return isoOrNull(f["updated_at"]) ?? isoOrNull(f["created_at"]);
    }
  }
  return null;
}

function fulfilledAt(order: AnyRecord): string | null {
  if (str(order["fulfillment_status"]).toLowerCase() !== "fulfilled") return null;
  const fulfillments = Array.isArray(order["fulfillments"])
    ? (order["fulfillments"] as AnyRecord[])
    : [];
  const first = fulfillments[0];
  return isoOrNull(first?.["created_at"]) ?? isoOrNull(order["updated_at"]);
}

/** Upsert one order plus its line items, and match its customer to a contact. */
export async function upsertOrder(
  ctx: SyncContext,
  order: AnyRecord,
  options: { emit?: boolean } = {},
): Promise<{ orderId: string | null; contactId: string | null; created: boolean }> {
  const externalId = str(order["id"]);
  if (!externalId) return { orderId: null, contactId: null, created: false };

  const customer = (order["customer"] as AnyRecord | undefined) ?? {};
  const externalCustomerId = str(customer["id"]) || null;

  const match = await matchContact(ctx.supabase, {
    organizationId: ctx.organizationId,
    shopDomain: ctx.shopDomain,
    externalCustomerId,
    payload: order,
  });

  const { data: existing } = await ctx.supabase
    .from("orders")
    .select("id, financial_status, fulfillment_status, cancelled_at")
    .eq("integration_id", ctx.integrationId)
    .eq("external_id", externalId)
    .maybeSingle();
  const previous = existing as
    | { id: string; financial_status: string | null; fulfillment_status: string | null; cancelled_at: string | null }
    | null;

  const row = {
    organization_id: ctx.organizationId,
    integration_id: ctx.integrationId,
    external_id: externalId,
    order_number: str(order["name"]) || str(order["order_number"]) || null,
    contact_id: match.contactId,
    external_customer_id: externalCustomerId,
    financial_status: str(order["financial_status"]) || null,
    fulfillment_status: str(order["fulfillment_status"]) || null,
    is_cod: isCodOrder(order),
    currency: str(order["currency"]) || null,
    total: numOrNull(order["total_price"]),
    placed_at: isoOrNull(order["created_at"]),
    cancelled_at: isoOrNull(order["cancelled_at"]),
    fulfilled_at: fulfilledAt(order),
    delivered_at: deliveredAt(order),
    raw: order,
    updated_at: new Date().toISOString(),
  };

  const { data: saved } = await ctx.supabase
    .from("orders")
    .upsert(row, { onConflict: "integration_id,external_id" })
    .select("id")
    .maybeSingle();
  const orderId = (saved as { id: string } | null)?.id ?? previous?.id ?? null;
  if (!orderId) return { orderId: null, contactId: match.contactId, created: false };

  const lineItems = Array.isArray(order["line_items"]) ? (order["line_items"] as AnyRecord[]) : [];
  await ctx.supabase.from("order_items").delete().eq("order_id", orderId);
  if (lineItems.length) {
    await ctx.supabase.from("order_items").insert(
      lineItems.map((item) => ({
        order_id: orderId,
        organization_id: ctx.organizationId,
        external_product_id: str(item["product_id"]) || null,
        title: str(item["title"]) || str(item["name"]),
        quantity: Number(item["quantity"] ?? 1) || 1,
        price: numOrNull(item["price"]),
        image_url: null,
      })),
    );
  }

  if (options.emit !== false) {
    const dimensions = {
      order_id: orderId,
      external_order_id: externalId,
      order_number: row.order_number,
      contact_id: match.contactId,
      integration_id: ctx.integrationId,
      shop_domain: ctx.shopDomain,
      provider: "shopify",
      currency: row.currency,
      total: row.total,
      is_cod: row.is_cod,
      financial_status: row.financial_status,
      fulfillment_status: row.fulfillment_status,
      item_count: lineItems.length,
    };

    if (!previous) {
      emitEvent(ctx.supabase, "order.created", {
        organizationId: ctx.organizationId,
        entityType: "order",
        entityId: orderId,
        properties: dimensions,
        ...(row.placed_at ? { occurredAt: row.placed_at } : {}),
      });
      recordUsage(ctx.supabase, "shopify_orders_synced", {
        organizationId: ctx.organizationId,
        quantity: 1,
        metadata: {
          integration_id: ctx.integrationId,
          shop_domain: ctx.shopDomain,
          order_id: orderId,
        },
      });
    }
    if (row.fulfillment_status === "fulfilled" && previous?.fulfillment_status !== "fulfilled") {
      emitEvent(ctx.supabase, "order.fulfilled", {
        organizationId: ctx.organizationId,
        entityType: "order",
        entityId: orderId,
        properties: dimensions,
        ...(row.fulfilled_at ? { occurredAt: row.fulfilled_at } : {}),
      });
    }
    if (row.cancelled_at && !previous?.cancelled_at) {
      emitEvent(ctx.supabase, "order.cancelled", {
        organizationId: ctx.organizationId,
        entityType: "order",
        entityId: orderId,
        properties: dimensions,
        occurredAt: row.cancelled_at,
      });
    }
  }

  return { orderId, contactId: match.contactId, created: !previous };
}

export async function upsertProduct(ctx: SyncContext, product: AnyRecord): Promise<boolean> {
  const externalId = str(product["id"]);
  if (!externalId) return false;

  const variants = Array.isArray(product["variants"]) ? (product["variants"] as AnyRecord[]) : [];
  const image = (product["image"] as AnyRecord | undefined) ?? {};
  const handle = str(product["handle"]) || null;

  const { data: saved } = await ctx.supabase
    .from("products")
    .upsert(
      {
        organization_id: ctx.organizationId,
        integration_id: ctx.integrationId,
        external_id: externalId,
        title: str(product["title"]),
        handle,
        price: numOrNull(variants[0]?.["price"]),
        currency: null,
        image_url: str(image["src"]) || null,
        product_url: handle ? `https://${ctx.shopDomain}/products/${handle}` : null,
        status: str(product["status"]) || null,
        synced_at: new Date().toISOString(),
      },
      { onConflict: "integration_id,external_id" },
    )
    .select("id")
    .maybeSingle();

  const productId = (saved as { id: string } | null)?.id ?? null;
  if (productId) {
    emitEvent(ctx.supabase, "product.synced", {
      organizationId: ctx.organizationId,
      entityType: "product",
      entityId: productId,
      properties: {
        product_id: productId,
        external_product_id: externalId,
        title: str(product["title"]),
        handle,
        status: str(product["status"]) || null,
        integration_id: ctx.integrationId,
        shop_domain: ctx.shopDomain,
        provider: "shopify",
      },
    });
  }
  return Boolean(productId);
}

export async function deleteProduct(ctx: SyncContext, externalId: string): Promise<void> {
  if (!externalId) return;
  await ctx.supabase
    .from("products")
    .delete()
    .eq("integration_id", ctx.integrationId)
    .eq("external_id", externalId);
}

/** A checkout Shopify has not seen completed is an abandoned checkout for us. */
export async function upsertCheckout(ctx: SyncContext, checkout: AnyRecord): Promise<void> {
  const externalId = str(checkout["id"]) || str(checkout["token"]);
  if (!externalId) return;

  const completedAt = isoOrNull(checkout["completed_at"]);
  const customer = (checkout["customer"] as AnyRecord | undefined) ?? {};
  const match = await matchContact(ctx.supabase, {
    organizationId: ctx.organizationId,
    shopDomain: ctx.shopDomain,
    externalCustomerId: str(customer["id"]) || null,
    payload: checkout,
  });

  const { data: existing } = await ctx.supabase
    .from("abandoned_checkouts")
    .select("id, recovered_at")
    .eq("integration_id", ctx.integrationId)
    .eq("external_id", externalId)
    .maybeSingle();
  const previous = existing as { id: string; recovered_at: string | null } | null;

  const abandonedAt =
    isoOrNull(checkout["updated_at"]) ?? isoOrNull(checkout["created_at"]) ?? new Date().toISOString();

  const { data: saved } = await ctx.supabase
    .from("abandoned_checkouts")
    .upsert(
      {
        organization_id: ctx.organizationId,
        integration_id: ctx.integrationId,
        external_id: externalId,
        contact_id: match.contactId,
        checkout_url: str(checkout["abandoned_checkout_url"]) || null,
        total: numOrNull(checkout["total_price"]),
        currency: str(checkout["currency"]) || null,
        abandoned_at: abandonedAt,
        recovered_at: completedAt,
        raw: checkout,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "integration_id,external_id" },
    )
    .select("id")
    .maybeSingle();

  const checkoutId = (saved as { id: string } | null)?.id ?? previous?.id ?? null;
  if (checkoutId && !previous && !completedAt) {
    emitEvent(ctx.supabase, "checkout.abandoned", {
      organizationId: ctx.organizationId,
      entityType: "abandoned_checkout",
      entityId: checkoutId,
      properties: {
        checkout_id: checkoutId,
        external_checkout_id: externalId,
        contact_id: match.contactId,
        total: numOrNull(checkout["total_price"]),
        currency: str(checkout["currency"]) || null,
        integration_id: ctx.integrationId,
        shop_domain: ctx.shopDomain,
        provider: "shopify",
      },
      occurredAt: abandonedAt,
    });
  }
}

/** Customer webhooks only touch the contact record and its consent state. */
export async function syncCustomer(ctx: SyncContext, customer: AnyRecord): Promise<void> {
  await matchContact(ctx.supabase, {
    organizationId: ctx.organizationId,
    shopDomain: ctx.shopDomain,
    externalCustomerId: str(customer["id"]) || null,
    payload: { customer },
  });
}

async function updateJob(
  supabase: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase.from("integration_sync_jobs").update(patch).eq("id", jobId);
}

/**
 * Backfill: every product, then the last 90 days of orders. Paginated with
 * page_info cursors and rate-limit aware through shopifyRest. Progress lands
 * on integration_sync_jobs so the UI can watch without blocking.
 */
export async function runBackfill(
  ctx: SyncContext,
  args: { accessToken: string; jobId: string },
): Promise<void> {
  let products = 0;
  let orders = 0;
  let contacts = 0;

  const page = async (path: string, query: Record<string, string>, pageInfo: string | null) =>
    shopifyRest({
      shopDomain: ctx.shopDomain,
      accessToken: args.accessToken,
      path,
      query: pageInfo ? { limit: "250", page_info: pageInfo } : { limit: "250", ...query },
    });

  const failed = async (result: RestResult, phase: string) => {
    const message = `Shopify ${phase} sync failed (${result.status}).`;
    await updateJob(ctx.supabase, args.jobId, {
      status: "failed",
      phase,
      error: message,
      finished_at: new Date().toISOString(),
    });
    await ctx.supabase
      .from("integrations")
      .update({ sync_error: message, status: "error" })
      .eq("id", ctx.integrationId);
  };

  try {
    await updateJob(ctx.supabase, args.jobId, { phase: "products" });
    let cursor: string | null = null;
    do {
      const result: RestResult = await page("products.json", {}, cursor);
      if (!result.ok) return void (await failed(result, "products"));
      const list = Array.isArray(result.body["products"])
        ? (result.body["products"] as AnyRecord[])
        : [];
      for (const product of list) if (await upsertProduct(ctx, product)) products += 1;
      await updateJob(ctx.supabase, args.jobId, { products_synced: products });
      cursor = result.nextPageInfo;
    } while (cursor);

    await updateJob(ctx.supabase, args.jobId, { phase: "orders" });
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    cursor = null;
    do {
      const result: RestResult = await page(
        "orders.json",
        { status: "any", created_at_min: since },
        cursor,
      );
      if (!result.ok) return void (await failed(result, "orders"));
      const list = Array.isArray(result.body["orders"]) ? (result.body["orders"] as AnyRecord[]) : [];
      for (const order of list) {
        const saved = await upsertOrder(ctx, order);
        if (saved.orderId) orders += 1;
        if (saved.contactId) contacts += 1;
      }
      await updateJob(ctx.supabase, args.jobId, {
        orders_synced: orders,
        contacts_matched: contacts,
      });
      cursor = result.nextPageInfo;
    } while (cursor);

    await updateJob(ctx.supabase, args.jobId, {
      status: "completed",
      phase: "done",
      finished_at: new Date().toISOString(),
    });
    await ctx.supabase
      .from("integrations")
      .update({ last_sync_at: new Date().toISOString(), sync_error: null, status: "connected" })
      .eq("id", ctx.integrationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backfill failed.";
    await updateJob(ctx.supabase, args.jobId, {
      status: "failed",
      error: message,
      finished_at: new Date().toISOString(),
    });
    await ctx.supabase
      .from("integrations")
      .update({ sync_error: message, status: "error" })
      .eq("id", ctx.integrationId);
  }
}
