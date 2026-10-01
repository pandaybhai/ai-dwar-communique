import type { SupabaseClient } from "@supabase/supabase-js";
import {
  deleteProduct,
  syncCustomer,
  upsertCheckout,
  upsertOrder,
  type SyncContext,
} from "@/lib/shopify-sync.server";
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
    await redactShop(supabase, shopDomain, args.eventRowId);
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
        await redactCustomer(supabase, ctx, payload, args.eventRowId);
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

/**
 * Uninstall: the token is dead, so it is destroyed rather than kept — for
 * every workspace connected to this shop. Queued/running sync jobs are
 * stopped so the worker never runs (and marks "error") against a removed
 * store. Imported data stays until shop/redact (48h later), per Shopify.
 */
async function handleUninstall(supabase: SupabaseClient, ctx: SyncContext): Promise<void> {
  const { data } = await supabase
    .from("integrations")
    .select("id, organization_id")
    .eq("provider", "shopify")
    .eq("shop_domain", ctx.shopDomain);
  const all = (data ?? []) as Array<{ id: string; organization_id: string }>;
  if (!all.some((i) => i.id === ctx.integrationId)) all.push({ id: ctx.integrationId, organization_id: ctx.organizationId });
  const now = new Date().toISOString();

  for (const item of all) {
    await supabase.from("integration_credentials").delete().eq("integration_id", item.id);
    await supabase
      .from("integration_sync_jobs")
      .update({ status: "failed", error: "Shopify app uninstalled.", finished_at: now, updated_at: now })
      .eq("integration_id", item.id)
      .in("status", ["queued", "running"]);
    await supabase
      .from("integrations")
      .update({ status: "disconnected", sync_error: null })
      .eq("id", item.id);

    await emitEvent(supabase, "shopify.disconnected", {
      organizationId: item.organization_id,
      entityType: "integration",
      entityId: item.id,
      properties: {
        integration_id: item.id,
        shop_domain: ctx.shopDomain,
        provider: "shopify",
        reason: "app_uninstalled",
      },
    });

    await supabase.from("activity_log").insert({
      organization_id: item.organization_id,
      action: "integration_disconnected",
      details: { provider: "shopify", shop_domain: ctx.shopDomain, reason: "app_uninstalled" },
    });
  }

  // A custom app row is kept (so a reinstall works) but marked disconnected.
  await supabase
    .from("shopify_app_credentials")
    .update({ status: "disconnected", updated_at: now })
    .eq("shop_domain", ctx.shopDomain);
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

/** customers/redact — erase that one shopper's shop-sourced data (shared with the compliance route). */
async function redactCustomer(
  supabase: SupabaseClient,
  ctx: SyncContext,
  payload: AnyRecord,
  eventRowId: string | null,
): Promise<void> {
  const customer = (payload["customer"] as AnyRecord | undefined) ?? {};
  const externalCustomerId = str(customer["id"]);
  const { redactShopCustomer } = await import("@/lib/shopify-compliance.server");
  const results = await redactShopCustomer(supabase, ctx.shopDomain, payload, eventRowId);
  const orgs = new Set([ctx.organizationId, ...results.map((r) => r.organizationId)]);
  for (const organizationId of orgs) {
    await supabase.from("activity_log").insert({
      organization_id: organizationId,
      action: "integration_customer_redacted",
      details: {
        provider: "shopify",
        shop_domain: ctx.shopDomain,
        external_customer_id: externalCustomerId || null,
      },
    });
  }
}

/** shop/redact — 48h after uninstall: remove everything synced from that shop (shared with the compliance route). */
async function redactShop(supabase: SupabaseClient, shopDomain: string, eventRowId: string | null): Promise<void> {
  const { redactShopData } = await import("@/lib/shopify-compliance.server");
  for (const item of await redactShopData(supabase, shopDomain, eventRowId)) {
    await supabase.from("activity_log").insert({
      organization_id: item.organizationId,
      action: "integration_shop_redacted",
      details: { provider: "shopify", shop_domain: shopDomain },
    });
  }
}
