import type { SupabaseClient } from "@supabase/supabase-js";
import { allAiTools, type AiTool } from "@/lib/feature-registry";
import { resolveEffectivePermissions } from "@/lib/permissions.server";
import { evaluateSegment } from "@/lib/segments.server";
import { normalizePhone, toWaId } from "@/lib/phone";

/**
 * The AI tool broker.
 *
 * Two rules hold everywhere in this file:
 *  1. organization_id is bound by the broker from the acting context. A model
 *     can never supply it, so a tool can never read another workspace.
 *  2. Anything scoped to one number takes whatsapp_account_id explicitly and
 *     the broker validates it against the acting organization. The default
 *     number is never inferred — in a workspace with three numbers the model
 *     has to say which one it means.
 */

/**
 * Who is acting. A person carries their own permissions; the agent acting on
 * its own carries the workspace's configured AI role. There is no third case:
 * a null principal used to mean "no permissions at all", which silently
 * starved the agent of every tool.
 */
export type ToolPrincipal =
  | { kind: "user"; userId: string }
  | { kind: "agent" };

export const agentPrincipal: ToolPrincipal = { kind: "agent" };
export const userPrincipal = (userId: string): ToolPrincipal => ({ kind: "user", userId });

export type ToolContext = {
  supabase: SupabaseClient;
  organizationId: string;
  /** Null when the agent itself is acting. */
  actorUserId: string | null;
  /** Whose permissions this call runs under. Defaults from actorUserId. */
  principal?: ToolPrincipal;
  /** Who started this call — a person clicking, or a model deciding. */
  initiatedBy: "human" | "ai";
};

/** The principal a context runs as, falling back to its user (or the agent). */
export function contextPrincipal(ctx: ToolContext): ToolPrincipal {
  if (ctx.principal) return ctx.principal;
  return ctx.actorUserId ? userPrincipal(ctx.actorUserId) : agentPrincipal;
}


export type ToolArgs = Record<string, unknown>;
export type ToolResult = {
  /** True when the tool executed. Finding nothing is still a success. */
  ok: boolean;
  /**
   * False when the tool ran fine but there was nothing to return. The agent
   * must answer this in plain words, never escalate on it.
   */
  found?: boolean;
  data?: unknown;
  error?: string;
  /** Set by invokeTool: the activity_log row this invocation wrote. */
  activityLogId?: string | null;
  /** Set by invokeTool: wall-clock time of the invocation. */
  latencyMs?: number;
  /** Set by invokeTool: the arguments the model supplied, minus organization_id. */
  arguments?: Record<string, unknown>;
  /** Set by invokeTool: row count plus up to five identifiers. Never a data copy. */
  resultSummary?: Record<string, unknown>;
};


type Handler = (ctx: ToolContext, args: ToolArgs) => Promise<ToolResult>;

/** A successful lookup that found nothing — never a failure. */
const empty = (message: string): ToolResult => ({
  ok: true,
  found: false,
  data: { found: false, message },
});

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/** Resolve a number the model named, refusing anything outside this workspace. */
async function requireAccount(
  ctx: ToolContext,
  args: ToolArgs,
): Promise<{ account: Record<string, unknown> | null; error: string | null }> {
  const id = str(args["whatsapp_account_id"]);
  if (!id) {
    return {
      account: null,
      error:
        "whatsapp_account_id is required. Call list_connected_numbers and ask the user which number they mean.",
    };
  }
  const { data } = await ctx.supabase
    .from("whatsapp_accounts")
    .select(
      "id, organization_id, display_phone_number, verified_name, label, waba_id, phone_number_id, status, quality_rating, quality_updated_at, is_default",
    )
    .eq("id", id)
    .eq("organization_id", ctx.organizationId)
    .maybeSingle();
  if (!data) return { account: null, error: "That number is not connected to this workspace." };
  return { account: data as Record<string, unknown>, error: null };
}

async function findContact(ctx: ToolContext, args: ToolArgs) {
  const raw = str(args["phone"]);
  if (!raw) return { contact: null, error: "phone is required." };
  const phone = normalizePhone(raw);
  const waId = toWaId(raw);
  const { data } = await ctx.supabase
    .from("contacts")
    .select(
      "id, name, phone, wa_id, opt_in_status, source, source_detail, attributes, created_at, updated_at",
    )
    .eq("organization_id", ctx.organizationId)
    .or(`phone.eq.${phone},wa_id.eq.${waId ?? phone}`)
    .limit(1)
    .maybeSingle();
  if (!data) return { contact: null, error: "No contact with that number in this workspace." };
  return { contact: data as Record<string, unknown>, error: null };
}

/**
 * Handler implementations. Every `handler` named in a manifest must exist here
 * — the build check fails otherwise.
 */
export const AI_TOOL_HANDLERS: Record<string, Handler> = {
  async lookupContact(ctx, args) {
    const { contact, error } = await findContact(ctx, args);
    if (!contact) return empty(error ?? "I couldn't find that contact in this workspace.");
    const { data: tagRows } = await ctx.supabase
      .from("contact_tags")
      .select("tags(name)")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contact["id"] as string);
    const tags = ((tagRows ?? []) as Array<{ tags?: { name?: string } | null }>)
      .map((r) => r.tags?.name)
      .filter(Boolean);
    return { ok: true, data: { ...contact, tags } };
  },

  async checkOptOutStatus(ctx, args) {
    const { contact, error } = await findContact(ctx, args);
    if (!contact) return empty(error ?? "I couldn't find that contact in this workspace.");
    const status = String(contact["opt_in_status"] ?? "unknown");
    return {
      ok: true,
      data: {
        contact_id: contact["id"],
        opt_in_status: status,
        messageable: status !== "opted_out",
        // Opt-out is a workspace-wide block, never per number.
        scope: "organization",
      },
    };
  },

  async listSegments(ctx) {
    const { data } = await ctx.supabase
      .from("segments")
      .select("id, name, description, filters, created_at")
      .eq("organization_id", ctx.organizationId)
      .order("created_at", { ascending: false })
      .limit(50);
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const withSizes = [];
    for (const row of rows) {
      const evaluation = await evaluateSegment(ctx.supabase, ctx.organizationId, row["filters"]);
      withSizes.push({
        id: row["id"],
        name: row["name"],
        description: row["description"],
        contact_count: evaluation.count,
      });
    }
    return { ok: true, data: withSizes };
  },

  async searchConversationHistory(ctx, args) {
    const { contact, error } = await findContact(ctx, args);
    if (!contact) return empty(error ?? "I couldn't find that contact in this workspace.");
    const limit = Math.min(Math.max(num(args["limit"], 20), 1), 50);
    const { data: conversations } = await ctx.supabase
      .from("conversations")
      .select("id, whatsapp_account_id, status, last_message_at")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contact["id"] as string);
    const ids = ((conversations ?? []) as Array<{ id: string }>).map((c) => c.id);
    if (!ids.length) return { ok: true, data: { messages: [] } };

    let query = ctx.supabase
      .from("messages")
      .select("id, conversation_id, direction, type, body, status, created_at")
      .eq("organization_id", ctx.organizationId)
      .in("conversation_id", ids)
      .order("created_at", { ascending: false })
      .limit(limit);
    const search = str(args["query"]);
    if (search) query = query.ilike("body", `%${search}%`);
    const { data: messages } = await query;
    return { ok: true, data: { conversations, messages: messages ?? [] } };
  },

  async getCampaignStatus(ctx, args) {
    const id = str(args["campaign_id"]);
    const name = str(args["name"]);
    if (!id && !name) return { ok: false, error: "Give either campaign_id or name." };
    let query = ctx.supabase
      .from("campaigns")
      .select("*")
      .eq("organization_id", ctx.organizationId)
      .limit(1);
    query = id ? query.eq("id", id) : query.ilike("name", `%${name}%`);
    const { data } = await query.maybeSingle();
    if (!data) return empty("I couldn't find a campaign matching that.");
    return { ok: true, data };
  },

  async listApprovedTemplates(ctx, args) {
    const { account, error } = await requireAccount(ctx, args);
    if (!account) return { ok: false, error: error ?? "Unknown number." };
    const { data } = await ctx.supabase
      .from("message_templates")
      .select("id, name, language, category, status, waba_id")
      .eq("organization_id", ctx.organizationId)
      .eq("waba_id", account["waba_id"] as string)
      .eq("status", "APPROVED")
      .order("name", { ascending: true });
    return {
      ok: true,
      data: { whatsapp_account_id: account["id"], templates: data ?? [] },
    };
  },

  async checkNumberQuality(ctx, args) {
    const { account, error } = await requireAccount(ctx, args);
    if (!account) return { ok: false, error: error ?? "Unknown number." };
    const { data: history } = await ctx.supabase
      .from("whatsapp_quality_history")
      .select("quality_rating, recorded_at")
      .eq("organization_id", ctx.organizationId)
      .eq("phone_number_id", account["phone_number_id"] as string)
      .order("recorded_at", { ascending: false })
      .limit(10);
    return {
      ok: true,
      data: {
        whatsapp_account_id: account["id"],
        display_phone_number: account["display_phone_number"],
        status: account["status"],
        quality_rating: account["quality_rating"],
        quality_updated_at: account["quality_updated_at"],
        recent_history: history ?? [],
      },
    };
  },

  async listActiveAutomations(ctx) {
    const { data } = await ctx.supabase
      .from("automations")
      .select("id, name, trigger_type, priority, is_active, updated_at")
      .eq("organization_id", ctx.organizationId)
      .eq("is_active", true)
      .order("priority", { ascending: true });
    return { ok: true, data: data ?? [] };
  },

  async listConnectedNumbers(ctx) {
    const { data } = await ctx.supabase
      .from("whatsapp_accounts")
      .select(
        "id, display_phone_number, verified_name, label, waba_id, status, quality_rating, is_default",
      )
      .eq("organization_id", ctx.organizationId)
      .order("is_default", { ascending: false });
    return { ok: true, data: data ?? [] };
  },

  async lookupOrder(ctx, args) {
    const orderNumber = str(args["order_number"]);
    const phone = str(args["phone"]);
    if (!orderNumber && !phone) return { ok: false, error: "Give an order_number or a phone." };

    let query = ctx.supabase
      .from("orders")
      .select(
        "id, order_number, financial_status, fulfillment_status, is_cod, currency, total, placed_at, cancelled_at, fulfilled_at, delivered_at, contact_id",
      )
      .eq("organization_id", ctx.organizationId)
      .order("placed_at", { ascending: false })
      .limit(1);

    if (orderNumber) {
      const withHash = orderNumber.startsWith("#") ? orderNumber : `#${orderNumber}`;
      query = query.in("order_number", [orderNumber, withHash]);
    } else {
      const { contact } = await findContact(ctx, args);
      if (!contact) return empty("I couldn't find a contact with that number in this workspace.");
      query = query.eq("contact_id", contact["id"] as string);
    }

    const { data } = await query.maybeSingle();
    if (!data) return empty("I couldn't find a matching order in this workspace.");

    const order = data as Record<string, unknown>;
    const { data: items } = await ctx.supabase
      .from("order_items")
      .select("title, quantity, price")
      .eq("order_id", order["id"] as string);
    return { ok: true, data: { ...order, items: items ?? [] } };
  },

  async getCustomerOrders(ctx, args) {
    const { contact, error } = await findContact(ctx, args);
    if (!contact) return empty(error ?? "I couldn't find that contact in this workspace.");
    const limit = Math.min(Math.max(num(args["limit"], 5), 1), 20);
    const { data } = await ctx.supabase
      .from("orders")
      .select(
        "id, order_number, financial_status, fulfillment_status, is_cod, currency, total, placed_at, cancelled_at",
      )
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contact["id"] as string)
      .order("placed_at", { ascending: false })
      .limit(limit);
    return { ok: true, data: { contact_id: contact["id"], orders: data ?? [] } };
  },

  async getAbandonedCheckout(ctx, args) {
    const { contact, error } = await findContact(ctx, args);
    if (!contact) return empty(error ?? "I couldn't find that contact in this workspace.");
    const { data } = await ctx.supabase
      .from("abandoned_checkouts")
      .select("id, checkout_url, total, currency, abandoned_at, recovered_at")
      .eq("organization_id", ctx.organizationId)
      .eq("contact_id", contact["id"] as string)
      .is("recovered_at", null)
      .order("abandoned_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return empty("That customer has no open abandoned checkout.");
    return { ok: true, data };
  },

  async catalogSearch(ctx, args) {
    const query = str(args["query"]);
    const limit = Math.min(Math.max(num(args["limit"], 10), 1), 25);

    const { toTsQuery, isAvailability } = await import("@/lib/catalog");
    const tsquery = query ? toTsQuery(query) : "";

    let request = ctx.supabase
      .from("products")
      .select(
        "id, title, sku, brand, category, price, compare_at_price, currency, availability, inventory_quantity, product_url, image_url",
      )
      .eq("organization_id", ctx.organizationId)
      // Hidden products never reach a customer, whether searching or browsing.
      .eq("is_visible", true)
      .limit(limit);

    if (query) {
      // Full-text when the words are searchable, a plain contains match otherwise.
      request = tsquery
        ? request.textSearch("search_vector", tsquery)
        : request.ilike("title", `%${query.replace(/[%,()]/g, " ").trim()}%`);
    } else {
      // Browse case: what's in stock, most recently touched first.
      request = request
        .order("availability", { ascending: true })
        .order("updated_at", { ascending: false });
    }

    const maxPrice = args["max_price"];
    if (typeof maxPrice === "number" && Number.isFinite(maxPrice)) {
      request = request.lte("price", maxPrice);
    }
    const availability = args["availability"];
    if (isAvailability(availability)) request = request.eq("availability", availability);
    const category = str(args["category"]);
    if (category) request = request.ilike("category", `%${category}%`);

    const { data, error } = await request;
    if (error) return { ok: false, error: error.message };
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    // "in_stock" sorts before "out_of_stock"/"preorder" alphabetically except
    // preorder, so put in_stock first explicitly for the browse case.
    const ordered = query
      ? rows
      : [...rows].sort(
          (a, b) =>
            Number(b["availability"] === "in_stock") - Number(a["availability"] === "in_stock"),
        );
    // A search that matches nothing still ran: ok, just empty.
    return { ok: true, found: ordered.length > 0, data: ordered };
  },


  async searchProducts(ctx, args) {
    const query = str(args["query"]);
    if (!query) return { ok: false, error: "query is required." };
    const limit = Math.min(Math.max(num(args["limit"], 5), 1), 20);
    const safe = query.replace(/[%,()]/g, " ").trim();
    const { data } = await ctx.supabase
      .from("products")
      .select("id, title, price, currency, status, product_url, image_url")
      .eq("organization_id", ctx.organizationId)
      .ilike("title", `%${safe}%`)
      .limit(limit);
    return { ok: true, data: data ?? [] };
  },
};

/** Flag state for one organization, resolved exactly like the client hook. */
export async function enabledFlags(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<Set<string>> {
  const [{ data: flags }, { data: overrides }] = await Promise.all([
    supabase.from("feature_flags").select("key, default_enabled"),
    supabase
      .from("organization_feature_overrides")
      .select("flag_key, enabled")
      .eq("organization_id", organizationId),
  ]);
  const state = new Map<string, boolean>();
  for (const f of (flags ?? []) as Array<{ key: string; default_enabled: boolean }>) {
    state.set(f.key, f.default_enabled);
  }
  for (const o of (overrides ?? []) as Array<{ flag_key: string; enabled: boolean }>) {
    state.set(o.flag_key, o.enabled);
  }
  return new Set(Array.from(state.entries()).filter(([, on]) => on).map(([k]) => k));
}

export type BrokeredTool = AiTool & { feature: string };

/**
 * The tools this actor may actually call: feature flag on, permission held,
 * handler implemented. Everything else is invisible to the model.
 */
export async function brokerTools(
  supabase: SupabaseClient,
  organizationId: string,
  actorUserId: string | null,
): Promise<BrokeredTool[]> {
  const [flags, permissions] = await Promise.all([
    enabledFlags(supabase, organizationId),
    actorUserId
      ? resolveEffectivePermissions(supabase, organizationId, actorUserId)
      : Promise.resolve({ keys: [] as string[], role: null, isSuperAdmin: false, overrides: {} }),
  ]);
  if (!flags.has("ai_features")) return [];
  const held = new Set(permissions.keys);
  if (!held.has("ai.use")) return [];

  return allAiTools()
    .filter((t) => flags.has(t.flag_key))
    .filter((t) => held.has(t.required_permission))
    .filter((t) => Boolean(AI_TOOL_HANDLERS[t.handler]))
    .map(({ flag_key: _flag, ...tool }) => tool);
}

/** Write tools are capped per organization per hour; reads are unmetered. */
const WRITE_RATE_LIMIT_PER_HOUR = 60;

async function writeRateLimited(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from("activity_log")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .eq("action", "ai_tool_invoked")
    .gte("created_at", since);
  return (count ?? 0) >= WRITE_RATE_LIMIT_PER_HOUR;
}

export type InvokeOptions = {
  /** Set by the caller once a human has approved a confirmation-gated tool. */
  confirmed?: boolean;
};

/**
 * A debugging fingerprint of a tool result: how many rows and up to five
 * identifiers. Never a copy of the data, never personal details.
 */
function summarise(result: ToolResult): Record<string, unknown> {
  const label = (row: unknown): string | null => {
    if (row === null || typeof row !== "object") return null;
    const r = row as Record<string, unknown>;
    for (const key of ["title", "name", "order_number", "id"]) {
      const value = r[key];
      if (typeof value === "string" && value) return value.slice(0, 80);
    }
    return null;
  };
  const rows = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
  return {
    ok: result.ok,
    ...(result.found === false ? { found: false } : {}),
    row_count: rows.length,
    identifiers: rows.map(label).filter(Boolean).slice(0, 5),
    ...(result.error ? { error: result.error.slice(0, 200) } : {}),
  };
}

/**

 * Invoke one tool. Every invocation is logged to activity_log with the tool
 * name, the arguments the model supplied, the result status and whether a
 * human or an AI initiated it. Arguments never carry organization_id: it is
 * bound here.
 */
export async function invokeTool(
  ctx: ToolContext,
  toolName: string,
  args: ToolArgs,
  options: InvokeOptions = {},
): Promise<ToolResult> {
  const startedAt = Date.now();
  const available = await brokerTools(ctx.supabase, ctx.organizationId, ctx.actorUserId);
  const tool = available.find((t) => t.name === toolName);

  /** Returns the activity_log row id so the caller can join a run to its trace. */
  const log = async (status: string, detail?: string): Promise<string | null> => {
    const { organization_id: _org, ...safeArgs } = args as Record<string, unknown>;
    try {
      const { data } = await ctx.supabase
        .from("activity_log")
        .insert({
          organization_id: ctx.organizationId,
          user_id: ctx.actorUserId,
          action: "ai_tool_invoked",
          details: {
            tool: toolName,
            arguments: safeArgs,
            status,
            initiated_by: ctx.initiatedBy,
            ...(detail ? { detail } : {}),
          },
        })
        .select("id")
        .maybeSingle();
      return (data as { id?: string } | null)?.id ?? null;
    } catch {
      return null;
    }
  };

  const { organization_id: _boundOrg, ...safeArguments } = args as Record<string, unknown>;

  const done = (result: ToolResult, activityLogId: string | null): ToolResult => ({
    ...result,
    activityLogId,
    latencyMs: Date.now() - startedAt,
    arguments: safeArguments,
    resultSummary: summarise(result),
  });


  if (!tool) {
    const logId = await log("denied", "not_available");
    return done(
      { ok: false, error: "That tool isn't available to you in this workspace." },
      logId,
    );
  }

  if (tool.access === "write") {
    if (tool.requires_confirmation && !options.confirmed) {
      const logId = await log("needs_confirmation");
      return done({ ok: false, error: "This action needs to be confirmed by a person first." }, logId);
    }
    if (await writeRateLimited(ctx.supabase, ctx.organizationId)) {
      const logId = await log("rate_limited");
      return done(
        { ok: false, error: "Too many AI actions in this workspace right now. Try again later." },
        logId,
      );
    }
  }

  try {
    const result = await AI_TOOL_HANDLERS[tool.handler]!(ctx, args);
    const status = result.ok ? (result.found === false ? "not_found" : "ok") : "error";
    const logId = await log(status, result.ok ? undefined : result.error);
    return done(result, logId);
  } catch (err) {
    const logId = await log(
      "error",
      err instanceof Error ? err.message.slice(0, 200) : "handler_failed",
    );
    return done({ ok: false, error: "That tool failed to run." }, logId);
  }
}
