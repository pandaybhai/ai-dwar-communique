import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { PREVIEW_REFUSALS, issueConfirmCode, stateHash, verifyConfirmCode, type ConfirmAction } from "@/lib/mcp-confirm.server";
import {
  MAX_PAGE,
  denied,
  done,
  fail,
  link,
  money,
  nextCursor,
  page,
  pageArgs,
  resolveTagIds,
  variableInput,
  workspaceArg,
  type ToolContext,
  type ToolDef,
  type ToolOutcome,
} from "@/lib/mcp-tools.server";

/**
 * Batch 54: AiDwar MCP tools, round 2. Same rules as Batch 52 (the server,
 * auth, workspace, kill switch, mcp.use, rate limits and audit are runTool's):
 * every tool checks the permission the app's own screen or route checks, and
 * every write goes through the app's own function:
 *
 *   list_products              catalogue read (the Catalogue screen's filters), catalog.view
 *   get_campaign_sales         readCampaignSales (the campaign screen's "Sales from this
 *                              campaign"), campaigns.view + analytics.view + revenue_attribution
 *   create_template_draft      validateDraft (the template builder's), templates.manage — saves nothing
 *   submit_template            createTemplateFromDraft (the Templates page's create), templates.manage
 *   preview_campaign_change    reads only, campaigns.send
 *   update_scheduled_campaign  launchCampaign (new time / audience / values) then cancelCampaign
 *                              on the old one — both the app's own, campaigns.send
 *   cancel_scheduled_campaign  cancelCampaign (the Cancel button's), campaigns.send
 *   tag_contacts               the bulk "Add tag" write (tagLinks + contact_tags upsert), contacts.edit
 *   list_aiden_questions       pending_owner_replies (the Unanswered list's read), ai.use
 *   answer_aiden_question      answerGap (/api/ai/knowledge answer_gap), ai.use + ai.configure
 *
 * Changes need a confirm_code from a preview (HMAC-bound to user, workspace,
 * object, action and a hash of the exact request and what it applies to;
 * 15 minutes; works once because the object leaves the state it was
 * previewed in). Never here: a free-text message to a customer of the
 * assistant's own, Aiden's mode, billing, team, keys, settings or deletes.
 */

const CODE_ACTIONS = {
  template: "submit_template",
  update: "update_campaign",
  cancel: "cancel_campaign",
  tag: "tag_contacts",
  answer: "answer_question",
} as const satisfies Record<string, ConfirmAction>;

async function code(ctx: ToolContext, objectId: string, action: ConfirmAction, state: unknown) {
  return issueConfirmCode(
    { userId: ctx.caller.userId, workspaceId: ctx.workspace.id, objectId, action, stateHash: await stateHash(state) },
    ctx.now(),
    ...(ctx.confirmSecret ? [ctx.confirmSecret] : []),
  );
}

async function checkCode(ctx: ToolContext, given: unknown, objectId: string, action: ConfirmAction, state: unknown): Promise<ToolOutcome | null> {
  const check = await verifyConfirmCode(
    given,
    { userId: ctx.caller.userId, workspaceId: ctx.workspace.id, objectId, action, stateHash: await stateHash(state) },
    ctx.now(),
    ...(ctx.confirmSecret ? [ctx.confirmSecret] : []),
  );
  return check.ok ? null : fail(PREVIEW_REFUSALS[check.reason]);
}

const mcpDetails = (ctx: ToolContext, tool: string) => ({
  source: "mcp",
  tool,
  client_id: ctx.caller.clientId,
  client_name: ctx.caller.clientName,
});

/** Strips PostgREST filter syntax from free text. */
const plain = (v: unknown, max = 80) =>
  String(v ?? "")
    .trim()
    .replace(/[%_,()*\\]/g, "")
    .slice(0, max);

// ---------------------------------------------------------------------------
// list_products
// ---------------------------------------------------------------------------

type ProductRow = {
  id: string;
  title: string;
  category: string | null;
  price: number | null;
  compare_at_price: number | null;
  currency: string | null;
  availability: string | null;
  inventory_quantity: number | null;
  image_url: string | null;
  product_url: string | null;
  is_visible: boolean | null;
};

const listProducts: ToolDef = {
  name: "list_products",
  title: "List products",
  description: `The workspace's catalogue (Shop): each product's name, price, stock and availability, picture link, product link and collections. Search by words in the name/description, or filter by a collection (name or id) or availability. At most ${MAX_PAGE} per page. Good for "draft a campaign for my newest products" (newest first).`,
  input: {
    ...workspaceArg,
    search: z.string().max(80).optional().describe("Words in the product's name, SKU, description or category."),
    collection: z.string().max(120).optional().describe("A collection's name or id."),
    availability: z.enum(["in_stock", "out_of_stock", "preorder"]).optional(),
    ...pageArgs,
  },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "catalog.view", "see the catalogue");
    if (d) return d;
    const org = ctx.workspace.id;
    const { limit, offset } = page(args);
    const { NOT_ARCHIVED_DUPLICATE, toTsQuery } = await import("@/lib/catalog");

    const { data: cols } = await ctx.user.from("product_collections").select("id, name").eq("organization_id", org);
    const collections = (cols ?? []) as Array<{ id: string; name: string }>;
    let productIds: string[] | null = null;
    if (args["collection"]) {
      const want = String(args["collection"]).trim();
      const hit = collections.find((c) => c.id === want) ?? collections.find((c) => c.name.toLowerCase() === want.toLowerCase());
      if (!hit)
        return fail(`No collection called "${want}" in ${ctx.workspace.name}.${collections.length ? ` Collections: ${collections.map((c) => c.name).join(", ")}.` : ""}`);
      const { data: items } = await ctx.user.from("product_collection_items").select("product_id").eq("organization_id", org).eq("collection_id", hit.id);
      productIds = ((items ?? []) as Array<{ product_id: string }>).map((i) => i.product_id);
      if (!productIds.length) return done(`The collection "${hit.name}" has no products.`, { products: [], next_cursor: null, link: link(ctx, "/app/catalog") });
    }

    let q = ctx.user
      .from("products")
      .select("id, title, category, price, compare_at_price, currency, availability, inventory_quantity, image_url, product_url, is_visible, updated_at")
      .eq("organization_id", org)
      .or(NOT_ARCHIVED_DUPLICATE);
    if (productIds) q = q.in("id", productIds.slice(0, 1000));
    const tsquery = toTsQuery(String(args["search"] ?? ""));
    if (tsquery) q = q.textSearch("search_vector", tsquery);
    if (args["availability"]) q = q.eq("availability", String(args["availability"]));
    const { data, error } = await q.order("updated_at", { ascending: false }).range(offset, offset + limit);
    if (error) return fail("We couldn't read your catalogue. Please try again.");
    const rows = (data ?? []) as ProductRow[];
    const shown = rows.slice(0, limit);
    const ids = shown.map((p) => p.id);
    const { data: links } = ids.length
      ? await ctx.user.from("product_collection_items").select("product_id, collection_id").eq("organization_id", org).in("product_id", ids)
      : { data: [] };
    const names = new Map(collections.map((c) => [c.id, c.name]));
    const collectionsOf = (id: string) =>
      ((links ?? []) as Array<{ product_id: string; collection_id: string }>)
        .filter((l) => l.product_id === id)
        .map((l) => names.get(l.collection_id))
        .filter(Boolean);
    return done(shown.length ? `${shown.length} product(s).` : "No products match.", {
      products: shown.map((p) => ({
        product_id: p.id,
        name: p.title,
        price: p.price === null ? null : Number(p.price),
        compare_at_price: p.compare_at_price === null ? null : Number(p.compare_at_price),
        currency: p.currency ?? "INR",
        price_text: money(p.price, p.currency ?? "INR"),
        availability: p.availability ?? "in_stock",
        stock: p.inventory_quantity,
        image_url: p.image_url,
        product_url: p.product_url,
        category: p.category,
        collections: collectionsOf(p.id),
        visible_to_customers: p.is_visible !== false,
      })),
      next_cursor: nextCursor(offset, limit, rows.length),
      link: link(ctx, "/app/catalog"),
    });
  },
};

// ---------------------------------------------------------------------------
// get_campaign_sales
// ---------------------------------------------------------------------------

const getCampaignSales: ToolDef = {
  name: "get_campaign_sales",
  title: "Campaign sales",
  description:
    "Sales AiDwar linked to one campaign (orders and revenue) — the same figure as 'Sales from this campaign' in the app, from AiDwar's sales attribution (synced store orders or recorded receipts). If there is no attribution data it says so: never estimate or invent a sales figure. Find the campaign with list_campaigns.",
  input: { ...workspaceArg, campaign_id: z.string().min(1).max(64) },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "campaigns.view", "see campaigns") ?? denied(ctx, "analytics.view", "see sales figures");
    if (d) return d;
    const org = ctx.workspace.id;
    const { data: campaign } = await ctx.user
      .from("campaigns")
      .select("id, name, status")
      .eq("organization_id", org)
      .eq("id", String(args["campaign_id"]))
      .maybeSingle();
    const c = campaign as { id: string; name: string; status: string } | null;
    if (!c) return fail(`No campaign with that id in ${ctx.workspace.name}.`);
    const base = { campaign_id: c.id, name: c.name, link: link(ctx, `/app/campaigns/${c.id}`) };

    const { enabledFlags } = await import("@/lib/feature-flags.server");
    if (!(await enabledFlags(ctx.service, org)).has("revenue_attribution"))
      return done(
        `Sales attribution isn't switched on for ${ctx.workspace.name}, so AiDwar has no sales figure for "${c.name}". Don't estimate one.`,
        { ...base, sales: null, reason: "attribution_off" },
      );

    const { readCampaignSales } = await import("@/lib/campaign-sales");
    const read = await readCampaignSales(ctx.user, org, c.id);
    if (read.kind === "error") return fail("We couldn't read sales for this campaign. Please try again.");
    if (read.kind === "none") {
      const { count } = await ctx.user.from("revenue_attributions").select("id", { count: "exact", head: true }).eq("organization_id", org);
      if (!count)
        return done(
          `${ctx.workspace.name} has no sales attribution data yet, so there is no sales figure for "${c.name}". AiDwar links orders to campaigns once a store is connected or receipts are recorded. Don't estimate one.`,
          { ...base, sales: null, reason: "no_attribution_data" },
        );
      return done(`No orders are linked to "${c.name}" so far.`, { ...base, sales: { orders: 0, revenue: 0 }, reason: "no_orders_linked" });
    }
    if (read.kind === "too_many" || read.kind === "mixed_currencies")
      return done(
        `${read.orders} orders are linked to "${c.name}", but ${read.kind === "too_many" ? "there are too many to total in one read" : `they are in more than one currency (${read.currencies.join(", ")})`}, so AiDwar shows no single total. See the campaign in AiDwar.`,
        { ...base, sales: null, orders: read.orders, reason: read.kind },
      );
    const s = read.sales;
    return done(`"${c.name}" is linked to ${s.orders} order(s) worth ${money(s.revenue, s.currency)}.`, {
      ...base,
      sales: { orders: s.orders, revenue: s.revenue, currency: s.currency, revenue_text: money(s.revenue, s.currency) },
      attribution: "last touch (the same rows as Receipts and Analytics)",
    });
  },
};

// ---------------------------------------------------------------------------
// create_template_draft / submit_template
// ---------------------------------------------------------------------------

const buttonInput = z.object({
  type: z.enum(["quick_reply", "url", "phone_number", "copy_code"]),
  text: z.string().max(40).optional().describe("The button's label (25 characters max)."),
  url: z.string().max(2000).optional().describe("url buttons: https://… (may end in {{1}} for a personal link)."),
  url_example: z.string().max(2000).optional().describe("url buttons with {{1}}: a full example address."),
  phone_number: z.string().max(25).optional().describe("phone_number buttons: with the country code, e.g. +919876543210."),
  coupon_example: z.string().max(20).optional().describe("copy_code buttons: an example code for Meta's review."),
});

const templateInput = {
  ...workspaceArg,
  name: z.string().min(1).max(512).describe("Lowercase letters, digits and underscores (other characters become _), e.g. winter_sale_2026."),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/).optional().describe("Meta language code, e.g. en, en_US, hi. Default en_US."),
  category: z.enum(["marketing", "utility"]).describe("marketing = offers and news; utility = updates about an order or account."),
  header_text: z.string().max(80).optional().describe("Optional text header (60 characters, at most one {{1}}). Picture/video/document headers are made in AiDwar."),
  header_example: z.string().max(200).optional().describe("Example for the header's {{1}}."),
  body: z.string().min(1).max(1100).describe("The message (1024 characters max). Variables {{1}}, {{2}}… in order; not at the very start or end."),
  body_examples: z.array(z.string().max(200)).max(20).optional().describe("One example value per body variable, in order ({{1}} first)."),
  footer: z.string().max(80).optional().describe("Optional footer (60 characters)."),
  buttons: z.array(buttonInput).max(10).optional(),
  whatsapp_number_id: z.string().min(1).max(64).optional().describe("The number whose WhatsApp Business Account gets the template; default: the default number."),
};

const BUTTON_KINDS = { quick_reply: "QUICK_REPLY", url: "URL", phone_number: "PHONE_NUMBER", copy_code: "COPY_CODE" } as const;

async function templateDraftFrom(args: Record<string, unknown>) {
  const { emptyDraft, slugifyTemplateName, extractVariables } = await import("@/lib/templates");
  const body = String(args["body"] ?? "");
  const examples = (args["body_examples"] as string[] | undefined) ?? [];
  const headerText = String(args["header_text"] ?? "");
  const buttons = ((args["buttons"] as Array<z.infer<typeof buttonInput>> | undefined) ?? []).map((b) => ({
    type: BUTTON_KINDS[b.type],
    text: b.type === "copy_code" ? String(b.text ?? "Copy code") : String(b.text ?? ""),
    ...(b.type === "url" ? { url: String(b.url ?? ""), urlExample: String(b.url_example ?? "") } : {}),
    ...(b.type === "phone_number" ? { phone_number: String(b.phone_number ?? "") } : {}),
    ...(b.type === "copy_code" ? { example: String(b.coupon_example ?? "") } : {}),
  }));
  const draft = {
    ...emptyDraft(),
    name: slugifyTemplateName(String(args["name"] ?? "")),
    language: String(args["language"] ?? "en_US"),
    category: String(args["category"] ?? "").toUpperCase(),
    headerFormat: (headerText.trim() ? "TEXT" : "NONE") as "TEXT" | "NONE",
    headerText,
    headerExample: String(args["header_example"] ?? ""),
    body,
    bodyExamples: Object.fromEntries(extractVariables(body).map((n) => [n, examples[n - 1] ?? ""])) as Record<number, string>,
    footer: String(args["footer"] ?? ""),
    buttons,
  };
  return draft;
}

type TemplateDraftShape = Awaited<ReturnType<typeof templateDraftFrom>>;

/** What a template's confirm_code is bound to: every word Meta will review, and the number. */
const templateState = (draft: TemplateDraftShape, accountId: string) => ({
  number: accountId,
  name: draft.name,
  language: draft.language,
  category: draft.category,
  header: draft.headerFormat === "TEXT" ? [draft.headerText, draft.headerExample] : null,
  body: draft.body,
  examples: draft.bodyExamples,
  footer: draft.footer,
  buttons: draft.buttons,
});

function templatePreview(draft: TemplateDraftShape): string {
  const fill = (text: string, examples: Record<number, string>) =>
    text.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n: string) => examples[Number(n)] || m);
  return [
    draft.headerFormat === "TEXT" ? `*${fill(draft.headerText, { 1: draft.headerExample })}*` : null,
    fill(draft.body, draft.bodyExamples),
    draft.footer ? `_${draft.footer}_` : null,
    ...draft.buttons.map((b) => `[${b.text || (b.type === "COPY_CODE" ? "Copy code" : b.type)}]`),
  ]
    .filter(Boolean)
    .join("\n");
}

/** The builder's validator, the WhatsApp number, and Meta's rule that a name+language is used once per account. */
async function planTemplate(ctx: ToolContext, args: Record<string, unknown>) {
  const { validateDraft } = await import("@/lib/templates");
  const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
  const org = ctx.workspace.id;
  const { connection, error: connectionError } = await getWhatsAppConnection(ctx.service, org, (args["whatsapp_number_id"] as string | undefined) ?? null);
  if (!connection) return { ok: false as const, outcome: fail(connectionError ?? "Connect a WhatsApp number in AiDwar before making templates.") };
  const draft = await templateDraftFrom(args);
  const problems = validateDraft(draft as never);
  const { data: existing } = await ctx.service
    .from("message_templates")
    .select("id, status")
    .eq("organization_id", org)
    .eq("waba_id", connection.wabaId)
    .eq("name", draft.name)
    .eq("language", draft.language)
    .maybeSingle();
  return { ok: true as const, connection, draft, problems, existing: existing as { id: string; status: string } | null };
}

const templateObject = (accountId: string, draft: TemplateDraftShape) => `template:${accountId}:${draft.name}:${draft.language}`;

const createTemplateDraft: ToolDef = {
  name: "create_template_draft",
  title: "Draft a WhatsApp template",
  description:
    "Draft a new WhatsApp message template (marketing or utility) and check it with AiDwar's template rules — nothing is saved or sent to Meta. Give name, category, body with {{1}}, {{2}}… and one example per variable, optional text header, footer and buttons (quick_reply, url, phone_number, copy_code). Returns the final name, a preview, every problem to fix, and — when it passes — a confirm_code. Show the user the preview; only if they clearly say to submit, call submit_template with exactly the same fields and the confirm_code.",
  input: templateInput,
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "templates.manage", "make message templates");
    if (d) return d;
    const plan = await planTemplate(ctx, args);
    if (!plan.ok) return plan.outcome;
    const { draft, problems, existing, connection } = plan;
    if (existing) problems.push(`A template called ${draft.name} in ${draft.language} already exists on this number — pick another name.`);
    const preview = templatePreview(draft);
    const base = {
      name: draft.name,
      language: draft.language,
      category: draft.category.toLowerCase(),
      whatsapp_number_id: connection.accountId,
      preview,
      problems,
      link: link(ctx, "/app/templates"),
    };
    if (problems.length)
      return done(`Template "${draft.name}" needs changes before it can go to Meta: ${problems.join(" ")}`, { ...base, ready: false, confirm_code: null });
    const c = await code(ctx, templateObject(connection.accountId, draft), CODE_ACTIONS.template, templateState(draft, connection.accountId));
    return done(
      `Template "${draft.name}" (${draft.language}, ${draft.category.toLowerCase()}) passes AiDwar's checks — nothing is saved yet. Show the user the preview; only if they confirm, call submit_template with the same fields and confirm_code (valid 15 minutes). Meta then reviews it (usually minutes, up to 24 hours).`,
      { ...base, ready: true, confirm_code: c.code, confirm_code_expires_at: c.expiresAt },
    );
  },
};

const submitTemplate: ToolDef = {
  name: "submit_template",
  title: "Submit a template to Meta",
  description:
    "Send a template drafted with create_template_draft to Meta for approval. ONLY after the user has seen the preview and explicitly confirmed. Give exactly the same fields as the draft plus its confirm_code (one use, 15 minutes). The template then shows as Pending in AiDwar until Meta approves or rejects it; it can't be used in a campaign before it is approved. At most 10 submissions a day per workspace from AI assistants.",
  input: { ...templateInput, confirm_code: z.string().min(1).max(80) },
  readOnly: false,
  destructive: true,
  run: async (ctx, args) => {
    const d = denied(ctx, "templates.manage", "make message templates");
    if (d) return d;
    const org = ctx.workspace.id;
    const plan = await planTemplate(ctx, args);
    if (!plan.ok) return plan.outcome;
    const { draft, problems, existing, connection } = plan;
    if (existing)
      return fail(`A template called ${draft.name} in ${draft.language} already exists on this number (${existing.status.toLowerCase()}) — a confirm_code works once.`);
    if (problems.length) return fail(`Not submitted: ${problems.join(" ")}`);
    const bad = await checkCode(ctx, args["confirm_code"], templateObject(connection.accountId, draft), CODE_ACTIONS.template, templateState(draft, connection.accountId));
    if (bad) return bad;

    const { takeTemplateRate, TEMPLATE_SUBMITS_PER_DAY } = await import("@/lib/mcp-access.server");
    const rate = await takeTemplateRate(ctx.service, org);
    if (!rate.allowed)
      return fail(`At most ${TEMPLATE_SUBMITS_PER_DAY} templates a day can be submitted from AI assistants. Try again in ${Math.ceil(rate.retryAfter / 3600)} hour(s), or submit it in AiDwar.`);

    const { createTemplateFromDraft } = await import("@/lib/template-create.server");
    const created = await createTemplateFromDraft(ctx.service, {
      organizationId: org,
      userId: ctx.caller.userId,
      draft: draft as never,
      whatsappAccountId: connection.accountId,
    });
    if (!created.ok) return fail(`Not submitted: ${created.error}`);
    const status = created.status.toLowerCase();
    return done(
      `Template "${draft.name}" (${draft.language}) was sent to Meta for review — status ${status}. It can be used in a campaign once Meta approves it (list_templates shows approved ones).`,
      {
        template_id: created.id,
        name: draft.name,
        language: draft.language,
        category: draft.category.toLowerCase(),
        status,
        meta_template_id: created.metaTemplateId,
        link: link(ctx, "/app/templates"),
      },
      { action: "mcp_template_submitted", objectId: created.id ?? draft.name, details: { name: draft.name, language: draft.language, status } },
    );
  },
};

// ---------------------------------------------------------------------------
// Scheduled campaigns: preview_campaign_change, update_scheduled_campaign,
// cancel_scheduled_campaign
// ---------------------------------------------------------------------------

/** A scheduled campaign must be at least this far from its send time to be changed here. */
export const MIN_LEAD_MS = 5 * 60 * 1000;

type ScheduledRow = {
  id: string;
  organization_id: string;
  name: string;
  status: string;
  whatsapp_account_id: string | null;
  template_name: string | null;
  template_language: string | null;
  variable_mappings: Record<string, unknown> | null;
  send_settings: Record<string, unknown> | null;
  segment_id: string | null;
  scheduled_at: string | null;
  total_recipients: number | null;
  estimated_cost: number | null;
  created_by: string | null;
};
const SCHEDULED_COLS =
  "id, organization_id, name, status, whatsapp_account_id, template_name, template_language, variable_mappings, send_settings, segment_id, scheduled_at, total_recipients, estimated_cost, created_by";

const changeInput = {
  schedule_at: z.string().datetime({ offset: true }).optional().describe("New send time (ISO, with the offset, e.g. 2026-11-01T19:00:00+05:30)."),
  segment_id: z.string().min(1).max(64).optional().describe("New audience: a saved segment."),
  all_opted_in: z.boolean().optional().describe("New audience: every opted-in customer."),
  variables: z
    .record(z.string().regex(/^\d{1,2}$/), variableInput)
    .optional()
    .describe('New values for some or all body variables: {"2": "30% off"} or {"1": {"source":"name"}}. Variables left out keep their value.'),
};

async function readScheduled(ctx: ToolContext, id: unknown): Promise<{ row: ScheduledRow } | { outcome: ToolOutcome }> {
  const { data } = await ctx.service.from("campaigns").select(SCHEDULED_COLS).eq("organization_id", ctx.workspace.id).eq("id", String(id ?? "")).maybeSingle();
  const row = data as ScheduledRow | null;
  if (!row) return { outcome: fail(`No campaign with that id in ${ctx.workspace.name}.`) };
  if (row.status !== "scheduled") {
    const what =
      row.status === "sending"
        ? "already sending"
        : row.status === "completed"
          ? "already sent"
          : `${row.status.replace(/_/g, " ")}, not scheduled`;
    return { outcome: fail(`"${row.name}" is ${what}, so it can't be changed or cancelled from here — a confirm_code works once. Open it in AiDwar: ${link(ctx, `/app/campaigns/${row.id}`)}`) };
  }
  if (!row.scheduled_at || Date.parse(row.scheduled_at) <= ctx.now() + MIN_LEAD_MS)
    return { outcome: fail(`"${row.name}" is due to send within 5 minutes, so it can't be changed from here. Use AiDwar: ${link(ctx, `/app/campaigns/${row.id}`)}`) };
  if (!row.created_by)
    return { outcome: fail(`"${row.name}" was started through the AiDwar API, so it can only be changed there or cancelled in AiDwar.`) };
  return { row };
}

/** What a campaign change's confirm_code is bound to: the campaign as it is (incl. its segment's rules) + the change asked for. */
async function scheduledState(db: SupabaseClient, row: ScheduledRow, change: unknown) {
  const { sanitizeSendSettings } = await import("@/lib/campaigns");
  let segment: unknown = null;
  if (row.segment_id) {
    const { data } = await db.from("segments").select("id, filters, updated_at").eq("organization_id", row.organization_id).eq("id", row.segment_id).maybeSingle();
    segment = data ?? "missing";
  }
  return {
    campaign: {
      id: row.id,
      status: row.status,
      name: row.name,
      template: [row.template_name, row.template_language],
      number: row.whatsapp_account_id,
      values: row.variable_mappings ?? {},
      send: sanitizeSendSettings(row.send_settings),
      audience: row.segment_id ? { segment } : "all_opted_in",
      schedule: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
    },
    change,
  };
}

type ChangePlan = {
  change: Record<string, unknown>;
  changes: string[];
  segmentId: string | null;
  mappings: Record<string, unknown>;
  scheduledAt: string;
  recipients: number;
  notOptedIn: number;
  estimate: { amount: number; currency: string; text: string | null; walletCovers: boolean } | null;
};

/** The change, checked the way a launch would check it, and what it would mean (recipients, cost). */
async function planChange(ctx: ToolContext, row: ScheduledRow, args: Record<string, unknown>): Promise<{ ok: true; plan: ChangePlan } | { ok: false; outcome: ToolOutcome }> {
  const org = ctx.workspace.id;
  const bad = (m: string) => ({ ok: false as const, outcome: fail(m) });
  const audienceGiven = args["segment_id"] !== undefined || args["all_opted_in"] === true;
  if (args["segment_id"] !== undefined && args["all_opted_in"] === true) return bad("Give segment_id or all_opted_in, not both.");
  if (!args["schedule_at"] && !audienceGiven && !args["variables"]) return bad("Nothing to change: give schedule_at, an audience (segment_id or all_opted_in) or variables.");

  const change: Record<string, unknown> = {};
  const changes: string[] = [];
  let scheduledAt = new Date(row.scheduled_at!).toISOString();
  if (args["schedule_at"]) {
    const at = new Date(String(args["schedule_at"]));
    if (at.getTime() <= ctx.now() + MIN_LEAD_MS) return bad("The new time must be at least 5 minutes from now.");
    if (at.getTime() > ctx.now() + 90 * 864e5) return bad("The new time can be at most 90 days ahead.");
    change["schedule_at"] = at.toISOString();
    if (at.toISOString() !== scheduledAt) changes.push(`send time ${scheduledAt} → ${at.toISOString()}`);
    scheduledAt = at.toISOString();
  }

  let segmentId = row.segment_id;
  if (audienceGiven) {
    segmentId = args["all_opted_in"] === true ? null : String(args["segment_id"]);
    change["audience"] = segmentId ? { segment_id: segmentId } : "all_opted_in";
    if (segmentId !== row.segment_id) changes.push(`audience ${row.segment_id ? `segment ${row.segment_id}` : "all opted-in customers"} → ${segmentId ? `segment ${segmentId}` : "all opted-in customers"}`);
  }

  const mappings: Record<string, unknown> = { ...(row.variable_mappings ?? {}) };
  if (args["variables"]) {
    const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
    const { connection } = await getWhatsAppConnection(ctx.service, org, row.whatsapp_account_id);
    if (!connection) return bad("This campaign's WhatsApp number isn't connected any more. Change it in AiDwar.");
    let tq = ctx.service
      .from("message_templates")
      .select("components")
      .eq("organization_id", org)
      .eq("waba_id", connection.wabaId)
      .eq("name", String(row.template_name ?? ""));
    if (row.template_language) tq = tq.eq("language", row.template_language);
    const { data: t } = await tq.limit(1).maybeSingle();
    if (!t) return bad("This campaign's template isn't on its number any more. Change it in AiDwar.");
    const { templateVariableSpec } = await import("@/lib/templates");
    const body = templateVariableSpec((t as { components: unknown }).components as never).body.map(String);
    const given = args["variables"] as Record<string, string | { source: string; key?: string; value?: string }>;
    const normalized: Record<string, unknown> = {};
    for (const [n, v] of Object.entries(given)) {
      if (!body.includes(n)) return bad(`This campaign's template has no {{${n}}}. Its variables: ${body.map((b) => `{{${b}}}`).join(", ") || "none"}.`);
      if (typeof v === "string") {
        if (!v.trim()) return bad(`{{${n}}} can't be empty.`);
        normalized[n] = { source: "static", value: v };
      } else {
        if (v.source === "attribute" && !v.key) return bad(`{{${n}}}: an attribute value needs its key.`);
        if (v.source === "static" && !String(v.value ?? "").trim()) return bad(`{{${n}}}: give the text in value.`);
        normalized[n] = { source: v.source, ...(v.key ? { key: v.key } : {}), ...(v.value ? { value: v.value } : {}) };
      }
      if (JSON.stringify(mappings[n] ?? null) !== JSON.stringify(normalized[n])) changes.push(`{{${n}}} → ${JSON.stringify(normalized[n])}`);
      mappings[n] = normalized[n];
    }
    change["variables"] = normalized;
  }
  if (!changes.length) return bad("That is already how this campaign is set up — nothing would change.");

  const { audienceSummary, isSegmentNotFound } = await import("@/lib/campaigns.server");
  let recipients: number;
  let notOptedIn: number;
  try {
    const s = await audienceSummary(ctx.user, org, segmentId);
    recipients = s.eligible;
    notOptedIn = s.excluded;
  } catch (error) {
    if (isSegmentNotFound(error)) return bad(error.message);
    return bad("We couldn't work out this audience. Please try again.");
  }
  if (recipients === 0) return bad("No opted-in customers match the new audience, so there's nobody to send to.");

  const { data: tmeta } = await ctx.service
    .from("message_templates")
    .select("category")
    .eq("organization_id", org)
    .eq("name", String(row.template_name ?? ""))
    .limit(1)
    .maybeSingle();
  const { campaignCategory } = await import("@/lib/campaign-launch.server");
  const { campaignCostEstimate } = await import("@/lib/billing.server");
  const est = await campaignCostEstimate(ctx.service, {
    organizationId: org,
    recipients,
    category: campaignCategory((tmeta as { category?: string } | null)?.category),
    whatsappAccountId: row.whatsapp_account_id,
  });
  return {
    ok: true,
    plan: {
      change,
      changes,
      segmentId,
      mappings,
      scheduledAt,
      recipients,
      notOptedIn,
      estimate: est.enabled ? { amount: est.estimate, currency: est.currency, text: money(est.estimate, est.currency), walletCovers: est.can_send } : null,
    },
  };
}

const campaignControl = (ctx: ToolContext) => denied(ctx, "campaigns.send", "change or cancel campaigns");

const previewCampaignChange: ToolDef = {
  name: "preview_campaign_change",
  title: "Preview a change to a scheduled campaign",
  description:
    "Before moving, re-targeting or cancelling a SCHEDULED campaign (not yet sending): shows exactly what would change, the new number of opted-in recipients and the estimated cost, and returns a confirm_code. Give campaign_id and either cancel: true, or any of schedule_at, segment_id / all_opted_in, variables. Changes nothing. Show the user the details; only if they confirm, call update_scheduled_campaign (same fields) or cancel_scheduled_campaign with the code. Campaigns already sending or sent can't be changed.",
  input: { ...workspaceArg, campaign_id: z.string().min(1).max(64), cancel: z.boolean().optional(), ...changeInput },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = campaignControl(ctx);
    if (d) return d;
    const r = await readScheduled(ctx, args["campaign_id"]);
    if ("outcome" in r) return r.outcome;
    const row = r.row;
    const base = { campaign_id: row.id, name: row.name, status: row.status, scheduled_at: row.scheduled_at, link: link(ctx, `/app/campaigns/${row.id}`) };
    if (args["cancel"] === true) {
      if (args["schedule_at"] || args["segment_id"] || args["all_opted_in"] || args["variables"]) return fail("Give cancel: true on its own, or the changes without cancel.");
      const c = await code(ctx, row.id, CODE_ACTIONS.cancel, await scheduledState(ctx.service, row, "cancel"));
      return done(
        `Cancelling "${row.name}" (scheduled for ${row.scheduled_at}, ${row.total_recipients ?? 0} recipient(s)) means none of it is sent. Ask the user to confirm; only then call cancel_scheduled_campaign with campaign_id and confirm_code (valid 15 minutes).`,
        { ...base, change: "cancel", recipients: row.total_recipients ?? 0, confirm_code: c.code, confirm_code_expires_at: c.expiresAt },
      );
    }
    const planned = await planChange(ctx, row, args);
    if (!planned.ok) return planned.outcome;
    const p = planned.plan;
    const c = await code(ctx, row.id, CODE_ACTIONS.update, await scheduledState(ctx.service, row, p.change));
    return done(
      [
        `"${row.name}": ${p.changes.join("; ")}.`,
        `It would go to ${p.recipients} opted-in customer(s) at ${p.scheduledAt}${p.notOptedIn ? ` (${p.notOptedIn} not opted in are left out)` : ""}.`,
        p.estimate ? `Estimated cost ${p.estimate.text}.` : null,
        p.estimate && !p.estimate.walletCovers ? "The wallet doesn't cover this yet: add credits in AiDwar first." : null,
        "AiDwar replaces the scheduled campaign with the changed one (the old one shows as cancelled). Ask the user to confirm; only then call update_scheduled_campaign with the same fields and confirm_code (valid 15 minutes).",
      ]
        .filter(Boolean)
        .join(" "),
      {
        ...base,
        changes: p.changes,
        new_scheduled_at: p.scheduledAt,
        recipients: p.recipients,
        not_opted_in_left_out: p.notOptedIn,
        estimated_cost: p.estimate ? { amount: p.estimate.amount, currency: p.estimate.currency, text: p.estimate.text } : null,
        wallet_covers_it: p.estimate ? p.estimate.walletCovers : null,
        confirm_code: c.code,
        confirm_code_expires_at: c.expiresAt,
      },
    );
  },
};

const updateScheduledCampaign: ToolDef = {
  name: "update_scheduled_campaign",
  title: "Change a scheduled campaign",
  description:
    "Apply a change previewed with preview_campaign_change (new send time, audience or variable values) to a campaign that is scheduled and not yet sending. ONLY after the user saw the preview and explicitly confirmed. Give the same fields plus the confirm_code (one use, 15 minutes). AiDwar launches the changed campaign through its normal checks (opt-in, template approval, wallet) and then cancels the old one, so the result has a new campaign_id.",
  input: { ...workspaceArg, campaign_id: z.string().min(1).max(64), ...changeInput, confirm_code: z.string().min(1).max(80) },
  readOnly: false,
  destructive: true,
  run: async (ctx, args) => {
    const d = campaignControl(ctx);
    if (d) return d;
    const org = ctx.workspace.id;
    const r = await readScheduled(ctx, args["campaign_id"]);
    if ("outcome" in r) return r.outcome;
    const row = r.row;
    const planned = await planChange(ctx, row, args);
    if (!planned.ok) return planned.outcome;
    const p = planned.plan;
    const bad = await checkCode(ctx, args["confirm_code"], row.id, CODE_ACTIONS.update, await scheduledState(ctx.service, row, p.change));
    if (bad) return bad;

    // The changed campaign first, through the Launch button's own path; the
    // old one is cancelled only once that worked, so a refusal changes nothing.
    const { sanitizeSendSettings } = await import("@/lib/campaigns");
    const { launchCampaign, cancelCampaign } = await import("@/lib/campaign-launch.server");
    const launched = await launchCampaign(ctx.service, {
      organizationId: org,
      userId: ctx.caller.userId,
      name: row.name,
      templateName: String(row.template_name ?? ""),
      templateLanguage: row.template_language,
      whatsappAccountId: row.whatsapp_account_id,
      segmentId: p.segmentId,
      mappings: p.mappings as never,
      sendSettings: sanitizeSendSettings(row.send_settings),
      scheduledAt: new Date(p.scheduledAt),
      activityDetails: { ...mcpDetails(ctx, "update_scheduled_campaign"), replaces_campaign_id: row.id },
    }).catch(() => null);
    if (!launched || !launched.ok)
      return fail(launched ? `Not changed: ${launched.error}` : "Not changed: something went wrong. The scheduled campaign is as it was; please try again.", { campaign_id: row.id, status: row.status });

    const cancelled = await cancelCampaign(ctx.service, org, row.id);
    if (!cancelled.ok) {
      await cancelCampaign(ctx.service, org, launched.campaignId);
      return fail(`Not changed: ${cancelled.error} The new version was withdrawn.`, { campaign_id: row.id });
    }
    const { logServerActivity } = await import("@/lib/whatsapp-api.server");
    await logServerActivity(ctx.service, org, ctx.caller.userId, "campaign_cancelled", {
      campaign_id: row.id,
      ...mcpDetails(ctx, "update_scheduled_campaign"),
      replaced_by: launched.campaignId,
    });
    const when =
      launched.status === "awaiting_approval"
        ? "It now waits for an owner's approval (it is above the workspace's spend limit)."
        : `It is scheduled for ${launched.scheduledAt}.`;
    return done(
      `"${row.name}" changed: ${p.changes.join("; ")}. ${launched.totalRecipients} opted-in customer(s). ${when}`,
      {
        campaign_id: launched.campaignId,
        replaced_campaign_id: row.id,
        status: launched.status,
        scheduled_at: launched.scheduledAt,
        recipients: launched.totalRecipients,
        estimated_cost: launched.estimatedCost,
        link: link(ctx, `/app/campaigns/${launched.campaignId}`),
      },
      { action: "mcp_campaign_changed", objectId: launched.campaignId, details: { replaced_campaign_id: row.id, changes: p.changes, recipients: launched.totalRecipients } },
    );
  },
};

const cancelScheduledCampaign: ToolDef = {
  name: "cancel_scheduled_campaign",
  title: "Cancel a scheduled campaign",
  description:
    "Cancel a campaign that is scheduled and not yet sending, after preview_campaign_change with cancel: true and the user's explicit confirmation. Needs campaign_id and that confirm_code (one use, 15 minutes). Nothing of it is sent. Campaigns already sending or sent are never touched.",
  input: { ...workspaceArg, campaign_id: z.string().min(1).max(64), confirm_code: z.string().min(1).max(80) },
  readOnly: false,
  destructive: true,
  run: async (ctx, args) => {
    const d = campaignControl(ctx);
    if (d) return d;
    const org = ctx.workspace.id;
    const r = await readScheduled(ctx, args["campaign_id"]);
    if ("outcome" in r) return r.outcome;
    const row = r.row;
    const bad = await checkCode(ctx, args["confirm_code"], row.id, CODE_ACTIONS.cancel, await scheduledState(ctx.service, row, "cancel"));
    if (bad) return bad;
    const { cancelCampaign } = await import("@/lib/campaign-launch.server");
    const cancelled = await cancelCampaign(ctx.service, org, row.id);
    if (!cancelled.ok) return fail(`Not cancelled: ${cancelled.error}`);
    const { logServerActivity } = await import("@/lib/whatsapp-api.server");
    await logServerActivity(ctx.service, org, ctx.caller.userId, "campaign_cancelled", { campaign_id: row.id, ...mcpDetails(ctx, "cancel_scheduled_campaign") });
    return done(
      `"${row.name}" is cancelled; nothing of it will be sent.`,
      { campaign_id: row.id, status: "cancelled", link: link(ctx, `/app/campaigns/${row.id}`) },
      { action: "mcp_campaign_cancelled", objectId: row.id, details: { name: row.name } },
    );
  },
};

// ---------------------------------------------------------------------------
// tag_contacts
// ---------------------------------------------------------------------------

export const MAX_TAG_CONTACTS = 5000;
const PAGE = 1000;

type Person = { id: string; name: string | null };

/** Every row of a paged read (PostgREST returns at most 1,000 at once), up to `cap`. */
async function readPaged<T>(read: (from: number, to: number) => PromiseLike<{ data: unknown }>, cap: number): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data } = await read(from, Math.min(from + PAGE, cap) - 1);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

async function peopleByIds(db: SupabaseClient, org: string, ids: string[]): Promise<Person[]> {
  const out: Person[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const { data } = await db.from("contacts").select("id, name").eq("organization_id", org).in("id", ids.slice(i, i + 500));
    out.push(...((data ?? []) as Person[]));
  }
  return out;
}

const normalizeReply = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();

/** Who a tag_contacts request means, read with the caller's own token (RLS). */
async function whoToTag(ctx: ToolContext, args: Record<string, unknown>): Promise<{ ok: true; people: Person[]; filter: Record<string, unknown> } | { ok: false; outcome: ToolOutcome }> {
  const org = ctx.workspace.id;
  const db = ctx.user;
  const cap = MAX_TAG_CONTACTS + 1;
  const bad = (m: string) => ({ ok: false as const, outcome: fail(m) });
  const sources = ["has_tag", "segment_id", "search", "replied_with", "contact_ids"].filter((k) => args[k] !== undefined);
  if (sources.length !== 1) return bad("Say who to tag with exactly one of: has_tag, segment_id, search, replied_with or contact_ids.");
  if (args["campaign_id"] !== undefined && args["replied_with"] === undefined) return bad("campaign_id narrows replied_with; give replied_with too.");

  if (args["contact_ids"]) {
    const ids = [...new Set(args["contact_ids"] as string[])];
    if (ids.length > MAX_TAG_CONTACTS) return bad(`At most ${MAX_TAG_CONTACTS.toLocaleString("en-IN")} customers at once.`);
    const people = await peopleByIds(db, org, ids);
    const missing = ids.length - people.length;
    if (missing) return bad(`${missing} of those contact ids aren't customers in ${ctx.workspace.name}. Use ids from search_contacts.`);
    return { ok: true, people, filter: { contact_ids: [...ids].sort() } };
  }

  if (args["has_tag"]) {
    const { ids, missing } = await resolveTagIds(db, org, [String(args["has_tag"])]);
    if (missing.length) return bad(`No tag called "${String(args["has_tag"])}" in ${ctx.workspace.name}.`);
    const links = await readPaged<{ contact_id: string }>(
      (from, to) => db.from("contact_tags").select("contact_id").eq("organization_id", org).in("tag_id", ids).order("contact_id").range(from, to),
      cap,
    );
    const people = await peopleByIds(db, org, [...new Set(links.map((l) => l.contact_id))]);
    return { ok: true, people, filter: { has_tag: ids[0] } };
  }

  if (args["segment_id"]) {
    const segmentId = String(args["segment_id"]);
    const { data: seg } = await db.from("segments").select("id, filters").eq("organization_id", org).eq("id", segmentId).maybeSingle();
    if (!seg) return bad(`No segment with that id in ${ctx.workspace.name}. Use list_segments.`);
    const { segmentExpressions, applySegment } = await import("@/lib/segments.server");
    const { match, expressions } = await segmentExpressions(db, org, (seg as { filters: unknown }).filters);
    const people = await readPaged<Person>(
      (from, to) => applySegment(db.from("contacts").select("id, name").eq("organization_id", org).order("id").range(from, to), match, expressions),
      cap,
    );
    return { ok: true, people, filter: { segment_id: segmentId } };
  }

  if (args["search"] !== undefined) {
    const query = plain(args["search"]);
    if (!query) return bad("search needs a name or part of a phone number.");
    const people = await readPaged<Person>(
      (from, to) =>
        db
          .from("contacts")
          .select("id, name")
          .eq("organization_id", org)
          .or(`name.ilike.%${query}%,phone.ilike.%${query.replace(/\s/g, "")}%`)
          .order("id")
          .range(from, to),
      cap,
    );
    return { ok: true, people, filter: { search: query } };
  }

  // replied_with: customers whose own message was exactly these words (e.g. a YES button).
  const d = denied(ctx, "inbox.view", "read customers' replies");
  if (d) return { ok: false, outcome: d };
  const wanted = normalizeReply(String(args["replied_with"] ?? ""));
  if (!wanted) return bad("replied_with needs the reply's words, e.g. YES.");
  const days = Math.min(90, Math.max(1, Number(args["replied_within_days"] ?? 30) || 30));
  let since = ctx.now() - days * 864e5;
  let recipients: Set<string> | null = null;
  if (args["campaign_id"]) {
    const { data: camp } = await db.from("campaigns").select("id, started_at, created_at").eq("organization_id", org).eq("id", String(args["campaign_id"])).maybeSingle();
    const c = camp as { id: string; started_at: string | null; created_at: string } | null;
    if (!c) return bad(`No campaign with that id in ${ctx.workspace.name}.`);
    since = Math.max(since, Date.parse(c.started_at ?? c.created_at) || since);
    const recs = await readPaged<{ contact_id: string }>(
      (from, to) => db.from("campaign_recipients").select("contact_id").eq("organization_id", org).eq("campaign_id", c.id).order("contact_id").range(from, to),
      50_000,
    );
    recipients = new Set(recs.map((r) => r.contact_id));
  }
  const term = plain(wanted, 60);
  const messages = await readPaged<{ conversation_id: string | null; body: string | null }>(
    (from, to) =>
      db
        .from("messages")
        .select("conversation_id, body")
        .eq("organization_id", org)
        .eq("direction", "inbound")
        .gte("created_at", new Date(since).toISOString())
        .ilike("body", `%${term}%`)
        .order("created_at", { ascending: false })
        .range(from, to),
    20_000,
  );
  const conversationIds = [...new Set(messages.filter((m) => m.conversation_id && normalizeReply(String(m.body ?? "")) === wanted).map((m) => m.conversation_id!))];
  const contactIds = new Set<string>();
  for (let i = 0; i < conversationIds.length; i += 500) {
    const { data } = await db.from("conversations").select("contact_id").eq("organization_id", org).in("id", conversationIds.slice(i, i + 500));
    for (const c of (data ?? []) as Array<{ contact_id: string | null }>) if (c.contact_id) contactIds.add(c.contact_id);
  }
  const ids = [...contactIds].filter((id) => !recipients || recipients.has(id));
  if (ids.length > MAX_TAG_CONTACTS) return { ok: true, people: ids.map((id) => ({ id, name: null })), filter: {} };
  const people = await peopleByIds(db, org, ids);
  return {
    ok: true,
    people,
    filter: { replied_with: wanted, since: new Date(since).toISOString().slice(0, 10), ...(args["campaign_id"] ? { campaign_id: String(args["campaign_id"]) } : {}) },
  };
}

type TagPlan = {
  tagName: string;
  tagId: string | null;
  matched: Person[];
  lacking: Person[];
  filter: Record<string, unknown>;
};

async function planTagging(ctx: ToolContext, args: Record<string, unknown>): Promise<{ ok: true; plan: TagPlan } | { ok: false; outcome: ToolOutcome }> {
  const org = ctx.workspace.id;
  const tagName = String(args["tag"] ?? "").trim();
  if (!tagName) return { ok: false, outcome: fail("Which tag? Give its name in tag.") };
  const { ids } = await resolveTagIds(ctx.user, org, [tagName]);
  const tagId = ids[0] ?? null;
  if (!tagId && args["create_tag_if_missing"] !== true)
    return { ok: false, outcome: fail(`No tag called "${tagName}" in ${ctx.workspace.name}. Ask the user whether to create it, then call again with create_tag_if_missing: true.`) };
  const who = await whoToTag(ctx, args);
  if (!who.ok) return who;
  if (who.people.length > MAX_TAG_CONTACTS)
    return { ok: false, outcome: fail(`That matches more than ${MAX_TAG_CONTACTS.toLocaleString("en-IN")} customers. Narrow it down (a segment, a search or a shorter period).`) };
  const matched = [...who.people].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const have = new Set<string>();
  if (tagId) {
    for (let i = 0; i < matched.length; i += 500) {
      const { data } = await ctx.user
        .from("contact_tags")
        .select("contact_id")
        .eq("organization_id", org)
        .eq("tag_id", tagId)
        .in("contact_id", matched.slice(i, i + 500).map((p) => p.id));
      for (const l of (data ?? []) as Array<{ contact_id: string }>) have.add(l.contact_id);
    }
  }
  return { ok: true, plan: { tagName, tagId, matched, lacking: matched.filter((p) => !have.has(p.id)), filter: who.filter } };
}

/** What a tag_contacts code is bound to: the tag, who was asked for, who they turned out to be and who lacks it. */
const tagState = (p: TagPlan) => ({
  tag: p.tagId ?? `new:${p.tagName.toLowerCase()}`,
  filter: p.filter,
  matched: p.matched.map((x) => x.id),
  lacking: p.lacking.map((x) => x.id),
});
const tagObject = (p: TagPlan) => `tag:${p.tagId ?? `new:${p.tagName.toLowerCase()}`}`;

const tagContacts: ToolDef = {
  name: "tag_contacts",
  title: "Tag customers",
  description: `Add a tag to many customers (tags are only added, never removed). Step 1 — call WITHOUT confirm_code: say which tag, and who with exactly one of has_tag, segment_id, search, replied_with (customers whose own WhatsApp message was exactly those words, e.g. "YES", within replied_within_days, optionally only recipients of campaign_id) or contact_ids. AiDwar answers how many customers match (at most ${MAX_TAG_CONTACTS.toLocaleString("en-IN")}), how many would newly get the tag, five sample names and a confirm_code; nothing changes. Step 2 — ONLY after the user confirms, call again with the same fields plus confirm_code (one use, 15 minutes). At most 20 tag operations an hour per workspace.`,
  input: {
    ...workspaceArg,
    tag: z.string().min(1).max(60).describe("The tag to ADD (its name)."),
    create_tag_if_missing: z.boolean().optional().describe("true = create the tag if the workspace doesn't have it (only when the user asked for a new tag)."),
    has_tag: z.string().max(60).optional().describe("Who: customers who already have this other tag."),
    segment_id: z.string().min(1).max(64).optional().describe("Who: everyone in this saved segment (list_segments)."),
    search: z.string().max(80).optional().describe("Who: customers whose name or phone contains this."),
    replied_with: z.string().max(60).optional().describe('Who: customers whose own message was exactly this (case and punctuation ignored), e.g. "YES".'),
    replied_within_days: z.number().int().min(1).max(90).optional().describe("For replied_with: how far back (default 30 days)."),
    campaign_id: z.string().min(1).max(64).optional().describe("For replied_with: only that campaign's recipients, replying after it started."),
    contact_ids: z.array(z.string().min(1).max(64)).min(1).max(MAX_TAG_CONTACTS).optional().describe("Who: these customers (contact_id from search_contacts)."),
    confirm_code: z.string().min(1).max(80).optional().describe("Step 2 only: the code from step 1."),
  },
  readOnly: false,
  destructive: true,
  run: async (ctx, args) => {
    const d = denied(ctx, "contacts.edit", "tag customers");
    if (d) return d;
    const org = ctx.workspace.id;
    const planned = await planTagging(ctx, args);
    if (!planned.ok) return planned.outcome;
    const p = planned.plan;
    const sample = p.lacking.slice(0, 5).map((x) => x.name ?? "(no name)");
    const base = {
      tag: p.tagName,
      tag_exists: Boolean(p.tagId),
      matched: p.matched.length,
      already_have_tag: p.matched.length - p.lacking.length,
      will_get_tag: p.lacking.length,
      sample_names: sample,
      link: link(ctx, "/app/contacts"),
    };

    if (args["confirm_code"] === undefined) {
      if (!p.matched.length) return done("Nobody matches, so there is nobody to tag.", { ...base, confirm_code: null });
      if (!p.lacking.length) return done(`All ${p.matched.length} matching customer(s) already have "${p.tagName}". Nothing to do.`, { ...base, confirm_code: null });
      const c = await code(ctx, tagObject(p), CODE_ACTIONS.tag, tagState(p));
      return done(
        `${p.matched.length} customer(s) match; ${p.lacking.length} would get "${p.tagName}"${p.tagId ? "" : " (a new tag)"}${sample.length ? `, e.g. ${sample.join(", ")}` : ""}. Nothing changed yet. Ask the user to confirm; only then call tag_contacts again with the same fields and confirm_code (valid 15 minutes).`,
        { ...base, confirm_code: c.code, confirm_code_expires_at: c.expiresAt },
      );
    }

    if (!p.lacking.length) return fail(`Everyone who matches already has "${p.tagName}" — nothing to add (a confirm_code works once).`);
    const bad = await checkCode(ctx, args["confirm_code"], tagObject(p), CODE_ACTIONS.tag, tagState(p));
    if (bad) return bad;
    const { takeTagRate, TAG_OPERATIONS_PER_HOUR } = await import("@/lib/mcp-access.server");
    const rate = await takeTagRate(ctx.service, org);
    if (!rate.allowed)
      return fail(`At most ${TAG_OPERATIONS_PER_HOUR} tag operations an hour from AI assistants. Try again in ${Math.ceil(rate.retryAfter / 60)} minute(s), or tag them in AiDwar.`);

    let tagId = p.tagId;
    if (!tagId) {
      // The contact drawer's own "new tag" row.
      const { TAG_COLORS } = await import("@/lib/contacts");
      const { data: created, error } = await ctx.service
        .from("tags")
        .insert({ organization_id: org, name: p.tagName, color: TAG_COLORS[0] })
        .select("id")
        .single();
      if (error || !created) return fail(`We couldn't create the tag "${p.tagName}". Please try again.`);
      tagId = String((created as { id: string }).id);
    }
    // The bulk "Add tag" write (Batch 48): one contact_tags row per customer
    // without the tag; a row that exists is never sent again.
    const { tagLinks } = await import("@/components/customers-v2/customers-v2");
    const links = tagLinks(org, tagId, p.lacking.map((x) => x.id), {});
    for (let i = 0; i < links.length; i += 500) {
      const { error } = await ctx.service.from("contact_tags").upsert(links.slice(i, i + 500), { onConflict: "contact_id,tag_id" });
      if (error)
        return fail(`We couldn't finish tagging (${i} of ${links.length} were tagged). Run the preview again to tag the rest.`, { tagged: i });
    }
    return done(
      `Added "${p.tagName}" to ${links.length} customer(s).`,
      { tag: p.tagName, tag_id: tagId, tagged: links.length, already_had_tag: p.matched.length - p.lacking.length, link: link(ctx, "/app/contacts") },
      { action: "mcp_contacts_tagged", objectId: tagId, details: { tag: p.tagName, tagged: links.length, filter: Object.keys(p.filter) } },
    );
  },
};

// ---------------------------------------------------------------------------
// list_aiden_questions / answer_aiden_question
// ---------------------------------------------------------------------------

const SERVICE_WINDOW_MS = 24 * 3600 * 1000;

const listAidenQuestions: ToolDef = {
  name: "list_aiden_questions",
  title: "What Aiden is waiting on you for",
  description:
    "The questions Aiden (the AI employee) couldn't answer and is waiting for the owner on (the Unanswered list), newest first: the question, when it was asked, and whether an answer would still reach the customer. Answer one with answer_aiden_question, using the user's own words.",
  input: { ...workspaceArg, ...pageArgs },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "ai.use", "see Aiden's questions");
    if (d) return d;
    const org = ctx.workspace.id;
    const { limit, offset } = page(args);
    const { data, error } = await ctx.user
      .from("pending_owner_replies")
      .select("id, question, status, source, conversation_id, created_at")
      .eq("organization_id", org)
      .in("status", ["pending", "expired"])
      .order("created_at", { ascending: false })
      .range(offset, offset + limit);
    if (error) return fail("We couldn't read Aiden's questions. Please try again.");
    const rows = (data ?? []) as Array<{ id: string; question: string; status: string; source: string; conversation_id: string | null; created_at: string }>;
    const shown = rows.slice(0, limit);
    const waiting = shown.filter((r) => r.status === "pending").length;
    return done(shown.length ? `${shown.length} question(s), ${waiting} with a customer still waiting.` : "Aiden isn't waiting on you for anything.", {
      questions: shown.map((r) => ({
        question_id: r.id,
        question: r.question,
        status: r.status === "pending" ? "waiting" : "expired",
        asked_at: r.created_at,
        from_customer_chat: r.source === "customer" && Boolean(r.conversation_id),
        ...(r.conversation_id ? { chat_link: link(ctx, `/app/inbox?c=${r.conversation_id}`) } : {}),
      })),
      next_cursor: nextCursor(offset, limit, rows.length),
      link: link(ctx, "/app/employee"),
    });
  },
};

const answerAidenQuestion: ToolDef = {
  name: "answer_aiden_question",
  title: "Answer Aiden's question",
  description:
    "Answer one of Aiden's open questions (list_aiden_questions) with the USER'S OWN WORDS. The answer must come from the user — pass exactly what they wrote; never write, guess, complete or rephrase an answer yourself. Aiden learns it for next time and, while the customer is still waiting and their 24-hour chat window is open, AiDwar sends it to that customer on WhatsApp. Step 1 — call WITHOUT confirm_code: AiDwar shows what will happen and returns a confirm_code; nothing changes. Step 2 — ONLY after the user confirms, call again with the same question_id and answer plus confirm_code (one use, 15 minutes).",
  input: {
    ...workspaceArg,
    question_id: z.string().min(1).max(64),
    answer: z.string().min(1).max(2000).describe("The user's own answer, word for word, exactly as they wrote it."),
    confirm_code: z.string().min(1).max(80).optional().describe("Step 2 only: the code from step 1."),
  },
  readOnly: false,
  destructive: true,
  run: async (ctx, args) => {
    // The Unanswered list's own rule: ai.use to see it, ai.configure to answer.
    const d = denied(ctx, "ai.use", "see Aiden's questions") ?? denied(ctx, "ai.configure", "answer Aiden's questions");
    if (d) return d;
    const org = ctx.workspace.id;
    const { readPendingOwnerReply, answerGap } = await import("@/lib/answer-gap.server");
    const q = await readPendingOwnerReply(ctx.service, org, String(args["question_id"]));
    if (!q) return fail(`No open question with that id in ${ctx.workspace.name}. Use list_aiden_questions.`);
    if (q.status !== "pending" && q.status !== "expired")
      return fail(`That question is already ${q.status === "answered" ? "answered" : q.status} — a confirm_code works once.`);
    const answer = String(args["answer"] ?? "");
    if (!answer.trim()) return fail("Give the user's answer.");

    let reachesCustomer = false;
    if (q.status === "pending" && q.source === "customer" && q.conversation_id) {
      const { data: conv } = await ctx.service.from("conversations").select("last_customer_message_at").eq("organization_id", org).eq("id", q.conversation_id).maybeSingle();
      const last = Date.parse(String((conv as { last_customer_message_at?: string | null } | null)?.last_customer_message_at ?? ""));
      reachesCustomer = Number.isFinite(last) && ctx.now() - last < SERVICE_WINDOW_MS;
    }
    const state = { question: q.id, asked: q.question, status: q.status, answer };
    if (args["confirm_code"] === undefined) {
      const c = await code(ctx, q.id, CODE_ACTIONS.answer, state);
      return done(
        `Aiden asked: "${q.question}". Your answer, exactly as given: "${answer}". Aiden will learn it for next time${reachesCustomer ? ", and AiDwar will send it to the waiting customer on WhatsApp now" : " (it won't be sent to the customer: their chat window has closed or they aren't waiting)"}. Nothing changed yet. Ask the user to confirm these exact words; only then call answer_aiden_question again with the same answer and confirm_code (valid 15 minutes).`,
        {
          question_id: q.id,
          question: q.question,
          answer_exactly: answer,
          aiden_learns_it: true,
          sent_to_customer: reachesCustomer,
          confirm_code: c.code,
          confirm_code_expires_at: c.expiresAt,
        },
      );
    }
    const bad = await checkCode(ctx, args["confirm_code"], q.id, CODE_ACTIONS.answer, state);
    if (bad) return bad;
    // The app's own answer_gap path, with the user's words as they were given.
    const answered = await answerGap(ctx.service, {
      organizationId: org,
      userId: ctx.caller.userId,
      replyId: q.id,
      answer: args["answer"],
      activityDetails: mcpDetails(ctx, "answer_aiden_question"),
    });
    if (!answered.ok) return fail(answered.error);
    return done(
      `Answered. Aiden has learned it${answered.delivered ? " and the customer got your answer on WhatsApp" : ""}.`,
      { question_id: q.id, answered: true, sent_to_customer: answered.delivered, link: link(ctx, "/app/employee") },
      { action: "mcp_question_answered", objectId: q.id, details: { sent_to_customer: answered.delivered } },
    );
  },
};

export const ROUND2_TOOLS: ToolDef[] = [
  listProducts,
  getCampaignSales,
  listAidenQuestions,
  createTemplateDraft,
  previewCampaignChange,
  submitTemplate,
  updateScheduledCampaign,
  cancelScheduledCampaign,
  tagContacts,
  answerAidenQuestion,
];
