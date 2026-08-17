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
  await supabase
    .from("integration_sync_jobs")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", jobId);
}

/** Jobs are enqueued and picked up by the cron worker; nothing runs inline. */
export async function enqueueBackfill(
  supabase: SupabaseClient,
  args: { organizationId: string; integrationId: string; kind?: string },
): Promise<string | null> {
  const { data } = await supabase
    .from("integration_sync_jobs")
    .insert({
      organization_id: args.organizationId,
      integration_id: args.integrationId,
      kind: args.kind ?? "backfill",
      status: "queued",
      phase: "queued",
    })
    .select("id")
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

type JobRow = {
  id: string;
  organization_id: string;
  integration_id: string;
  status: string;
  phase: string;
  cursor: string | null;
  products_synced: number;
  orders_synced: number;
  contacts_matched: number;
  started_at: string;
};

const STALL_MS = 10 * 60 * 1000;
const PAGE_SIZE = "250";

/** Fail any job that claims to be running but hasn't moved in 10 minutes. */
export async function failStalledSyncJobs(supabase: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - STALL_MS).toISOString();
  const { data } = await supabase
    .from("integration_sync_jobs")
    .update({
      status: "failed",
      error: "Sync stalled: no progress for over 10 minutes.",
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("status", "running")
    .lt("updated_at", cutoff)
    .select("id, integration_id");

  const rows = (data ?? []) as Array<{ id: string; integration_id: string }>;
  for (const row of rows) {
    await supabase
      .from("integrations")
      .update({ sync_error: "Sync stalled and was stopped.", status: "error" })
      .eq("id", row.integration_id);
  }
  return rows.length;
}

/**
 * Claim the oldest pending job. The compare-and-set on updated_at means two
 * overlapping ticks can never take the same row.
 */
async function claimJob(supabase: SupabaseClient): Promise<JobRow | null> {
  const { data } = await supabase
    .from("integration_sync_jobs")
    .select(
      "id, organization_id, integration_id, status, phase, cursor, products_synced, orders_synced, contacts_matched, started_at, updated_at",
    )
    .in("status", ["queued", "running"])
    .order("started_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  const job = data as (JobRow & { updated_at: string }) | null;
  if (!job) return null;

  const { data: claimed } = await supabase
    .from("integration_sync_jobs")
    .update({ status: "running", updated_at: new Date().toISOString() })
    .eq("id", job.id)
    .eq("updated_at", job.updated_at)
    .select("id")
    .maybeSingle();
  return claimed ? job : null;
}

async function failJob(supabase: SupabaseClient, job: JobRow, message: string): Promise<void> {
  await updateJob(supabase, job.id, {
    status: "failed",
    error: message,
    finished_at: new Date().toISOString(),
  });
  await supabase
    .from("integrations")
    .update({ sync_error: message, status: "error" })
    .eq("id", job.integration_id);
}

/**
 * Process exactly one bounded chunk of the claimed job — a page of products or
 * a page of orders — then persist phase, cursor and counters and return. The
 * next tick resumes from the stored cursor, so a big store backfills across
 * many short invocations instead of dying inside one.
 */
async function runChunk(supabase: SupabaseClient, job: JobRow): Promise<Record<string, unknown>> {
  const { getShopifyConnection } = await import("@/lib/shopify.server");
  const connection = await getShopifyConnection(supabase, job.integration_id);
  if (!connection.ok) {
    await failJob(supabase, job, connection.error);
    return { job_id: job.id, failed: connection.error };
  }

  const ctx: SyncContext = {
    supabase,
    organizationId: job.organization_id,
    integrationId: job.integration_id,
    shopDomain: connection.shopDomain,
  };

  const phase = job.phase === "queued" || job.phase === "starting" ? "products" : job.phase;
  const cursor = job.phase === phase ? job.cursor : null;

  const fetchPage = (path: string, query: Record<string, string>) =>
    shopifyRest({
      shopDomain: ctx.shopDomain,
      accessToken: connection.accessToken,
      path,
      query: cursor ? { limit: PAGE_SIZE, page_info: cursor } : { limit: PAGE_SIZE, ...query },
    });

  if (phase === "products") {
    const result: RestResult = await fetchPage("products.json", {});
    if (!result.ok) {
      await failJob(supabase, job, `Shopify products sync failed (${result.status}).`);
      return { job_id: job.id, failed: "products" };
    }
    const list = Array.isArray(result.body["products"])
      ? (result.body["products"] as AnyRecord[])
      : [];
    let products = job.products_synced;
    for (const product of list) if (await upsertProduct(ctx, product)) products += 1;

    const next = result.nextPageInfo;
    await updateJob(supabase, job.id, {
      phase: next ? "products" : "orders",
      cursor: next,
      products_synced: products,
    });
    return { job_id: job.id, phase: "products", page: list.length, products_synced: products };
  }

  if (phase === "orders") {
    // Window is anchored to the job, so resuming never shifts the range.
    const since = new Date(
      new Date(job.started_at).getTime() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result: RestResult = await fetchPage("orders.json", {
      status: "any",
      created_at_min: since,
    });
    if (!result.ok) {
      await failJob(supabase, job, `Shopify orders sync failed (${result.status}).`);
      return { job_id: job.id, failed: "orders" };
    }
    const list = Array.isArray(result.body["orders"]) ? (result.body["orders"] as AnyRecord[]) : [];
    let orders = job.orders_synced;
    let contacts = job.contacts_matched;
    for (const order of list) {
      const saved = await upsertOrder(ctx, order);
      if (saved.orderId) orders += 1;
      if (saved.contactId) contacts += 1;
    }

    const next = result.nextPageInfo;
    if (next) {
      await updateJob(supabase, job.id, {
        phase: "orders",
        cursor: next,
        orders_synced: orders,
        contacts_matched: contacts,
      });
      return { job_id: job.id, phase: "orders", page: list.length, orders_synced: orders };
    }

    const nowIso = new Date().toISOString();
    await updateJob(supabase, job.id, {
      status: "completed",
      phase: "done",
      cursor: null,
      orders_synced: orders,
      contacts_matched: contacts,
      finished_at: nowIso,
    });
    await supabase
      .from("integrations")
      .update({ last_sync_at: nowIso, sync_error: null, status: "connected" })
      .eq("id", job.integration_id);
    return { job_id: job.id, phase: "done", orders_synced: orders, contacts_matched: contacts };
  }

  await failJob(supabase, job, `Unknown sync phase "${phase}".`);
  return { job_id: job.id, failed: "phase" };
}

/** One cron tick: retire stalled jobs, then advance one job by one chunk. */
export async function processSyncJobTick(
  supabase: SupabaseClient,
): Promise<Record<string, unknown>> {
  const stalled = await failStalledSyncJobs(supabase);
  const job = await claimJob(supabase);
  if (!job) return { stalled, claimed: false };

  try {
    const result = await runChunk(supabase, job);
    return { stalled, claimed: true, ...result };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Backfill chunk failed.";
    await failJob(supabase, job, message);
    return { stalled, claimed: true, job_id: job.id, failed: message };
  }
}
