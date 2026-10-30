import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { McpCaller } from "@/lib/mcp-auth.server";
import type { Workspace } from "@/lib/mcp-access.server";
import { CONFIRM_REFUSALS, issueConfirmCode, stateHash, verifyConfirmCode } from "@/lib/mcp-confirm.server";

/**
 * Batch 52: the AiDwar MCP tools. Reads go through `user` — a Supabase
 * client carrying the caller's own token, so RLS decides what they see —
 * and every read also checks the same permission the app's screen needs.
 * Writes go through the app's own server functions on the service client,
 * after the same permission check the app's route makes:
 *
 *   create_segment        segments insert (the builder's row), segments.manage
 *   create_campaign_draft campaigns row with status "draft", campaigns.create
 *   send_campaign         launchCampaign (the Launch button's), campaigns.send
 *   create_flow_draft     createFlowV2 (the Flows v2 editor's), flows_v2.edit
 *   activate_flow         publishFlowV2 (the editor's Publish), flows_v2.edit
 *
 * Sending and switching on take a confirm_code from the draft (HMAC-bound
 * to user, workspace, object, action and the draft's state; 15 minutes).
 * Never here: a free-text message to a customer, Aiden's mode, billing,
 * deletes, team, API keys or settings.
 */

export const MAX_PAGE = 50;

export type ToolContext = {
  caller: McpCaller & { clientName: string | null };
  /** Service-role client: permission checks and the app's write paths. */
  service: SupabaseClient;
  /** The caller's own token: every read (RLS applies). */
  user: SupabaseClient;
  origin: string;
  now: () => number;
  workspace: Workspace;
  workspaces: Workspace[];
  permissions: Set<string>;
  /** HMAC root secret for confirm codes; the server-only service key by default. */
  confirmSecret?: string;
};

export type Audit = { action: string; objectId: string; details?: Record<string, unknown> };

export type ToolOutcome =
  | { ok: true; summary: string; data: Record<string, unknown>; audit?: Audit }
  | { ok: false; error: string; data?: Record<string, unknown> };

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  readOnly: boolean;
  /** Sends or switches something on (asks for a confirm_code). */
  destructive: boolean;
  /** Runs without a workspace (list_workspaces). */
  noWorkspace?: boolean;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolOutcome>;
};

export const fail = (error: string, data?: Record<string, unknown>): ToolOutcome => ({ ok: false, error, ...(data ? { data } : {}) });
export const done = (summary: string, data: Record<string, unknown>, audit?: Audit): ToolOutcome => ({
  ok: true,
  summary,
  data,
  ...(audit ? { audit } : {}),
});

export function denied(ctx: ToolContext, permission: string | string[], what: string): ToolOutcome | null {
  const keys = Array.isArray(permission) ? permission : [permission];
  if (keys.some((k) => ctx.permissions.has(k))) return null;
  return fail(
    `You don't have permission to ${what} in ${ctx.workspace.name}. Your AI assistant can do only what you can do in the AiDwar app; ask an owner or admin of this workspace.`,
  );
}

export const link = (ctx: ToolContext, path: string) => `${ctx.origin}${path}`;

export function money(amount: number | null | undefined, currency = "INR"): string | null {
  if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return null;
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: currency || "INR", maximumFractionDigits: 2 }).format(Number(amount));
}

/** "+91•••••0001": the country part and the last four digits. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/[^\d+]/g, "");
  if (digits.length <= 6) return "•".repeat(Math.max(0, digits.length - 2)) + digits.slice(-2);
  const head = digits.startsWith("+") ? digits.slice(0, 3) : digits.slice(0, 2);
  return `${head}${"•".repeat(Math.max(1, digits.length - head.length - 4))}${digits.slice(-4)}`;
}

/**
 * Full numbers only for a member who may take contacts out of AiDwar in the
 * app (contacts.export); everyone else sees them masked. An AI app is
 * outside AiDwar, so the export rule is the one that applies.
 */
export const seesFullNumbers = (ctx: ToolContext) => ctx.permissions.has("contacts.export");

export function page(args: Record<string, unknown>): { limit: number; offset: number } {
  const limit = Math.min(MAX_PAGE, Math.max(1, Number(args["limit"] ?? 20) || 20));
  const offset = Math.max(0, Number(args["cursor"] ?? 0) || 0);
  return { limit, offset };
}

export function nextCursor(offset: number, limit: number, got: number): string | null {
  return got > limit ? String(offset + limit) : null;
}

export const workspaceArg = {
  workspace_id: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("The workspace to use (from list_workspaces). Leave out when the user has only one workspace."),
};
export const pageArgs = {
  limit: z.number().int().min(1).max(MAX_PAGE).optional().describe(`How many to return (1–${MAX_PAGE}, default 20).`),
  cursor: z.string().max(12).optional().describe("next_cursor from the previous page."),
};

// ---------------------------------------------------------------------------
// Read-only tools
// ---------------------------------------------------------------------------

const listWorkspaces: ToolDef = {
  name: "list_workspaces",
  title: "List workspaces",
  description:
    "List the AiDwar workspaces (businesses) the signed-in user belongs to, with their role in each. Call this first when the user has more than one workspace, then pass workspace_id to the other tools.",
  input: {},
  readOnly: true,
  destructive: false,
  noWorkspace: true,
  run: async (ctx) =>
    done(
      ctx.workspaces.length === 1
        ? `You have one workspace: ${ctx.workspaces[0]!.name}.`
        : `You belong to ${ctx.workspaces.length} workspaces. Ask the user which one to use if it isn't clear.`,
      {
        workspaces: ctx.workspaces.map((w) => ({ workspace_id: w.id, name: w.name, role: w.role })),
        link: link(ctx, "/app"),
      },
    ),
};

const getWorkspaceOverview: ToolDef = {
  name: "get_workspace_overview",
  title: "Workspace overview",
  description:
    "A snapshot of one workspace: plan status, wallet balance (if the user may see billing), Aiden's mode (the AI employee: off, draft or replying), the connected WhatsApp number(s), and how many chats are open and how many need a person. Good first call for 'how is my business doing on WhatsApp'.",
  input: { ...workspaceArg },
  readOnly: true,
  destructive: false,
  run: async (ctx) => {
    const org = ctx.workspace.id;
    const db = ctx.user;
    const [{ data: orgRow }, { data: agent }, { data: numbers }] = await Promise.all([
      db.from("organizations").select("name, plan_status, trial_ends_at").eq("id", org).maybeSingle(),
      db.from("ai_agents").select("mode").eq("organization_id", org).eq("is_default", true).maybeSingle(),
      db
        .from("whatsapp_accounts")
        .select("id, display_phone_number, verified_name, status, is_default")
        .eq("organization_id", org),
    ]);
    const o = (orgRow ?? {}) as { name?: string; plan_status?: string | null; trial_ends_at?: string | null };
    let wallet: Record<string, unknown> | null = null;
    if (ctx.permissions.has("billing.view")) {
      const { data: w } = await db
        .from("wallet_balances")
        .select("balance, held, currency")
        .eq("organization_id", org)
        .maybeSingle();
      if (w) {
        const row = w as { balance?: number; held?: number; currency?: string };
        const currency = row.currency ?? "INR";
        const available = Number(row.balance ?? 0) - Number(row.held ?? 0);
        wallet = {
          balance: Number(row.balance ?? 0),
          held_for_campaigns: Number(row.held ?? 0),
          available,
          currency,
          available_text: money(available, currency),
        };
      }
    }
    let chats: Record<string, unknown> | null = null;
    if (ctx.permissions.has("inbox.view")) {
      const [open, needs] = await Promise.all([
        db.from("conversations").select("id", { count: "exact", head: true }).eq("organization_id", org).eq("status", "open"),
        db.from("conversations").select("id", { count: "exact", head: true }).eq("organization_id", org).eq("needs_human", true),
      ]);
      chats = { open: open.count ?? 0, need_a_person: needs.count ?? 0 };
    }
    const mode = (agent as { mode?: string } | null)?.mode ?? "off";
    const nums = ((numbers ?? []) as Array<{ id: string; display_phone_number: string | null; verified_name: string | null; status: string | null; is_default: boolean | null }>).map(
      (n) => ({
        whatsapp_number_id: n.id,
        number: n.display_phone_number,
        name: n.verified_name,
        status: n.status,
        default: n.is_default === true,
      }),
    );
    const parts = [
      `${o.name ?? ctx.workspace.name}: plan ${o.plan_status ?? "unknown"}`,
      wallet ? `wallet ${String(wallet["available_text"])} available` : null,
      `Aiden is ${mode === "replying" ? "replying to customers" : mode === "draft" ? "drafting replies for the team" : "off"}`,
      chats ? `${String(chats["open"])} open chats, ${String(chats["need_a_person"])} need a person` : null,
    ].filter(Boolean);
    return done(parts.join("; ") + ".", {
      workspace_id: org,
      name: o.name ?? ctx.workspace.name,
      your_role: ctx.workspace.role,
      plan_status: o.plan_status ?? null,
      trial_ends_at: o.trial_ends_at ?? null,
      wallet: wallet ?? (ctx.permissions.has("billing.view") ? null : "Not visible to your role."),
      aiden_mode: mode,
      whatsapp_numbers: nums,
      chats: chats ?? "Not visible to your role.",
      link: link(ctx, "/app"),
    });
  },
};

type TemplateRow = { name: string; language: string; category: string | null; waba_id: string | null; components: unknown; updated_at?: string | null };

const listTemplates: ToolDef = {
  name: "list_templates",
  title: "List approved templates",
  description:
    "List the workspace's WhatsApp message templates that Meta has APPROVED (only approved templates can be sent in a campaign). For each: name, language, category (marketing/utility/authentication), the numbered body variables {{1}}, {{2}}… a campaign must fill, buttons, the header media type (image/video/document needs a picture/file link), and which WhatsApp numbers can send it.",
  input: { ...workspaceArg, search: z.string().max(80).optional().describe("Part of the template name."), ...pageArgs },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, ["campaigns.view", "inbox.view"], "see templates");
    if (d) return d;
    const { limit, offset } = page(args);
    const { templateVariableSpec, templateBodyText, templateButtons } = await import("@/lib/templates");
    let q = ctx.user
      .from("message_templates")
      .select("name, language, category, waba_id, components, updated_at")
      .eq("organization_id", ctx.workspace.id)
      .eq("status", "APPROVED");
    const search = String(args["search"] ?? "").trim();
    if (search) q = q.ilike("name", `%${search.replace(/[%_]/g, "")}%`);
    const [{ data, error }, { data: numbers }] = await Promise.all([
      q.order("name", { ascending: true }).range(offset, offset + limit),
      ctx.user.from("whatsapp_accounts").select("id, waba_id, display_phone_number").eq("organization_id", ctx.workspace.id),
    ]);
    if (error) return fail("We couldn't read your templates. Please try again.");
    const rows = ((data ?? []) as TemplateRow[]).slice(0, limit + 1);
    const nums = (numbers ?? []) as Array<{ id: string; waba_id: string | null; display_phone_number: string | null }>;
    const templates = rows.slice(0, limit).map((t) => {
      const components = t.components as never;
      const spec = templateVariableSpec(components);
      return {
        name: t.name,
        language: t.language,
        category: String(t.category ?? "").toLowerCase() || null,
        body: templateBodyText(components),
        body_variables: spec.body.map((n) => `{{${n}}}`),
        header_media: spec.headerMedia
          ? { type: spec.headerMedia.format.toLowerCase(), has_default_file: Boolean(spec.headerMedia.url) }
          : null,
        buttons: templateButtons(components).map((b) => ({
          type: String(b["type"] ?? "").toLowerCase(),
          text: b["text"] ?? null,
          ...(b["url"] ? { url: b["url"] } : {}),
        })),
        needs_coupon_code: spec.copyCodeButtons.length > 0,
        needs_offer_expiry: spec.offerExpiration,
        carousel_cards: spec.cards.length,
        whatsapp_number_ids: nums.filter((n) => n.waba_id === t.waba_id).map((n) => n.id),
      };
    });
    return done(`${templates.length} approved template(s).`, {
      templates,
      next_cursor: nextCursor(offset, limit, rows.length),
      link: link(ctx, "/app/templates"),
    });
  },
};

export async function tagNames(db: SupabaseClient, org: string): Promise<Map<string, string>> {
  const { data } = await db.from("tags").select("id, name").eq("organization_id", org);
  return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]));
}

const listSegments: ToolDef = {
  name: "list_segments",
  title: "List segments",
  description:
    "List the workspace's saved customer segments (audiences) with their rules in plain words. Use a segment_id from here as a campaign audience, or count_audience to see how many opted-in customers it reaches.",
  input: { ...workspaceArg, ...pageArgs },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "contacts.view", "see segments");
    if (d) return d;
    const { limit, offset } = page(args);
    const { normalizeFilters, usableConditions, describeCondition } = await import("@/lib/segments");
    const [{ data, error }, tags] = await Promise.all([
      ctx.user
        .from("segments")
        .select("id, name, description, filters, created_at")
        .eq("organization_id", ctx.workspace.id)
        .order("created_at", { ascending: false })
        .range(offset, offset + limit),
      tagNames(ctx.user, ctx.workspace.id),
    ]);
    if (error) return fail("We couldn't read your segments. Please try again.");
    const rows = (data ?? []) as Array<{ id: string; name: string; description: string | null; filters: unknown; created_at: string }>;
    const segments = rows.slice(0, limit).map((s) => {
      const f = normalizeFilters(s.filters);
      return {
        segment_id: s.id,
        name: s.name,
        description: s.description,
        match: f.match,
        rules: usableConditions(f).map((c) => describeCondition(c, c.field === "tag" ? tags.get(String(c.value)) : undefined)),
        created_at: s.created_at,
      };
    });
    return done(`${segments.length} segment(s).`, {
      segments,
      next_cursor: nextCursor(offset, limit, rows.length),
      link: link(ctx, "/app/contacts?tab=segments"),
    });
  },
};

const audienceInput = {
  segment_id: z.string().min(1).max(64).optional().describe("A saved segment (from list_segments or create_segment)."),
  tags: z.array(z.string().min(1).max(60)).min(1).max(10).optional().describe("Tag names: customers with ANY of these tags."),
  all_opted_in: z.boolean().optional().describe("true = every opted-in customer."),
};

export async function resolveTagIds(db: SupabaseClient, org: string, names: string[]): Promise<{ ids: string[]; missing: string[] }> {
  const all = await tagNames(db, org);
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const hit = Array.from(all.entries()).find(([, n]) => n.toLowerCase() === name.trim().toLowerCase());
    if (hit) ids.push(hit[0]);
    else missing.push(name);
  }
  return { ids, missing };
}

const countAudience: ToolDef = {
  name: "count_audience",
  title: "Count an audience",
  description:
    "How many customers an audience reaches. Give exactly one of segment_id, tags (customers with any of the tags) or all_opted_in. Only customers who opted in to WhatsApp messages count — opted-out and unknown customers never get a campaign.",
  input: { ...workspaceArg, ...audienceInput },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "contacts.view", "see customers");
    if (d) return d;
    const given = ["segment_id", "tags", "all_opted_in"].filter((k) => args[k] !== undefined && args[k] !== false);
    if (given.length !== 1) return fail("Give exactly one of segment_id, tags or all_opted_in.");
    const org = ctx.workspace.id;
    if (args["tags"]) {
      const { ids, missing } = await resolveTagIds(ctx.user, org, args["tags"] as string[]);
      if (missing.length) return fail(`No tag called ${missing.map((m) => `"${m}"`).join(", ")} in ${ctx.workspace.name}.`);
      const { segmentExpressions, applySegment } = await import("@/lib/segments.server");
      const filters = { match: "any", conditions: ids.map((id) => ({ field: "tag", operator: "has", value: id })) };
      const { match, expressions } = await segmentExpressions(ctx.user, org, filters);
      const base = () => ctx.user.from("contacts").select("id", { count: "exact", head: true }).eq("organization_id", org);
      const [{ count: matched }, { count: optedIn }] = await Promise.all([
        applySegment(base(), match, expressions),
        applySegment(base().eq("opt_in_status", "opted_in"), match, expressions),
      ]);
      const m = matched ?? 0;
      const e = optedIn ?? 0;
      return done(`${e} opted-in customer(s) have ${(args["tags"] as string[]).join(" or ")}.`, {
        opted_in: e,
        matched: m,
        not_opted_in: Math.max(0, m - e),
        link: link(ctx, "/app/contacts"),
      });
    }
    const { audienceSummary, isSegmentNotFound } = await import("@/lib/campaigns.server");
    try {
      const s = await audienceSummary(ctx.user, org, (args["segment_id"] as string | undefined) ?? null);
      return done(`${s.eligible} opted-in customer(s) in this audience.`, {
        opted_in: s.eligible,
        matched: s.matched,
        not_opted_in: s.excluded,
        link: link(ctx, args["segment_id"] ? "/app/contacts?tab=segments" : "/app/contacts"),
      });
    } catch (error) {
      if (isSegmentNotFound(error)) return fail(error.message);
      return fail("We couldn't count this audience. Please try again.");
    }
  },
};

const searchContacts: ToolDef = {
  name: "search_contacts",
  title: "Search customers",
  description: `Find customers by name or phone, optionally by tag or opt-in status. At most ${MAX_PAGE} per page. Phone numbers are masked unless the user may export contacts in AiDwar.`,
  input: {
    ...workspaceArg,
    query: z.string().max(80).optional().describe("Part of the name or phone number."),
    tag: z.string().max(60).optional().describe("Only customers with this tag (name)."),
    opt_in_status: z.enum(["opted_in", "opted_out", "unknown"]).optional(),
    ...pageArgs,
  },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "contacts.view", "see customers");
    if (d) return d;
    const org = ctx.workspace.id;
    const { limit, offset } = page(args);
    let q = ctx.user
      .from("contacts")
      .select("id, name, phone, opt_in_status, created_at")
      .eq("organization_id", org);
    const query = String(args["query"] ?? "").trim().replace(/[%_,()]/g, "");
    if (query) q = q.or(`name.ilike.%${query}%,phone.ilike.%${query.replace(/\s/g, "")}%`);
    if (args["opt_in_status"]) q = q.eq("opt_in_status", String(args["opt_in_status"]));
    if (args["tag"]) {
      const { ids, missing } = await resolveTagIds(ctx.user, org, [String(args["tag"])]);
      if (missing.length) return fail(`No tag called "${String(args["tag"])}" in ${ctx.workspace.name}.`);
      const { data: links } = await ctx.user.from("contact_tags").select("contact_id").eq("organization_id", org).in("tag_id", ids);
      const contactIds = ((links ?? []) as Array<{ contact_id: string }>).map((l) => l.contact_id);
      if (!contactIds.length) return done("No customers have that tag.", { contacts: [], next_cursor: null, link: link(ctx, "/app/contacts") });
      q = q.in("id", contactIds.slice(0, 1000));
    }
    const { data, error } = await q.order("created_at", { ascending: false }).range(offset, offset + limit);
    if (error) return fail("We couldn't search your customers. Please try again.");
    const rows = (data ?? []) as Array<{ id: string; name: string | null; phone: string; opt_in_status: string | null; created_at: string }>;
    const shown = rows.slice(0, limit);
    const ids = shown.map((r) => r.id);
    const [{ data: tagLinks }, names] = ids.length
      ? await Promise.all([
          ctx.user.from("contact_tags").select("contact_id, tag_id").eq("organization_id", org).in("contact_id", ids),
          tagNames(ctx.user, org),
        ])
      : [{ data: [] }, new Map<string, string>()];
    const tagsFor = (id: string) =>
      ((tagLinks ?? []) as Array<{ contact_id: string; tag_id: string }>)
        .filter((l) => l.contact_id === id)
        .map((l) => names.get(l.tag_id))
        .filter(Boolean);
    const full = seesFullNumbers(ctx);
    return done(`${shown.length} customer(s)${full ? "" : " (numbers masked)"}.`, {
      contacts: shown.map((r) => ({
        contact_id: r.id,
        name: r.name,
        phone: full ? r.phone : maskPhone(r.phone),
        opt_in_status: r.opt_in_status ?? "unknown",
        tags: tagsFor(r.id),
        added_at: r.created_at,
      })),
      phone_numbers: full ? "full" : "masked",
      next_cursor: nextCursor(offset, limit, rows.length),
      link: link(ctx, "/app/contacts"),
    });
  },
};

type CampaignRowLite = {
  id: string;
  name: string;
  status: string;
  template_name: string | null;
  segment_id: string | null;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  total_recipients: number | null;
  sent_count: number | null;
  delivered_count: number | null;
  read_count: number | null;
  failed_count: number | null;
  replied_count: number | null;
  estimated_cost: number | null;
  charged_amount: number | null;
  pause_reason: string | null;
};
const CAMPAIGN_COLS =
  "id, name, status, template_name, segment_id, scheduled_at, started_at, completed_at, created_at, total_recipients, sent_count, delivered_count, read_count, failed_count, replied_count, estimated_cost, charged_amount, pause_reason";

const listCampaigns: ToolDef = {
  name: "list_campaigns",
  title: "List campaigns",
  description:
    "List the workspace's WhatsApp campaigns, newest first, with status (draft, scheduled, awaiting_approval, sending, paused, completed, cancelled, failed) and headline numbers. Use get_campaign_report for one campaign's full results.",
  input: {
    ...workspaceArg,
    status: z
      .enum(["draft", "scheduled", "awaiting_approval", "sending", "paused", "completed", "cancelled", "failed"])
      .optional(),
    ...pageArgs,
  },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "campaigns.view", "see campaigns");
    if (d) return d;
    const { limit, offset } = page(args);
    let q = ctx.user.from("campaigns").select(CAMPAIGN_COLS).eq("organization_id", ctx.workspace.id);
    if (args["status"]) q = q.eq("status", String(args["status"]));
    const { data, error } = await q.order("created_at", { ascending: false }).range(offset, offset + limit);
    if (error) return fail("We couldn't read your campaigns. Please try again.");
    const rows = (data ?? []) as CampaignRowLite[];
    return done(`${Math.min(rows.length, limit)} campaign(s).`, {
      campaigns: rows.slice(0, limit).map((c) => ({
        campaign_id: c.id,
        name: c.name,
        status: c.status,
        template: c.template_name,
        recipients: c.total_recipients ?? 0,
        delivered: c.delivered_count ?? 0,
        read: c.read_count ?? 0,
        replied: c.replied_count ?? 0,
        created_at: c.created_at,
        scheduled_at: c.scheduled_at,
        link: link(ctx, `/app/campaigns/${c.id}`),
      })),
      next_cursor: nextCursor(offset, limit, rows.length),
      link: link(ctx, "/app/campaigns"),
    });
  },
};

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0);

const getCampaignReport: ToolDef = {
  name: "get_campaign_report",
  title: "Campaign report",
  description:
    "One campaign's results: recipients, sent, delivered, read, replied and failed (with rates), cost, timing and why it's paused if it is. Answers 'how did my last campaign do?' (find it with list_campaigns).",
  input: { ...workspaceArg, campaign_id: z.string().min(1).max(64) },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "campaigns.view", "see campaigns");
    if (d) return d;
    const { data } = await ctx.user
      .from("campaigns")
      .select(CAMPAIGN_COLS)
      .eq("organization_id", ctx.workspace.id)
      .eq("id", String(args["campaign_id"]))
      .maybeSingle();
    const c = data as CampaignRowLite | null;
    if (!c) return fail(`No campaign with that id in ${ctx.workspace.name}.`);
    const total = c.total_recipients ?? 0;
    const sent = c.sent_count ?? 0;
    const delivered = c.delivered_count ?? 0;
    const read = c.read_count ?? 0;
    const replied = c.replied_count ?? 0;
    const failed = c.failed_count ?? 0;
    const cost = c.charged_amount ?? c.estimated_cost ?? null;
    return done(
      `${c.name} (${c.status}): ${total} recipients, ${delivered} delivered (${pct(delivered, sent)}%), ${read} read (${pct(read, delivered)}%), ${replied} replied (${pct(replied, delivered)}%), ${failed} failed.`,
      {
        campaign_id: c.id,
        name: c.name,
        status: c.status,
        template: c.template_name,
        counts: { recipients: total, sent, delivered, read, replied, failed },
        rates_percent: {
          delivered_of_sent: pct(delivered, sent),
          read_of_delivered: pct(read, delivered),
          replied_of_delivered: pct(replied, delivered),
          failed_of_recipients: pct(failed, total),
        },
        cost: cost === null ? null : { amount: Number(cost), text: money(Number(cost)), final: c.charged_amount !== null },
        paused_because: c.pause_reason,
        scheduled_at: c.scheduled_at,
        started_at: c.started_at,
        completed_at: c.completed_at,
        link: link(ctx, `/app/campaigns/${c.id}`),
      },
    );
  },
};

type FlowRow = { id: string; name: string; key: string; is_enabled: boolean | null; config: Record<string, unknown> | null; created_at?: string };
type VersionRow = { id: string; flow_id: string; status: string; version: number; graph: unknown };

async function stepSummary(graph: unknown): Promise<string[]> {
  const { NODE_META, summary } = await import("@/components/flows/v2/node-meta");
  const g = graph as { nodes?: Array<{ id: string; type: string; data: Record<string, unknown> }> } | null;
  return (g?.nodes ?? [])
    .filter((n) => n.type !== "start" && n.type !== "note")
    .map((n, i) => {
      const meta = (NODE_META as Record<string, { label: string }>)[n.type];
      const text = summary(n as never).replace(/\s+/g, " ").trim().slice(0, 140);
      return `${i + 1}. ${meta?.label ?? n.type}${text ? `: ${text}` : ""}`;
    });
}

const flowsView = ["flows.view", "flows_v2.edit"];

const listFlows: ToolDef = {
  name: "list_flows",
  title: "List chat flows",
  description:
    "List the workspace's chat flows (automated WhatsApp conversations built in Automate > Flows): name, status (Published = switched on, Off, Draft) and whether a trigger starts them.",
  input: { ...workspaceArg, ...pageArgs },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, flowsView, "see flows");
    if (d) return d;
    const { limit, offset } = page(args);
    const org = ctx.workspace.id;
    const { data, error } = await ctx.user
      .from("flows")
      .select("id, name, key, is_enabled, config, created_at")
      .eq("organization_id", org)
      .like("key", "v2:%")
      .order("created_at", { ascending: false })
      .range(offset, offset + limit);
    if (error) return fail("We couldn't read your flows. Please try again.");
    const { isFlowDeleted } = await import("@/lib/flow-delete");
    const rows = ((data ?? []) as FlowRow[]).filter((f) => !isFlowDeleted(f));
    const shown = rows.slice(0, limit);
    const ids = shown.map((f) => f.id);
    const [{ data: versions }, { data: triggers }] = ids.length
      ? await Promise.all([
          ctx.user.from("flow_versions").select("flow_id, status").eq("organization_id", org).in("flow_id", ids),
          ctx.user.from("flow_triggers").select("flow_id, is_enabled").eq("organization_id", org).in("flow_id", ids),
        ])
      : [{ data: [] }, { data: [] }];
    const { flowStatus } = await import("@/lib/flow-status");
    return done(`${shown.length} flow(s).`, {
      flows: shown.map((f) => {
        const published = ((versions ?? []) as Array<{ flow_id: string; status: string }>).some((v) => v.flow_id === f.id && v.status === "published");
        const on = ((triggers ?? []) as Array<{ flow_id: string; is_enabled: boolean }>).filter((t) => t.flow_id === f.id && t.is_enabled).length;
        return {
          flow_id: f.id,
          name: f.name,
          status: flowStatus(f.is_enabled === true, published),
          triggers_on: on,
          link: link(ctx, `/app/flows/v2/${f.id}`),
        };
      }),
      next_cursor: nextCursor(offset, limit, (data ?? []).length),
      link: link(ctx, "/app/flows"),
    });
  },
};

const getFlow: ToolDef = {
  name: "get_flow",
  title: "Read a chat flow",
  description:
    "One chat flow in plain words: status, its steps in order (from the draft being edited, else the published version), whether a trigger starts it, and anything that would stop it from being switched on.",
  input: { ...workspaceArg, flow_id: z.string().min(1).max(64) },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, flowsView, "see flows");
    if (d) return d;
    const org = ctx.workspace.id;
    const flowId = String(args["flow_id"]);
    const { data } = await ctx.user.from("flows").select("id, name, key, is_enabled, config").eq("organization_id", org).eq("id", flowId).maybeSingle();
    const { isFlowDeleted } = await import("@/lib/flow-delete");
    const f = data as FlowRow | null;
    if (!f || !f.key.startsWith("v2:") || isFlowDeleted(f)) return fail(`No chat flow with that id in ${ctx.workspace.name}.`);
    const [{ data: versions }, { data: triggers }] = await Promise.all([
      ctx.user.from("flow_versions").select("id, flow_id, status, version, graph").eq("organization_id", org).eq("flow_id", flowId),
      ctx.user.from("flow_triggers").select("kind, is_enabled").eq("organization_id", org).eq("flow_id", flowId),
    ]);
    const vs = ((versions ?? []) as VersionRow[]).sort((a, b) => b.version - a.version);
    const draft = vs.find((v) => v.status === "draft") ?? null;
    const published = vs.find((v) => v.status === "published") ?? null;
    const shown = draft ?? published;
    const { flowStatus } = await import("@/lib/flow-status");
    const trig = (triggers ?? []) as Array<{ kind: string; is_enabled: boolean }>;
    const on = trig.filter((t) => t.is_enabled);
    const { validateGraph } = await import("@/lib/flow-graph");
    const problems = draft ? validateGraph(draft.graph as never).map((p) => p.message) : [];
    return done(`${f.name}: ${flowStatus(f.is_enabled === true, Boolean(published))}, ${on.length ? `starts on ${on.map((t) => t.kind).join(", ")}` : "no trigger switched on"}.`, {
      flow_id: f.id,
      name: f.name,
      status: flowStatus(f.is_enabled === true, Boolean(published)),
      showing: draft ? `draft (version ${draft.version})` : published ? `published (version ${published.version})` : "nothing saved",
      steps: shown ? await stepSummary(shown.graph) : [],
      triggers: on.map((t) => t.kind),
      draft_problems: problems,
      link: link(ctx, `/app/flows/v2/${f.id}`),
    });
  },
};

const listNeedsAttention: ToolDef = {
  name: "list_needs_attention",
  title: "Chats that need a person",
  description:
    "Customer chats waiting for a person (Aiden handed them over or a flow asked for the team), oldest wait first: who, why, since when, and a short preview of the customer's last message. No other message text is shared. Replying happens in the AiDwar Inbox (link given) — this tool can't message customers.",
  input: { ...workspaceArg, ...pageArgs },
  readOnly: true,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "inbox.view", "see the Inbox");
    if (d) return d;
    const org = ctx.workspace.id;
    const { limit, offset } = page(args);
    const { data, error } = await ctx.user
      .from("conversations")
      .select("id, contact_id, needs_human_reason, needs_human_at, last_customer_message_at")
      .eq("organization_id", org)
      .eq("needs_human", true)
      .order("needs_human_at", { ascending: true })
      .range(offset, offset + limit);
    if (error) return fail("We couldn't read the Inbox. Please try again.");
    const rows = (data ?? []) as Array<{ id: string; contact_id: string | null; needs_human_reason: string | null; needs_human_at: string | null; last_customer_message_at: string | null }>;
    const shown = rows.slice(0, limit);
    const contactIds = shown.map((r) => r.contact_id).filter((x): x is string => Boolean(x));
    const { data: contacts } = contactIds.length
      ? await ctx.user.from("contacts").select("id, name, phone").eq("organization_id", org).in("id", contactIds)
      : { data: [] };
    const byId = new Map(((contacts ?? []) as Array<{ id: string; name: string | null; phone: string }>).map((c) => [c.id, c]));
    const full = seesFullNumbers(ctx);
    const chats = await Promise.all(
      shown.map(async (r) => {
        const { data: last } = await ctx.user
          .from("messages")
          .select("body, type")
          .eq("organization_id", org)
          .eq("conversation_id", r.id)
          .eq("direction", "inbound")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const m = last as { body?: string | null; type?: string | null } | null;
        const preview = m?.body ? String(m.body).replace(/\s+/g, " ").slice(0, 140) : m?.type ? `[${m.type}]` : null;
        const c = r.contact_id ? byId.get(r.contact_id) : undefined;
        return {
          conversation_id: r.id,
          customer: c?.name ?? null,
          phone: c ? (full ? c.phone : maskPhone(c.phone)) : null,
          reason: r.needs_human_reason,
          waiting_since: r.needs_human_at,
          last_customer_message_preview: preview,
          link: link(ctx, `/app/inbox?c=${r.id}`),
        };
      }),
    );
    return done(chats.length ? `${chats.length} chat(s) need a person.` : "No chats need a person right now.", {
      chats,
      next_cursor: nextCursor(offset, limit, rows.length),
      link: link(ctx, "/app/inbox"),
    });
  },
};

// ---------------------------------------------------------------------------
// Tools that may change something
// ---------------------------------------------------------------------------

const conditionInput = z.object({
  field: z.enum(["tag", "opt_in_status", "name", "phone", "created_at", "source", "attribute"]),
  operator: z.string().min(1).max(20).describe("tag: has | not_has; opt_in_status: is; name: contains; phone: contains | starts_with; created_at: before | after | between; source: is | is_not; attribute: equals | contains | gt | lt | date_before | date_after | is_empty | is_not_empty."),
  value: z.string().max(200).optional().describe("For tag rules give the tag NAME. Dates as YYYY-MM-DD."),
  value2: z.string().max(200).optional().describe("Second date for 'between'."),
  key: z.string().max(60).optional().describe("Attribute name for attribute rules."),
});

const createSegment: ToolDef = {
  name: "create_segment",
  title: "Create a segment",
  description:
    "Save a new customer segment (an audience) from rules, e.g. customers tagged VIP. It only saves the rules — nothing is sent. Returns the segment_id (use it in create_campaign_draft) and how many opted-in customers it reaches.",
  input: {
    ...workspaceArg,
    name: z.string().min(1).max(80),
    description: z.string().max(300).optional(),
    match: z.enum(["all", "any"]).optional().describe("all = every rule must match (default); any = at least one."),
    rules: z.array(conditionInput).min(1).max(10),
  },
  readOnly: false,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "segments.manage", "create segments");
    if (d) return d;
    const org = ctx.workspace.id;
    const { FIELD_OPERATORS, usableConditions } = await import("@/lib/segments");
    const rules = args["rules"] as Array<{ field: string; operator: string; value?: string; value2?: string; key?: string }>;
    const conditions: Array<Record<string, string>> = [];
    for (const r of rules) {
      const ops = FIELD_OPERATORS[r.field as keyof typeof FIELD_OPERATORS].map((o) => o.value);
      if (!ops.includes(r.operator)) return fail(`"${r.operator}" isn't a rule for ${r.field}. Use one of: ${ops.join(", ")}.`);
      let value = r.value;
      if (r.field === "tag") {
        const { ids, missing } = await resolveTagIds(ctx.user, org, [String(r.value ?? "")]);
        if (missing.length) return fail(`No tag called "${String(r.value ?? "")}" in ${ctx.workspace.name}.`);
        value = ids[0];
      }
      conditions.push({
        field: r.field,
        operator: r.operator,
        ...(value !== undefined ? { value } : {}),
        ...(r.value2 !== undefined ? { value2: r.value2 } : {}),
        ...(r.key !== undefined ? { key: r.key } : {}),
      });
    }
    const filters = { match: args["match"] === "any" ? "any" : "all", conditions };
    if (usableConditions(filters as never).length !== conditions.length)
      return fail("Every rule needs its value (and attribute rules their key, 'between' both dates).");
    const name = String(args["name"]).trim();
    const { data: clash } = await ctx.service.from("segments").select("id").eq("organization_id", org).eq("name", name).maybeSingle();
    if (clash) return fail(`A segment called "${name}" already exists. Pick another name, or use its segment_id: ${String((clash as { id: string }).id)}.`);
    const { data: row, error } = await ctx.service
      .from("segments")
      .insert({
        organization_id: org,
        name,
        description: args["description"] ? String(args["description"]).trim() : null,
        filters,
        created_by: ctx.caller.userId,
      })
      .select("id")
      .single();
    if (error || !row) return fail("We couldn't save this segment. Please try again.");
    const segmentId = String((row as { id: string }).id);
    const { audienceSummary } = await import("@/lib/campaigns.server");
    const s = await audienceSummary(ctx.user, org, segmentId).catch(() => null);
    return done(
      `Segment "${name}" saved${s ? `: ${s.eligible} opted-in customer(s)` : ""}. Nothing was sent.`,
      { segment_id: segmentId, name, opted_in: s?.eligible ?? null, matched: s?.matched ?? null, link: link(ctx, "/app/contacts?tab=segments") },
      { action: "mcp_segment_created", objectId: segmentId, details: { name } },
    );
  },
};

export const variableInput = z.union([
  z.string().max(1000),
  z.object({
    source: z.enum(["name", "phone", "attribute", "static"]),
    key: z.string().max(60).optional().describe("Attribute name when source is attribute."),
    value: z.string().max(1000).optional().describe("Text when source is static."),
  }),
]);

type DraftRow = {
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
  created_at?: string;
  [key: string]: unknown;
};

/** What a campaign draft's confirm_code is bound to: audience + template + schedule (+ name, values, number). */
async function campaignDraftState(db: SupabaseClient, d: DraftRow): Promise<unknown> {
  const { sanitizeSendSettings } = await import("@/lib/campaigns");
  let segment: unknown = null;
  if (d.segment_id) {
    const { data } = await db.from("segments").select("id, filters, updated_at").eq("organization_id", d.organization_id).eq("id", d.segment_id).maybeSingle();
    segment = data ?? "missing";
  }
  return {
    name: d.name,
    template: [d.template_name, d.template_language],
    number: d.whatsapp_account_id,
    values: d.variable_mappings ?? {},
    send: sanitizeSendSettings(d.send_settings),
    audience: d.segment_id ? { segment } : "all_opted_in",
    schedule: d.scheduled_at ? new Date(d.scheduled_at).toISOString() : null,
  };
}

const createCampaignDraft: ToolDef = {
  name: "create_campaign_draft",
  title: "Draft a campaign",
  description:
    "Draft a WhatsApp campaign — it is saved as a draft and NOT sent. Give a name, an approved template (list_templates) with a value for each of its body variables, and an audience: segment_id, or all_opted_in. (For customers with a tag, create_segment first.) Returns the draft's campaign_id, how many opted-in customers it will reach, the estimated cost, the wallet balance, a confirm_code and a link to review it in AiDwar. Show the user these details; only if they clearly say to send, call send_campaign with the campaign_id and confirm_code.",
  input: {
    ...workspaceArg,
    name: z.string().min(1).max(120),
    template_name: z.string().min(1).max(512),
    template_language: z.string().max(15).optional().describe("Only when the template exists in several languages."),
    variables: z
      .record(z.string().regex(/^\d{1,2}$/), variableInput)
      .optional()
      .describe('One value per body variable, keyed by its number: {"1": {"source":"name"}, "2": "20% off"}. A plain string is the same text for everyone; source name/phone/attribute fills it per customer.'),
    segment_id: z.string().min(1).max(64).optional(),
    all_opted_in: z.boolean().optional(),
    whatsapp_number_id: z.string().min(1).max(64).optional().describe("Send from this number (get_workspace_overview); default: the workspace's default number."),
    schedule_at: z.string().datetime({ offset: true }).optional().describe("ISO time to send later; leave out to send as soon as it is confirmed."),
    header_media_url: z.string().url().max(2000).optional().describe("https link to the picture/video/document for a template with a media header."),
    coupon_code: z.string().max(15).optional().describe("For a template with a copy-code button."),
    offer_expires_at: z.string().datetime({ offset: true }).optional().describe("For a limited-time-offer template."),
  },
  readOnly: false,
  destructive: false,
  run: async (ctx, args) => {
    const d = denied(ctx, "campaigns.create", "create campaigns");
    if (d) return d;
    const org = ctx.workspace.id;
    const db = ctx.service;
    const hasSegment = Boolean(args["segment_id"]);
    if (hasSegment === (args["all_opted_in"] === true))
      return fail("Choose the audience: give segment_id, or all_opted_in: true (to target a tag, create_segment first).");

    const { workspaceLocked, campaignCategory } = await import("@/lib/campaign-launch.server");
    if (await workspaceLocked(db, org)) return fail("This workspace is locked — choose a plan in AiDwar to continue.");

    const { getWhatsAppConnection } = await import("@/lib/whatsapp-numbers.server");
    const { connection, error: connectionError } = await getWhatsAppConnection(db, org, (args["whatsapp_number_id"] as string | undefined) ?? null);
    if (!connection) return fail(connectionError ?? "Connect a WhatsApp number in AiDwar before drafting a campaign.");

    let tq = ctx.user
      .from("message_templates")
      .select("name, language, category, components, status")
      .eq("organization_id", org)
      .eq("waba_id", connection.wabaId)
      .eq("name", String(args["template_name"]).trim())
      .eq("status", "APPROVED");
    if (args["template_language"]) tq = tq.eq("language", String(args["template_language"]));
    const { data: template } = await tq.limit(1).maybeSingle();
    const t = template as { name: string; language: string; category: string | null; components: unknown } | null;
    if (!t) return fail("That template isn't approved on this WhatsApp number. Use list_templates to pick an approved one.");

    const { templateVariableSpec, templateHeader } = await import("@/lib/templates");
    const spec = templateVariableSpec(t.components as never);
    const header = templateHeader(t.components as never);
    if (spec.cards.some((c) => !c.mediaUrl)) return fail("This carousel template needs a picture per card — set it up in the AiDwar campaign wizard.");
    if (spec.headerMedia && spec.headerMedia.format !== "LOCATION" && !args["header_media_url"] && !header?.mediaUrl)
      return fail(`This template has a ${spec.headerMedia.format.toLowerCase()} header: give header_media_url (an https link).`);
    if (spec.copyCodeButtons.length && !args["coupon_code"]) return fail("This template has a copy-code button: give coupon_code.");
    if (spec.offerExpiration && !args["offer_expires_at"]) return fail("This limited-time-offer template needs offer_expires_at.");

    const given = (args["variables"] ?? {}) as Record<string, string | { source: string; key?: string; value?: string }>;
    const mappings: Record<string, { source: string; key?: string; value?: string }> = {};
    for (const n of spec.body) {
      const v = given[String(n)];
      if (v === undefined) return fail(`Give a value for {{${n}}} (variables["${n}"]).`);
      if (typeof v === "string") {
        if (!v.trim()) return fail(`{{${n}}} can't be empty.`);
        mappings[String(n)] = { source: "static", value: v };
      } else {
        if (v.source === "attribute" && !v.key) return fail(`{{${n}}}: an attribute value needs its key.`);
        if (v.source === "static" && !String(v.value ?? "").trim()) return fail(`{{${n}}}: give the text in value.`);
        mappings[String(n)] = { source: v.source, ...(v.key ? { key: v.key } : {}), ...(v.value ? { value: v.value } : {}) };
      }
    }

    let scheduledAt: string | null = null;
    if (args["schedule_at"]) {
      const at = new Date(String(args["schedule_at"]));
      if (at.getTime() <= ctx.now() + 60_000) return fail("schedule_at must be in the future (or leave it out to send once confirmed).");
      if (at.getTime() > ctx.now() + 90 * 864e5) return fail("schedule_at can be at most 90 days ahead.");
      scheduledAt = at.toISOString();
    }

    const segmentId = (args["segment_id"] as string | undefined) ?? null;
    const { audienceSummary, isSegmentNotFound } = await import("@/lib/campaigns.server");
    let recipients: number;
    let excluded: number;
    try {
      const s = await audienceSummary(ctx.user, org, segmentId);
      recipients = s.eligible;
      excluded = s.excluded;
    } catch (error) {
      if (isSegmentNotFound(error)) return fail(error.message);
      return fail("We couldn't work out this audience. Please try again.");
    }
    if (recipients === 0) return fail("No opted-in customers match this audience, so there's nobody to send to.");

    const { campaignCostEstimate } = await import("@/lib/billing.server");
    const estimate = await campaignCostEstimate(db, {
      organizationId: org,
      recipients,
      category: campaignCategory(t.category),
      whatsappAccountId: connection.accountId,
    });

    const { sanitizeSendSettings } = await import("@/lib/campaigns");
    const sendSettings = sanitizeSendSettings({
      header_media_url: args["header_media_url"],
      coupon_code: args["coupon_code"],
      offer_expires_at: args["offer_expires_at"],
    });
    const { data: inserted, error } = await db
      .from("campaigns")
      .insert({
        organization_id: org,
        name: String(args["name"]).trim(),
        whatsapp_account_id: connection.accountId,
        template_name: t.name,
        template_language: t.language,
        variable_mappings: mappings,
        send_settings: { ...sendSettings, mcp: { client_id: ctx.caller.clientId, drafted_at: new Date(ctx.now()).toISOString() } },
        segment_id: segmentId,
        status: "draft",
        scheduled_at: scheduledAt,
        total_recipients: recipients,
        estimated_cost: estimate.enabled ? estimate.estimate : null,
        created_by: ctx.caller.userId,
      })
      .select("*")
      .single();
    if (error || !inserted) return fail("We couldn't save this draft. Please try again.");
    const draft = inserted as DraftRow;
    const hash = await stateHash(await campaignDraftState(db, draft));
    const code = await issueConfirmCode(
      { userId: ctx.caller.userId, workspaceId: org, objectId: draft.id, action: "send_campaign", stateHash: hash },
      ctx.now(),
      ...(ctx.confirmSecret ? [ctx.confirmSecret] : []),
    );
    const cost = estimate.enabled ? money(estimate.estimate, estimate.currency) : null;
    const wallet = estimate.enabled ? money(estimate.available, estimate.currency) : null;
    const lines = [
      `Draft "${draft.name}" saved — not sent.`,
      `${recipients} opted-in customer(s) will get "${t.name}"${excluded ? ` (${excluded} not opted in are left out)` : ""}${scheduledAt ? `, scheduled for ${scheduledAt}` : " as soon as it's confirmed"}.`,
      cost ? `Estimated cost ${cost}; wallet available ${wallet}.` : null,
      estimate.enabled && !estimate.can_send ? "The wallet doesn't cover this yet: add credits in AiDwar before sending." : null,
      estimate.enabled && estimate.needs_approval ? "It is above the workspace's approval limit, so an owner will be asked to approve it after sending." : null,
      "Ask the user to confirm; only then call send_campaign with campaign_id and confirm_code (valid 15 minutes).",
    ].filter(Boolean);
    return done(
      lines.join(" "),
      {
        campaign_id: draft.id,
        status: "draft",
        name: draft.name,
        template: { name: t.name, language: t.language, category: String(t.category ?? "").toLowerCase() || null },
        recipients,
        not_opted_in_left_out: excluded,
        scheduled_at: scheduledAt,
        estimated_cost: estimate.enabled ? { amount: estimate.estimate, currency: estimate.currency, text: cost } : null,
        wallet_available: estimate.enabled ? { amount: estimate.available, currency: estimate.currency, text: wallet } : null,
        wallet_covers_it: estimate.enabled ? estimate.can_send : null,
        needs_owner_approval: estimate.enabled ? estimate.needs_approval : false,
        confirm_code: code.code,
        confirm_code_expires_at: code.expiresAt,
        link: link(ctx, `/app/campaigns/${draft.id}`),
      },
      { action: "mcp_campaign_drafted", objectId: draft.id, details: { name: draft.name, template: t.name, recipients } },
    );
  },
};

const sendCampaign: ToolDef = {
  name: "send_campaign",
  title: "Send a drafted campaign",
  description:
    "Send (or schedule) a campaign drafted with create_campaign_draft. ONLY call this after the user has seen the draft's recipients and cost and explicitly confirmed. Needs the campaign_id and the confirm_code from the draft (one use, 15 minutes). AiDwar checks again at this moment: your permission, that the draft is unchanged, opt-in, the template's approval and the wallet.",
  input: {
    ...workspaceArg,
    campaign_id: z.string().min(1).max(64),
    confirm_code: z.string().min(1).max(80),
  },
  readOnly: false,
  destructive: true,
  run: async (ctx, args) => {
    const d = denied(ctx, "campaigns.send", "send campaigns");
    if (d) return d;
    const org = ctx.workspace.id;
    const db = ctx.service;
    const { data } = await db.from("campaigns").select("*").eq("organization_id", org).eq("id", String(args["campaign_id"])).maybeSingle();
    const draft = data as DraftRow | null;
    if (!draft) return fail(`No campaign draft with that id in ${ctx.workspace.name}.`);
    if (draft.status !== "draft") return fail(`This campaign is already ${draft.status.replace(/_/g, " ")} — a confirm_code works once.`);
    if (!(draft.send_settings as { mcp?: unknown } | null)?.mcp)
      return fail("Only drafts made by create_campaign_draft can be sent from here. Open it in AiDwar to send it.");

    const hash = await stateHash(await campaignDraftState(db, draft));
    const check = await verifyConfirmCode(
      args["confirm_code"],
      { userId: ctx.caller.userId, workspaceId: org, objectId: draft.id, action: "send_campaign", stateHash: hash },
      ctx.now(),
      ...(ctx.confirmSecret ? [ctx.confirmSecret] : []),
    );
    if (!check.ok) return fail(CONFIRM_REFUSALS[check.reason]);
    if (draft.scheduled_at && Date.parse(draft.scheduled_at) <= ctx.now())
      return fail("The scheduled time has passed. Create a new draft with a new time (or none).");

    const { takeSendRate } = await import("@/lib/mcp-access.server");
    const rate = await takeSendRate(db, org);
    if (!rate.allowed) return fail(`At most 5 campaigns an hour can be sent from AI assistants. Try again in ${Math.ceil(rate.retryAfter / 60)} minute(s), or send it from AiDwar.`);

    // The draft is claimed by removing it (only while it is still a draft):
    // a second call with the same code finds nothing to send.
    const { count, error: claimError } = await db
      .from("campaigns")
      .delete({ count: "exact" })
      .eq("id", draft.id)
      .eq("organization_id", org)
      .eq("status", "draft");
    if (claimError || !count) return fail("This draft was already sent or changed. Create a new draft.");
    const restore = async () => {
      await db.from("campaigns").insert({ ...draft });
    };

    const { sanitizeSendSettings } = await import("@/lib/campaigns");
    const { launchCampaign } = await import("@/lib/campaign-launch.server");
    const result = await launchCampaign(db, {
      organizationId: org,
      userId: ctx.caller.userId,
      name: draft.name,
      templateName: String(draft.template_name ?? ""),
      templateLanguage: draft.template_language,
      whatsappAccountId: draft.whatsapp_account_id,
      segmentId: draft.segment_id,
      mappings: (draft.variable_mappings ?? {}) as never,
      sendSettings: sanitizeSendSettings(draft.send_settings),
      scheduledAt: draft.scheduled_at ? new Date(draft.scheduled_at) : null,
      activityDetails: { source: "mcp", tool: "send_campaign", client_id: ctx.caller.clientId, client_name: ctx.caller.clientName, draft_id: draft.id },
    }).catch(() => null);
    if (!result || !result.ok) {
      await restore();
      return fail(result ? `Not sent: ${result.error}` : "Not sent: something went wrong. The draft is unchanged; please try again.", {
        campaign_id: draft.id,
        status: "draft",
        ...(result && result.estimate ? { estimate: result.estimate } : {}),
      });
    }
    const status = result.status;
    const when =
      status === "awaiting_approval"
        ? "It is waiting for an owner's approval (it is above the workspace's spend limit)."
        : status === "scheduled"
          ? `It is scheduled for ${result.scheduledAt}.`
          : "Sending has started.";
    return done(
      `Campaign "${draft.name}" confirmed for ${result.totalRecipients} opted-in customer(s). ${when}`,
      {
        campaign_id: result.campaignId,
        draft_id: draft.id,
        status,
        recipients: result.totalRecipients,
        estimated_cost: result.estimatedCost,
        scheduled_at: result.scheduledAt,
        link: link(ctx, `/app/campaigns/${result.campaignId}`),
      },
      { action: "mcp_campaign_sent", objectId: result.campaignId, details: { draft_id: draft.id, status, recipients: result.totalRecipients } },
    );
  },
};

const graphInput = z.object({
  nodes: z
    .array(z.object({ id: z.string().min(1).max(64), type: z.string().min(1).max(40), position: z.any().optional(), data: z.record(z.string(), z.unknown()) }))
    .min(2)
    .max(200),
  edges: z
    .array(z.object({ id: z.string().min(1).max(64), source: z.string(), target: z.string(), sourceHandle: z.string().nullable().optional() }))
    .max(1000),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/** Steps an AI assistant may not put in a flow: they call out to the internet. */
const MCP_BLOCKED_STEPS = new Set(["http"]);

async function flowsV2Gate(ctx: ToolContext): Promise<ToolOutcome | null> {
  const d = denied(ctx, "flows_v2.edit", "edit flows");
  if (d) return d;
  const { flowsV2Enabled } = await import("@/lib/flow-engine.server");
  if (!(await flowsV2Enabled(ctx.service, ctx.workspace.id))) return fail("Chat flows (Flows v2) aren't switched on for this workspace.");
  return null;
}

const flowState = (flowId: string, versionId: string, graph: unknown) => ({ flow: flowId, version: versionId, graph });

const createFlowDraft: ToolDef = {
  name: "create_flow_draft",
  title: "Draft a chat flow",
  description:
    "Create a new chat flow as a DRAFT — it is always saved switched off and never runs until activated. Either pick a starter (blank, welcome_message, keyword_reply, …) or give a full graph: nodes (each {id, type, data}; types are the builder's step keys such as start, text, buttons, list, ask, wait, branch, tag, assign, needs_you, template, end) and edges ({id, source, target, sourceHandle}). Exactly one start step. Returns the steps in plain words, anything that must be fixed before it can go live, a builder link, and — when it is ready — a confirm_code for activate_flow. Show the user the steps; activate only after they confirm.",
  input: {
    ...workspaceArg,
    name: z.string().min(1).max(80),
    starter: z.string().max(40).optional().describe("A starter key; leave out when giving graph."),
    graph: graphInput.optional(),
  },
  readOnly: false,
  destructive: false,
  run: async (ctx, args) => {
    const gate = await flowsV2Gate(ctx);
    if (gate) return gate;
    const org = ctx.workspace.id;
    if (Boolean(args["starter"]) === Boolean(args["graph"])) return fail("Give either starter or graph.");
    const { STARTERS } = await import("@/lib/flow-starters");
    let graph: unknown;
    if (args["starter"]) {
      const s = STARTERS.find((x) => x.key === args["starter"]);
      if (!s) return fail(`No starter "${String(args["starter"])}". Starters: ${STARTERS.map((x) => x.key).join(", ")}.`);
      graph = s.graph();
    } else {
      graph = args["graph"];
    }
    const { NODE_META } = await import("@/components/flows/v2/node-meta");
    const nodes = (graph as { nodes: Array<{ type: string; position?: unknown }> }).nodes;
    const unknownType = nodes.find((n) => !(n.type in NODE_META));
    if (unknownType) return fail(`"${unknownType.type}" isn't a flow step. Steps: ${Object.keys(NODE_META).join(", ")}.`);
    const blocked = nodes.find((n) => MCP_BLOCKED_STEPS.has(n.type));
    if (blocked) return fail("Web request (HTTP) steps can't be added from an AI assistant. Add them in the AiDwar flow builder.");
    nodes.forEach((n, i) => {
      if (!n.position) n.position = { x: 80 + (i % 3) * 300, y: 60 + Math.floor(i / 3) * 200 };
    });

    const { createFlowV2, draftOfFlowV2, flowV2PublishProblems } = await import("@/lib/flow-v2-actions.server");
    const created = await createFlowV2(ctx.service, {
      organizationId: org,
      userId: ctx.caller.userId,
      name: String(args["name"]).trim(),
      graph,
      activityDetails: { source: "mcp", client_id: ctx.caller.clientId },
    });
    if (!created.ok) return fail(created.error);
    const draft = await draftOfFlowV2(ctx.service, org, created.flowId);
    if (!draft) return fail("The flow was saved but its draft couldn't be read back. Open it in AiDwar.");
    const problems = (await flowV2PublishProblems(ctx.service, org, draft.graph as never)).map((p) => p.message);
    const steps = await stepSummary(draft.graph);
    const code = problems.length
      ? null
      : await issueConfirmCode(
          {
            userId: ctx.caller.userId,
            workspaceId: org,
            objectId: created.flowId,
            action: "activate_flow",
            stateHash: await stateHash(flowState(created.flowId, draft.id, draft.graph)),
          },
          ctx.now(),
          ...(ctx.confirmSecret ? [ctx.confirmSecret] : []),
        );
    return done(
      `Flow "${String(args["name"]).trim()}" saved as a draft, switched off, with ${steps.length} step(s). ${
        problems.length
          ? `Before it can go live: ${problems.join(" ")} Fix it in the builder.`
          : "Show the user the steps; only if they confirm, call activate_flow with flow_id and confirm_code (valid 15 minutes). It starts only once it has a trigger (added in the builder)."
      }`,
      {
        flow_id: created.flowId,
        status: "Draft",
        switched_on: false,
        steps,
        problems,
        confirm_code: code?.code ?? null,
        confirm_code_expires_at: code?.expiresAt ?? null,
        link: link(ctx, `/app/flows/v2/${created.flowId}`),
      },
      { action: "mcp_flow_drafted", objectId: created.flowId, details: { steps: steps.length, ready: !problems.length } },
    );
  },
};

const activateFlow: ToolDef = {
  name: "activate_flow",
  title: "Switch a drafted flow on",
  description:
    "Publish and switch on a chat flow drafted with create_flow_draft. ONLY after the user has seen its steps and explicitly confirmed. Needs flow_id and the confirm_code from the draft (one use, 15 minutes). AiDwar checks again at this moment: your permission, that the draft is unchanged and still off, and that every step is valid.",
  input: { ...workspaceArg, flow_id: z.string().min(1).max(64), confirm_code: z.string().min(1).max(80) },
  readOnly: false,
  destructive: true,
  run: async (ctx, args) => {
    const gate = await flowsV2Gate(ctx);
    if (gate) return gate;
    const org = ctx.workspace.id;
    const flowId = String(args["flow_id"]);
    const { ownFlowV2, draftOfFlowV2, publishFlowV2 } = await import("@/lib/flow-v2-actions.server");
    const flow = await ownFlowV2(ctx.service, org, flowId);
    if (!flow) return fail(`No chat flow with that id in ${ctx.workspace.name}.`);
    const { data: state } = await ctx.service.from("flows").select("is_enabled").eq("id", flowId).eq("organization_id", org).maybeSingle();
    if ((state as { is_enabled?: boolean } | null)?.is_enabled) return fail("This flow is already switched on — a confirm_code works once.");
    const draft = await draftOfFlowV2(ctx.service, org, flowId);
    if (!draft) return fail("This flow has no draft to switch on.");
    const check = await verifyConfirmCode(
      args["confirm_code"],
      {
        userId: ctx.caller.userId,
        workspaceId: org,
        objectId: flowId,
        action: "activate_flow",
        stateHash: await stateHash(flowState(flowId, draft.id, draft.graph)),
      },
      ctx.now(),
      ...(ctx.confirmSecret ? [ctx.confirmSecret] : []),
    );
    if (!check.ok) return fail(CONFIRM_REFUSALS[check.reason]);
    const published = await publishFlowV2(ctx.service, {
      organizationId: org,
      userId: ctx.caller.userId,
      flowId,
      activityDetails: { source: "mcp", client_id: ctx.caller.clientId },
    });
    if (!published.ok) {
      if ("problems" in published) return fail(`Not switched on: ${published.problems.map((p) => p.message).join(" ")}`);
      return fail(`Not switched on: ${published.error}`);
    }
    const { data: triggers } = await ctx.user.from("flow_triggers").select("kind, is_enabled").eq("organization_id", org).eq("flow_id", flowId);
    const on = ((triggers ?? []) as Array<{ is_enabled: boolean }>).filter((t) => t.is_enabled).length;
    return done(
      `Flow "${flow.name}" is published and switched on (version ${published.version}). ${on ? "" : "It has no trigger yet, so it won't start until one is added in the builder."}`.trim(),
      { flow_id: flowId, status: "Published", version: published.version, triggers_on: on, link: link(ctx, `/app/flows/v2/${flowId}`) },
      { action: "mcp_flow_activated", objectId: flowId, details: { version: published.version } },
    );
  },
};

export const MCP_TOOLS: ToolDef[] = [
  listWorkspaces,
  getWorkspaceOverview,
  listTemplates,
  listSegments,
  countAudience,
  searchContacts,
  listCampaigns,
  getCampaignReport,
  listFlows,
  getFlow,
  listNeedsAttention,
  createSegment,
  createCampaignDraft,
  sendCampaign,
  createFlowDraft,
  activateFlow,
];
