import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deleteProduct,
  syncCustomer,
  upsertCheckout,
  upsertOrder,
  type SyncContext,
} from "@/lib/shopify-sync.server";
import { normalizePhone } from "@/lib/phone";
import { emitEvent } from "@/lib/events.server";

type AnyRecord = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));

/**
 * Webhook dispatch. Every caller has already verified the HMAC and recorded
 * the event; this function only decides what the payload means. It must stay
 * idempotent — Shopify retries the same event id for days.
 */
export async function processShopifyWebhook(args: {
  supabase: SupabaseClient;
  topic: string;
  shopDomain: string;
  payload: AnyRecord;
  eventRowId: string | null;
}): Promise<void> {
  const { supabase, topic, shopDomain, payload } = args;

  const mark = async (error?: string) => {
    if (!args.eventRowId) return;
    await supabase
      .from("webhook_events")
      .update({ processed_at: new Date().toISOString(), error: error ?? null })
      .eq("id", args.eventRowId);
  };

  // GDPR topics arrive for shops that may already be uninstalled.
  if (topic === "shop/redact") {
    await redactShop(supabase, shopDomain);
    return void (await mark());
  }

  const { data: integration } = await supabase
    .from("integrations")
    .select("id, organization_id, shop_domain, status")
    .eq("provider", "shopify")
    .eq("shop_domain", shopDomain)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!integration) return void (await mark("No connected store for this shop domain."));

  const row = integration as { id: string; organization_id: string; shop_domain: string };
  const ctx: SyncContext = {
    supabase,
    organizationId: row.organization_id,
    integrationId: row.id,
    shopDomain: row.shop_domain,
  };

  try {
    switch (topic) {
      case "orders/create":
      case "orders/updated":
      case "orders/cancelled":
      case "orders/fulfilled":
        await upsertOrder(ctx, payload);
        break;

      case "checkouts/create":
      case "checkouts/update":
        await upsertCheckout(ctx, payload);
        break;

      case "customers/create":
      case "customers/update":
        await syncCustomer(ctx, payload);
        break;

      case "products/create":
      case "products/update": {
        const { upsertProduct } = await import("@/lib/shopify-sync.server");
        await upsertProduct(ctx, payload);
        break;
      }

      case "products/delete":
        await deleteProduct(ctx, str(payload["id"]));
        break;

      case "app/uninstalled":
        await handleUninstall(supabase, ctx);
        break;

      case "customers/data_request":
        await logDataRequest(supabase, ctx, payload);
        break;

      case "customers/redact":
        await redactCustomer(supabase, ctx, payload);
        break;

      default:
        await mark(`Unhandled topic ${topic}.`);
        return;
    }
    await supabase
      .from("integrations")
      .update({ last_sync_at: new Date().toISOString() })
      .eq("id", ctx.integrationId);
    await mark();
  } catch (err) {
    await mark(err instanceof Error ? err.message : "Processing failed.");
  }
}

/** Uninstall: the token is dead, so it is destroyed rather than kept. */
async function handleUninstall(supabase: SupabaseClient, ctx: SyncContext): Promise<void> {
  await supabase.from("integration_credentials").delete().eq("integration_id", ctx.integrationId);
  await supabase
    .from("integrations")
    .update({ status: "disconnected", sync_error: null })
    .eq("id", ctx.integrationId);

  await emitEvent(supabase, "shopify.disconnected", {
    organizationId: ctx.organizationId,
    entityType: "integration",
    entityId: ctx.integrationId,
    properties: {
      integration_id: ctx.integrationId,
      shop_domain: ctx.shopDomain,
      provider: "shopify",
      reason: "app_uninstalled",
    },
  });

  await supabase.from("activity_log").insert({
    organization_id: ctx.organizationId,
    action: "integration_disconnected",
    details: { provider: "shopify", shop_domain: ctx.shopDomain, reason: "app_uninstalled" },
  });
}

/** customers/data_request — recorded for the workspace to answer, never auto-answered. */
async function logDataRequest(
  supabase: SupabaseClient,
  ctx: SyncContext,
  payload: AnyRecord,
): Promise<void> {
  const customer = (payload["customer"] as AnyRecord | undefined) ?? {};
  await supabase.from("activity_log").insert({
    organization_id: ctx.organizationId,
    action: "integration_data_request",
    details: {
      provider: "shopify",
      shop_domain: ctx.shopDomain,
      external_customer_id: str(customer["id"]) || null,
      requested_at: new Date().toISOString(),
    },
  });
}

/** customers/redact — erase what we hold about that one shopper. */
async function redactCustomer(
  supabase: SupabaseClient,
  ctx: SyncContext,
  payload: AnyRecord,
): Promise<void> {
  const customer = (payload["customer"] as AnyRecord | undefined) ?? {};
  const externalCustomerId = str(customer["id"]);
  const phone = normalizePhone(str(customer["phone"]));

  if (externalCustomerId) {
    await supabase
      .from("orders")
      .update({ raw: {}, external_customer_id: null, contact_id: null })
      .eq("integration_id", ctx.integrationId)
      .eq("external_customer_id", externalCustomerId);
  }

  if (phone) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("id, source")
      .eq("organization_id", ctx.organizationId)
      .eq("phone", phone)
      .maybeSingle();
    const found = contact as { id: string; source: string } | null;
    if (found) {
      await supabase
        .from("abandoned_checkouts")
        .update({ contact_id: null, raw: {} })
        .eq("integration_id", ctx.integrationId)
        .eq("contact_id", found.id);
      // Only a contact this store created is ours to erase; a WhatsApp-sourced
      // contact belongs to the workspace, so it is only unlinked above.
      if (found.source === "shopify") {
        await supabase.from("contacts").delete().eq("id", found.id);
      }
    }
  }

  await supabase.from("activity_log").insert({
    organization_id: ctx.organizationId,
    action: "integration_customer_redacted",
    details: {
      provider: "shopify",
      shop_domain: ctx.shopDomain,
      external_customer_id: externalCustomerId || null,
    },
  });
}

/** shop/redact — 48h after uninstall: remove everything synced from that shop. */
async function redactShop(supabase: SupabaseClient, shopDomain: string): Promise<void> {
  const { data: integrations } = await supabase
    .from("integrations")
    .select("id, organization_id")
    .eq("provider", "shopify")
    .eq("shop_domain", shopDomain);

  for (const item of (integrations ?? []) as Array<{ id: string; organization_id: string }>) {
    await supabase.from("integration_credentials").delete().eq("integration_id", item.id);
    await supabase.from("products").delete().eq("integration_id", item.id);
    await supabase.from("abandoned_checkouts").delete().eq("integration_id", item.id);
    await supabase.from("orders").delete().eq("integration_id", item.id);
    await supabase.from("integration_sync_jobs").delete().eq("integration_id", item.id);
    await supabase.from("integrations").delete().eq("id", item.id);

    await supabase.from("activity_log").insert({
      organization_id: item.organization_id,
      action: "integration_shop_redacted",
      details: { provider: "shopify", shop_domain: shopDomain },
    });
  }
}
