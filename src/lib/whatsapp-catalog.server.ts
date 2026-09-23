import type { SupabaseClient } from "@supabase/supabase-js";
import { graphFetch, graphErrorMessage, providerErrorDetail } from "@/lib/whatsapp-api.server";
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
      "catalog_id, catalog_name, status, mode, last_sync_at, pushed_count, rejected_count, last_error",
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
    ctx: { wabaId: connection.wabaId, accessToken: connection.accessToken, scopes },
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
  if (!businessId) return { ok: false, error: bizError };

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
    if (!businessId) return { ok: false, error: bizError };

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
  return { ok: true, catalog_id: catalogId, created: mode === "managed", mode };
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
  if (rows.length === 0) {
    return { ok: true, catalog_id: row.catalog_id, eligible: 0, pushed: 0, rejected: 0 };
  }

  const callCtx: CallArgs = {
    supabase,
    organizationId,
    userId,
    wabaId: ctx.wabaId,
    catalogId: row.catalog_id,
  };

  let pushed = 0;
  let rejected = 0;
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
        price: Math.round(Number(p.price) * 100),
        currency: (p.currency ?? "INR").toUpperCase(),
        image_url: p.image_url,
        url: p.product_url ?? undefined,
        brand: p.brand ?? undefined,
        ...(p.category ? { google_product_category: undefined, product_type: p.category } : {}),
      },
    }));

    const result = await loggedGraph(
      callCtx,
      `${row.catalog_id}/batch`,
      ctx.accessToken,
      { method: "POST", body: { item_type: "PRODUCT_ITEM", requests, allow_upsert: true } },
      chunk.length,
    );

    if (!result.ok) {
      rejected += chunk.length;
      rejections.push(graphErrorMessage(result.body));
      continue;
    }

    const validation = (result.body["validation_status"] ?? []) as Array<{
      retailer_id?: string;
      errors?: Array<{ message?: string }>;
    }>;
    const failed = validation.filter((v) => (v.errors ?? []).length > 0);
    for (const f of failed.slice(0, 5)) {
      rejections.push(`${f.retailer_id ?? "item"}: ${f.errors?.[0]?.message ?? "rejected"}`);
    }
    rejected += failed.length;
    pushed += chunk.length - failed.length;
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
    rejections: rejections.slice(0, 5),
  };
}
