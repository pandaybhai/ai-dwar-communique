import type { SupabaseClient } from "@supabase/supabase-js";
import {
  graphFetch,
  graphErrorMessage,
  providerErrorDetail,
  logServerActivity,
} from "@/lib/whatsapp-api.server";
import { getWhatsAppConnection } from "@/lib/whatsapp-numbers.server";

/**
 * WhatsApp catalogue: create a Meta product catalogue for the connected
 * business account and push products that carry both a price and a picture.
 *
 * Access is gated on the scopes Meta actually granted for that number, not on
 * who the signed-in teammate is — until App Review approves catalog_management
 * Meta only hands these scopes to people with a role on the app.
 */

export const CATALOG_SCOPES = ["catalog_management", "business_management"] as const;

export function hasCatalogScopes(scopes: string[] | null | undefined): boolean {
  const granted = new Set((scopes ?? []).map((s) => s.trim()));
  return CATALOG_SCOPES.every((s) => granted.has(s));
}

/** Every Graph catalogue call lands in activity_log — endpoint, status, error. */
async function logGraphCall(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string | null,
  details: {
    endpoint: string;
    method: string;
    status: number;
    ok: boolean;
    error?: string | null;
    waba_id?: string | null;
    catalog_id?: string | null;
    items?: number | null;
  },
): Promise<void> {
  try {
    await supabase.from("activity_log").insert({
      organization_id: organizationId,
      user_id: userId,
      action: "whatsapp_catalog_graph_call",
      details,
    });
  } catch {
    // logging must never break the action
  }
}

type CallArgs = {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string | null;
  wabaId: string | null;
  catalogId?: string | null;
};

/** graphFetch plus the activity_log entry, so every call is on the record. */
async function loggedGraph(
  ctx: CallArgs,
  path: string,
  accessToken: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
  items?: number,
) {
  const result = await graphFetch(path, accessToken, init);
  await logGraphCall(ctx.supabase, ctx.organizationId, ctx.userId, {
    endpoint: path,
    method: init.method ?? "GET",
    status: result.status,
    ok: result.ok,
    error: result.ok ? null : providerErrorDetail(result.body).slice(0, 1000),
    waba_id: ctx.wabaId ?? null,
    catalog_id: ctx.catalogId ?? null,
    items: items ?? null,
  });
  return result;
}

export type CatalogRow = {
  catalog_id: string;
  catalog_name: string | null;
  status: string;
  mode: "managed" | "linked";
  last_sync_at: string | null;
  pushed_count: number;
  rejected_count: number;
  last_error: string | null;
};

export async function getCatalogRow(
  supabase: SupabaseClient,
  organizationId: string,
  wabaId: string,
): Promise<CatalogRow | null> {
  const { data } = await supabase
    .from("whatsapp_catalogs")
    .select(
      "catalog_id, catalog_name, status, mode, last_sync_at, pushed_count, rejected_count, last_error, is_catalog_visible, is_cart_enabled",
    )
    .eq("organization_id", organizationId)
    .eq("waba_id", wabaId)
    .maybeSingle();
  return (data as CatalogRow | null) ?? null;
}

export async function getGrantedScopes(
  supabase: SupabaseClient,
  organizationId: string,
  wabaId: string,
): Promise<string[] | null> {
  const { data } = await supabase
    .from("whatsapp_credentials")
    .select("granted_scopes")
    .eq("organization_id", organizationId)
    .eq("waba_id", wabaId)
    .maybeSingle();
  return ((data as { granted_scopes?: string[] | null } | null)?.granted_scopes ?? null) as
    | string[]
    | null;
}

type Resolved = {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
  scopes: string[] | null;
};

export async function resolveCatalogContext(
  supabase: SupabaseClient,
  organizationId: string,
  whatsappAccountId: string | null,
): Promise<{ ctx: Resolved | null; error: string | null }> {
  const { connection, error } = await getWhatsAppConnection(
    supabase,
    organizationId,
    whatsappAccountId,
  );
  if (!connection) return { ctx: null, error };
  const scopes = await getGrantedScopes(supabase, organizationId, connection.wabaId);
  return {
    ctx: {
      wabaId: connection.wabaId,
      phoneNumberId: connection.phoneNumberId,
      accessToken: connection.accessToken,
      scopes,
    },
    error: null,
  };
}


const SCOPE_MESSAGE =
  "Reconnect this number to enable the WhatsApp catalogue — the connection is missing catalogue permission.";

/** The business that owns the connected business account. */
async function resolveBusinessId(
  callCtx: CallArgs,
  wabaId: string,
  accessToken: string,
): Promise<{ businessId?: string; error?: string }> {
  const owner = await loggedGraph(callCtx, wabaId, accessToken, {
    query: { fields: "owner_business_info,on_behalf_of_business_info,name" },
  });
  if (!owner.ok) return { error: graphErrorMessage(owner.body) };
  const ownerInfo = (owner.body["owner_business_info"] ??
    owner.body["on_behalf_of_business_info"]) as { id?: string; name?: string } | undefined;
  if (!ownerInfo?.id) {
    return { error: "We couldn't read the business behind this number. Reconnect it and try again." };
  }
  return { businessId: ownerInfo.id };
}

export type BusinessCatalog = { id: string; name: string; product_count: number };

/** Catalogues the merchant's business already owns, so they can reuse one. */
export async function listBusinessCatalogs(args: {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string;
  whatsappAccountId: string | null;
}): Promise<{ ok: boolean; catalogs?: BusinessCatalog[]; error?: string }> {
  const { supabase, organizationId, userId } = args;
  const { ctx, error } = await resolveCatalogContext(
    supabase,
    organizationId,
    args.whatsappAccountId,
  );
  if (!ctx) return { ok: false, error: error ?? "This number isn't connected." };
  if (!hasCatalogScopes(ctx.scopes)) return { ok: false, error: SCOPE_MESSAGE };

  const callCtx: CallArgs = { supabase, organizationId, userId, wabaId: ctx.wabaId };
  const { businessId, error: bizError } = await resolveBusinessId(
    callCtx,
    ctx.wabaId,
    ctx.accessToken,
  );
  if (!businessId) return { ok: false, error: bizError ?? "We couldn't read the business behind this number." };

  const listed = await loggedGraph(
    callCtx,
    `${businessId}/owned_product_catalogs`,
    ctx.accessToken,
    { query: { fields: "name,product_count", limit: "50" } },
  );
  if (!listed.ok) return { ok: false, error: graphErrorMessage(listed.body) };
  const rows = (listed.body["data"] ?? []) as Array<Record<string, unknown>>;
  return {
    ok: true,
    catalogs: rows.map((r) => ({
      id: String(r["id"] ?? ""),
      name: String(r["name"] ?? "Catalogue"),
      product_count: Number(r["product_count"] ?? 0),
    })),
  };
}

/**
 * Enables the catalogue for a number. Either links a catalogue the merchant
 * already owns (mode 'linked' — we never write into it), or creates a new one
 * AiDwar manages (mode 'managed'). Idempotent: an existing row is returned
 * untouched.
 */
export async function enableCatalog(args: {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string;
  whatsappAccountId: string | null;
  businessName: string;
  useCatalogId?: string | null;
}): Promise<{
  ok: boolean;
  catalog_id?: string;
  created?: boolean;
  mode?: "managed" | "linked";
  error?: string;
}> {
  const { supabase, organizationId, userId } = args;
  const { ctx, error } = await resolveCatalogContext(
    supabase,
    organizationId,
    args.whatsappAccountId,
  );
  if (!ctx) return { ok: false, error: error ?? "This number isn't connected." };
  if (!hasCatalogScopes(ctx.scopes)) return { ok: false, error: SCOPE_MESSAGE };

  const existing = await getCatalogRow(supabase, organizationId, ctx.wabaId);
  if (existing) {
    return {
      ok: true,
      catalog_id: existing.catalog_id,
      created: false,
      mode: existing.mode ?? "managed",
    };
  }

  const callCtx: CallArgs = { supabase, organizationId, userId, wabaId: ctx.wabaId };
  const reuseId = (args.useCatalogId ?? "").trim();

  let catalogId = reuseId;
  let name: string | null = null;
  const mode: "managed" | "linked" = reuseId ? "linked" : "managed";

  if (reuseId) {
    // Confirm the catalogue exists and read its name for the card.
    const info = await loggedGraph(callCtx, reuseId, ctx.accessToken, {
      query: { fields: "name,product_count" },
    });
    if (!info.ok) return { ok: false, error: graphErrorMessage(info.body) };
    name = String(info.body["name"] ?? "Your catalogue");
  } else {
    const { businessId, error: bizError } = await resolveBusinessId(
      callCtx,
      ctx.wabaId,
      ctx.accessToken,
    );
    if (!businessId) return { ok: false, error: bizError ?? "We couldn't read the business behind this number." };

    name = `${args.businessName} — WhatsApp catalogue`;
    const created = await loggedGraph(
      callCtx,
      `${businessId}/owned_product_catalogs`,
      ctx.accessToken,
      { method: "POST", body: { name, vertical: "commerce" } },
    );
    if (!created.ok) return { ok: false, error: graphErrorMessage(created.body) };
    catalogId = String(created.body["id"] ?? "");
    if (!catalogId) return { ok: false, error: "Meta didn't return a catalogue id." };
  }

  // Link it to the business account so the number can use it.
  const linked = await loggedGraph(
    { ...callCtx, catalogId },
    `${ctx.wabaId}/product_catalogs`,
    ctx.accessToken,
    { method: "POST", body: { catalog_id: catalogId } },
  );

  await supabase.from("whatsapp_catalogs").upsert(
    {
      organization_id: organizationId,
      waba_id: ctx.wabaId,
      catalog_id: catalogId,
      catalog_name: name,
      mode,
      status: linked.ok ? "linked" : "created",
      last_error: linked.ok ? null : graphErrorMessage(linked.body),
    },
    { onConflict: "organization_id,waba_id" },
  );

  if (!linked.ok) {
    return {
      ok: false,
      catalog_id: catalogId,
      created: mode === "managed",
      mode,
      error: graphErrorMessage(linked.body),
    };
  }
  // A catalogue nobody can see is no use: turn on the shop button and the
  // cart for this number straight away. A failure here never fails Enable.
  await setCommerceSettings({
    supabase,
    organizationId,
    userId,
    whatsappAccountId: args.whatsappAccountId,
    isCatalogVisible: true,
    isCartEnabled: true,
  });

  return { ok: true, catalog_id: catalogId, created: mode === "managed", mode };
}

export type CommerceSettings = {
  is_catalog_visible: boolean;
  is_cart_enabled: boolean;
};

/** What the customer sees on this number: the shop button and the cart. */
export async function getCommerceSettings(args: {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string | null;
  whatsappAccountId: string | null;
}): Promise<{ ok: boolean; settings?: CommerceSettings; error?: string }> {
  const { supabase, organizationId, userId } = args;
  const { ctx, error } = await resolveCatalogContext(
    supabase,
    organizationId,
    args.whatsappAccountId,
  );
  if (!ctx) return { ok: false, error: error ?? "This number isn't connected." };

  const callCtx: CallArgs = { supabase, organizationId, userId, wabaId: ctx.wabaId };
  const result = await loggedGraph(
    callCtx,
    `${ctx.phoneNumberId}/whatsapp_commerce_settings`,
    ctx.accessToken,
  );
  if (!result.ok) return { ok: false, error: graphErrorMessage(result.body) };
  const row = ((result.body["data"] ?? []) as Array<Record<string, unknown>>)[0] ?? {};
  return {
    ok: true,
    settings: {
      is_catalog_visible: row["is_catalog_visible"] === true,
      is_cart_enabled: row["is_cart_enabled"] === true,
    },
  };
}

/** Turns the shop button and cart on or off for the connected number. */
export async function setCommerceSettings(args: {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string | null;
  whatsappAccountId: string | null;
  isCatalogVisible: boolean;
  isCartEnabled: boolean;
}): Promise<{ ok: boolean; settings?: CommerceSettings; error?: string }> {
  const { supabase, organizationId, userId } = args;
  const { ctx, error } = await resolveCatalogContext(
    supabase,
    organizationId,
    args.whatsappAccountId,
  );
  if (!ctx) return { ok: false, error: error ?? "This number isn't connected." };

  const callCtx: CallArgs = { supabase, organizationId, userId, wabaId: ctx.wabaId };
  const result = await loggedGraph(
    callCtx,
    `${ctx.phoneNumberId}/whatsapp_commerce_settings`,
    ctx.accessToken,
    {
      method: "POST",
      query: {
        is_catalog_visible: String(args.isCatalogVisible),
        is_cart_enabled: String(args.isCartEnabled),
      },
    },
  );
  if (!result.ok) return { ok: false, error: graphErrorMessage(result.body) };

  await supabase
    .from("whatsapp_catalogs")
    .update({
      is_catalog_visible: args.isCatalogVisible,
      is_cart_enabled: args.isCartEnabled,
    })
    .eq("organization_id", organizationId)
    .eq("waba_id", ctx.wabaId);

  return {
    ok: true,
    settings: {
      is_catalog_visible: args.isCatalogVisible,
      is_cart_enabled: args.isCartEnabled,
    },
  };
}


type ProductRow = {
  id: string;
  external_id: string | null;
  sku: string | null;
  title: string;
  description: string | null;
  price: number | null;
  currency: string | null;
  image_url: string | null;
  product_url: string | null;
  brand: string | null;
  category: string | null;
  availability: string;
};

function retailerId(row: ProductRow): string {
  return (row.external_id ?? row.sku ?? row.id).slice(0, 100);
}

function availabilityFor(value: string): string {
  if (value === "out_of_stock") return "out of stock";
  if (value === "preorder") return "preorder";
  return "in stock";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * items_batch is async: Meta returns handles, and the per-item errors only
 * appear once the batch is finished. Polls the handle (max ~10 tries, 2s
 * apart) and returns one message per rejected item.
 */
async function pollBatchStatus(
  callCtx: CallArgs,
  catalogId: string,
  handle: string,
  accessToken: string,
): Promise<{ errors: string[]; failedIds: string[] }> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (attempt > 0) await sleep(2000);
    const result = await loggedGraph(
      callCtx,
      `${catalogId}/check_batch_request_status`,
      accessToken,
      { query: { handle } },
    );
    if (!result.ok) return { errors: [graphErrorMessage(result.body)], failedIds: [] };
    const status = String(result.body["status"] ?? "").toLowerCase();
    const errors = (result.body["errors"] ?? []) as Array<{
      retailer_id?: string;
      message?: string;
    }>;
    if (status === "finished" || errors.length > 0) {
      return {
        errors: errors.map((e) => `${e.retailer_id ?? "item"}: ${e.message ?? "rejected"}`),
        failedIds: errors
          .map((e) => e.retailer_id)
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      };
    }
  }
  return { errors: [], failedIds: [] };
}


/** Pushes every visible product that has both a price and a picture. */
export async function syncCatalog(args: {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string;
  whatsappAccountId: string | null;
}): Promise<{
  ok: boolean;
  catalog_id?: string;
  eligible?: number;
  pushed?: number;
  rejected?: number;
  removed?: number;

  error?: string;
  rejections?: string[];
}> {
  const { supabase, organizationId, userId } = args;
  const { ctx, error } = await resolveCatalogContext(
    supabase,
    organizationId,
    args.whatsappAccountId,
  );
  if (!ctx) return { ok: false, error: error ?? "This number isn't connected." };
  if (!hasCatalogScopes(ctx.scopes)) return { ok: false, error: SCOPE_MESSAGE };

  const row = await getCatalogRow(supabase, organizationId, ctx.wabaId);
  if (!row) return { ok: false, error: "Create the catalogue first, then sync." };
  if (row.mode === "linked") {
    return {
      ok: false,
      error: "This is your own catalogue — AiDwar only reads it. Use Refresh instead.",
    };
  }

  const { data: products } = await supabase
    .from("products")
    .select(
      "id, external_id, sku, title, description, price, currency, image_url, product_url, brand, category, availability",
    )
    .eq("organization_id", organizationId)
    .eq("is_visible", true)
    .not("price", "is", null)
    .not("image_url", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1000);

  const rows = ((products ?? []) as ProductRow[]).filter(
    (p) => p.price != null && Boolean(p.image_url) && p.title.trim().length > 0,
  );
  const callCtx: CallArgs = {
    supabase,
    organizationId,
    userId,
    wabaId: ctx.wabaId,
    catalogId: row.catalog_id,
  };

  let pushed = 0;
  let rejected = 0;
  let removed = 0;
  const pushedIds: string[] = [];
  const rejections: string[] = [];
  const CHUNK = 100;


  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const requests = chunk.map((p) => ({
      method: "UPDATE",
      data: {
        id: retailerId(p),
        title: p.title.slice(0, 200),
        description: (p.description ?? p.title).slice(0, 9999),
        availability: availabilityFor(p.availability),
        condition: "new",
        price: `${Number(p.price).toFixed(2)} ${(p.currency ?? "INR").toUpperCase()}`,
        image_link: p.image_url,
        link: p.product_url ?? undefined,
        brand: p.brand ?? undefined,
        product_type: p.category ?? undefined,
      },
    }));

    const result = await loggedGraph(
      callCtx,
      `${row.catalog_id}/items_batch`,
      ctx.accessToken,
      { method: "POST", body: { item_type: "PRODUCT_ITEM", requests, allow_upsert: true } },
      chunk.length,
    );

    if (!result.ok) {
      rejected += chunk.length;
      rejections.push(graphErrorMessage(result.body));
      continue;
    }

    // items_batch is async: poll each handle until Meta finishes, then count
    // the per-item errors it reports as rejected.
    const handles = (result.body["handles"] ?? []) as string[];
    let failedCount = 0;
    const failedIds = new Set<string>();
    for (const handle of handles) {
      if (typeof handle !== "string" || !handle) continue;
      const status = await pollBatchStatus(callCtx, row.catalog_id, handle, ctx.accessToken);
      failedCount += status.errors.length;
      for (const id of status.failedIds) failedIds.add(id);
      for (const f of status.errors.slice(0, 5)) rejections.push(f);
    }
    failedCount = Math.min(failedCount, chunk.length);
    rejected += failedCount;
    pushed += chunk.length - failedCount;
    for (const p of chunk) {
      if (!failedIds.has(retailerId(p))) pushedIds.push(p.id);
    }
  }

  // Remember what is live in Meta's catalogue so the next sync can remove
  // anything that stopped being eligible on our side.
  if (pushedIds.length > 0) {
    const stamp = new Date().toISOString();
    for (let i = 0; i < pushedIds.length; i += 200) {
      await supabase
        .from("products")
        .update({ meta_synced_at: stamp })
        .eq("organization_id", organizationId)
        .in("id", pushedIds.slice(i, i + 200));
    }
  }

  // Anything previously pushed that is no longer eligible gets deleted from
  // the catalogue, then loses its marker.
  const liveIds = new Set(rows.map((p) => retailerId(p)));
  const { data: syncedBefore } = await supabase
    .from("products")
    .select("id, external_id, sku")
    .eq("organization_id", organizationId)
    .not("meta_synced_at", "is", null)
    .limit(2000);

  const stale = ((syncedBefore ?? []) as Array<{
    id: string;
    external_id: string | null;
    sku: string | null;
  }>)
    .map((p) => ({ id: p.id, retailer: (p.external_id ?? p.sku ?? p.id).slice(0, 100) }))
    .filter((p) => !liveIds.has(p.retailer));

  for (let i = 0; i < stale.length; i += CHUNK) {
    const chunk = stale.slice(i, i + CHUNK);
    const result = await loggedGraph(
      callCtx,
      `${row.catalog_id}/items_batch`,
      ctx.accessToken,
      {
        method: "POST",
        body: {
          item_type: "PRODUCT_ITEM",
          allow_upsert: true,
          requests: chunk.map((p) => ({ method: "DELETE", data: { id: p.retailer } })),
        },
      },
      chunk.length,
    );
    if (!result.ok) {
      rejections.push(graphErrorMessage(result.body));
      continue;
    }

    const handles = (result.body["handles"] ?? []) as string[];
    const failedIds = new Set<string>();
    for (const handle of handles) {
      if (typeof handle !== "string" || !handle) continue;
      const status = await pollBatchStatus(callCtx, row.catalog_id, handle, ctx.accessToken);
      for (const id of status.failedIds) failedIds.add(id);
      for (const f of status.errors.slice(0, 5)) rejections.push(f);
    }

    const clearedIds = chunk.filter((p) => !failedIds.has(p.retailer)).map((p) => p.id);
    if (clearedIds.length > 0) {
      await supabase
        .from("products")
        .update({ meta_synced_at: null })
        .eq("organization_id", organizationId)
        .in("id", clearedIds);
      removed += clearedIds.length;
    }
  }


  await supabase
    .from("whatsapp_catalogs")
    .update({
      last_sync_at: new Date().toISOString(),
      pushed_count: pushed,
      rejected_count: rejected,
      last_error: rejections[0] ?? null,
      status: "linked",
    })
    .eq("organization_id", organizationId)
    .eq("waba_id", ctx.wabaId);

  return {
    ok: true,
    catalog_id: row.catalog_id,
    eligible: rows.length,
    pushed,
    rejected,
    removed,

    rejections: rejections.slice(0, 5),
  };
}

type MetaItem = {
  retailer_id?: string;
  name?: string;
  price?: string;
  image_url?: string;
  url?: string;
  availability?: string;
};

function parsePrice(value: string | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/[^\d.]/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function currencyOf(value: string | undefined): string {
  if (value && /[A-Z]{3}/.test(value)) return (value.match(/[A-Z]{3}/) ?? ["INR"])[0];
  return "INR";
}

function availabilityOf(value: string | undefined): string {
  const v = (value ?? "").toLowerCase();
  if (v.includes("out of stock")) return "out_of_stock";
  if (v.includes("preorder")) return "preorder";
  return "in_stock";
}

/**
 * Reads a merchant-owned catalogue into our products table so Aiden can search
 * it and send its items as product cards. Never writes to Meta.
 */
export async function refreshLinkedCatalog(args: {
  supabase: SupabaseClient;
  organizationId: string;
  userId: string;
  whatsappAccountId: string | null;
}): Promise<{ ok: boolean; catalog_id?: string; imported?: number; error?: string }> {
  const { supabase, organizationId, userId } = args;
  const { ctx, error } = await resolveCatalogContext(
    supabase,
    organizationId,
    args.whatsappAccountId,
  );
  if (!ctx) return { ok: false, error: error ?? "This number isn't connected." };
  if (!hasCatalogScopes(ctx.scopes)) return { ok: false, error: SCOPE_MESSAGE };

  const row = await getCatalogRow(supabase, organizationId, ctx.wabaId);
  if (!row) return { ok: false, error: "Link a catalogue first, then refresh." };

  const callCtx: CallArgs = {
    supabase,
    organizationId,
    userId,
    wabaId: ctx.wabaId,
    catalogId: row.catalog_id,
  };

  const startedAt = new Date().toISOString();
  const items: MetaItem[] = [];
  let path = `${row.catalog_id}/products`;
  let query: Record<string, string> | undefined = {
    fields: "retailer_id,name,price,image_url,url,availability",
    limit: "100",
  };

  for (let page = 0; page < 20; page += 1) {
    const result: Awaited<ReturnType<typeof loggedGraph>> = await loggedGraph(
      callCtx,
      path,
      ctx.accessToken,
      query ? { query } : {},
    );
    if (!result.ok) {
      const message = graphErrorMessage(result.body);
      await supabase
        .from("whatsapp_catalogs")
        .update({ last_error: message })
        .eq("organization_id", organizationId)
        .eq("waba_id", ctx.wabaId);
      return { ok: false, error: message };
    }
    items.push(...((result.body["data"] ?? []) as MetaItem[]));
    const next = (
      (result.body["paging"] ?? {}) as { next?: string; cursors?: { after?: string } }
    ).cursors?.after;
    const hasNext = Boolean((result.body["paging"] as { next?: string } | undefined)?.next);
    if (!hasNext || !next) break;
    path = `${row.catalog_id}/products`;
    query = {
      fields: "retailer_id,name,price,image_url,url,availability",
      limit: "100",
      after: next,
    };
  }

  let imported = 0;
  for (const item of items) {
    const retailerId = (item.retailer_id ?? "").trim();
    const title = (item.name ?? "").trim();
    if (!retailerId || !title) continue;

    const productRow = {
      organization_id: organizationId,
      source: "meta_catalog",
      external_id: retailerId,
      title: title.slice(0, 200),
      price: parsePrice(item.price),
      currency: currencyOf(item.price),
      image_url: item.image_url ?? null,
      product_url: item.url ?? null,
      availability: availabilityOf(item.availability),
      is_visible: true,
      synced_at: startedAt,
      updated_at: startedAt,
    };

    const { data: existing } = await supabase
      .from("products")
      .select("id, source")
      .eq("organization_id", organizationId)
      .eq("external_id", retailerId)
      .maybeSingle();
    const prior = existing as { id: string; source: string } | null;
    if (prior) {
      // A product another source owns is never overwritten by the catalogue read.
      if (prior.source !== "meta_catalog") continue;
      const { error: updateError } = await supabase
        .from("products")
        .update(productRow)
        .eq("id", prior.id);
      if (!updateError) imported += 1;
    } else {
      const { error: insertError } = await supabase.from("products").insert(productRow);
      if (!insertError) imported += 1;
    }
  }

  // Items no longer in the catalogue stop being offered.
  await supabase
    .from("products")
    .update({ is_visible: false })
    .eq("organization_id", organizationId)
    .eq("source", "meta_catalog")
    .eq("is_visible", true)
    .lt("synced_at", startedAt);

  await supabase
    .from("whatsapp_catalogs")
    .update({
      last_sync_at: new Date().toISOString(),
      pushed_count: imported,
      rejected_count: 0,
      last_error: null,
      status: "linked",
    })
    .eq("organization_id", organizationId)
    .eq("waba_id", ctx.wabaId);

  return { ok: true, catalog_id: row.catalog_id, imported };
}

/**
 * Sends the products that are live in this number's catalogue as real
 * catalogue cards. Returns how many went out; 0 means the caller should fall
 * back to plain pictures.
 */
export async function sendCatalogProducts(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    conversationId: string;
    phoneNumberId: string;
    accessToken: string;
    to: string;
    items: Array<{
      retailerId: string | null;
      title: string;
      category: string | null;
      inCatalog: boolean;
    }>;
  },
): Promise<{ sent: number; error: string | null }> {
  const eligible = args.items.filter(
    (i) => i.inCatalog && typeof i.retailerId === "string" && i.retailerId.length > 0,
  );
  if (eligible.length === 0) return { sent: 0, error: null };

  const { data: account } = await supabase
    .from("whatsapp_accounts")
    .select("waba_id")
    .eq("organization_id", args.organizationId)
    .eq("phone_number_id", args.phoneNumberId)
    .maybeSingle();
  const wabaId = (account as { waba_id?: string } | null)?.waba_id;
  if (!wabaId) return { sent: 0, error: null };

  const { data: catalog } = await supabase
    .from("whatsapp_catalogs")
    .select("catalog_id, status, is_catalog_visible")
    .eq("organization_id", args.organizationId)
    .eq("waba_id", wabaId)
    .maybeSingle();
  const row = catalog as
    | { catalog_id: string; status: string; is_catalog_visible: boolean | null }
    | null;
  if (!row || row.status !== "linked" || row.is_catalog_visible === false) {
    return { sent: 0, error: null };
  }

  const { sendServiceProducts } = await import("@/lib/service-text.server");
  const items = eligible.slice(0, 30).map((i) => ({
    retailerId: i.retailerId as string,
    title: i.title,
    section: i.category ?? "Products",
  }));

  const result = await sendServiceProducts(supabase, {
    organizationId: args.organizationId,
    phoneNumberId: args.phoneNumberId,
    accessToken: args.accessToken,
    conversationId: args.conversationId,
    to: args.to,
    catalogId: row.catalog_id,
    header: "Have a look",
    body:
      items.length === 1
        ? "Here's the one I'd show you — tap it for the full details."
        : "Here's what I have for you — tap any one to see it in full.",
    items,
  });

  if (!result.ok) return { sent: 0, error: result.error };

  await logServerActivity(supabase, args.organizationId, null, "whatsapp_catalog_products_sent", {
    catalog_id: row.catalog_id,
    conversation_id: args.conversationId,
    count: items.length,
  });

  return { sent: items.length, error: null };
}
