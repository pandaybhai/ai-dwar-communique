import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssistantsOverview } from "./mcp-workspace";

/**
 * Batch 53 — the AI assistants page (/app/ai-assistants) in Classic and
 * Aiden Workspace, the Home card, and the shared prompt library. No live
 * database: the server reads run on a fake query builder.
 */

const h = vi.hoisted(() => ({ org: {} as Record<string, unknown> }));
vi.mock("@/lib/org-context", () => ({ useOrg: () => h.org }));
vi.mock("@/integrations/aidwar/client", () => ({ aidwar: { auth: {} } }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const src = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

const overview = (over: Partial<AssistantsOverview> = {}): AssistantsOverview => ({
  mcpOn: true,
  supportLocked: false,
  canManage: true,
  seesEveryone: true,
  apps: [
    { userId: "u1", member: "You", mine: true, clientId: "c-claude", name: "Claude", site: "claude.ai", grantedAt: "2026-10-20T10:00:00Z", lastUsedAt: "2026-10-29T10:00:00Z" },
    { userId: "u2", member: "Asha", mine: false, clientId: "c-cursor", name: "Cursor", site: null, grantedAt: "2026-10-21T10:00:00Z", lastUsedAt: null },
  ],
  timeline: [
    { id: "e1", action: "mcp_campaign_drafted", at: "2026-10-29T09:00:00Z", userId: "u1", member: "You", app: "Claude", appId: "c-claude", name: "Diwali VIP", link: "/app/campaigns/k1" },
  ],
  usage: { callsThisMinute: 3, callsPerMinute: 60, sendsThisHour: 1, sendsPerHour: 5 },
  ...over,
});

async function renderPage(data: AssistantsOverview) {
  const { AiAssistantsView } = await import("@/components/ai-assistants/ai-assistants-page");
  return renderToStaticMarkup(<AiAssistantsView data={data} ownApps={<p>own apps</p>} />);
}

describe("the prompt library: one source, only prompts today's tools can do", () => {
  it("every prompt names real MCP tools, and the seeds that need a future tool are left out", async () => {
    const { PROMPT_GROUPS, LIBRARY_PROMPTS, STARTER_PROMPTS } = await import("./mcp-prompts");
    const { MCP_TOOLS } = await import("./mcp-tools.server");
    const names = new Set(MCP_TOOLS.map((t) => t.name));
    expect(names.size).toBe(16);
    expect(PROMPT_GROUPS.map((g) => g.title)).toEqual(["Grow sales", "Know your numbers", "Automate", "Daily check"]);
    for (const p of LIBRARY_PROMPTS) {
      expect(p.tools.length).toBeGreaterThan(0);
      for (const t of p.tools) expect(names.has(t), `${p.text}: ${t}`).toBe(true);
    }
    const texts = LIBRARY_PROMPTS.map((p) => p.text);
    for (const kept of [
      "Compare my last 3 campaigns and tell me which template worked best",
      "Build a welcome flow that asks new customers their size and city",
      "Which chats need me right now, oldest first?",
      "Summarise today in 5 lines",
      "Draft a Diwali campaign to customers tagged VIP",
      "How many opted-in customers do I have, and how much is left in my wallet?",
    ])
      expect(texts).toContain(kept);
    for (const left of [
      "Draft a festive offer to customers who bought in the last 90 days",
      "Win back customers who haven't replied in 60 days",
      "How much did I spend on WhatsApp this month?",
      "Make a flow that follows up 2 days after an order",
    ])
      expect(texts).not.toContain(left);
    for (const s of STARTER_PROMPTS) expect(texts).toContain(s);
  });

  it("the in-app page and /developers read mcp-prompts.ts; no prompt is typed anywhere else", async () => {
    const { EXAMPLE_PROMPTS } = await import("./mcp-connect");
    const { LIBRARY_PROMPTS } = await import("./mcp-prompts");
    expect(EXAMPLE_PROMPTS).toEqual(LIBRARY_PROMPTS.map((p) => p.text));
    expect(src("components/ai-assistants/parts.tsx")).toContain("PROMPT_GROUPS");
    expect(src("components/developers/mcp-section.tsx")).toContain("PROMPT_GROUPS");
    for (const f of [
      "components/ai-assistants/parts.tsx",
      "components/ai-assistants/ai-assistants-page.tsx",
      "components/developers/mcp-section.tsx",
    ]) {
      expect(src(f)).not.toContain("Compare my last 3 campaigns");
    }
  });

  it("the limits shown are the limits enforced", async () => {
    const shown = await import("./mcp-connect");
    const enforced = await import("./mcp-access.server");
    expect(shown.MCP_CALLS_PER_MINUTE).toBe(enforced.CALLS_PER_MINUTE);
    expect(shown.MCP_SENDS_PER_HOUR).toBe(enforced.SENDS_PER_HOUR);
  });
});

describe("the AI assistants page", () => {
  it("has the five sections: connect (five tabs, plan notes), apps, activity, prompts, safety with usage", async () => {
    const html = await renderPage(overview());
    const t = text(html);
    for (const id of ["connect", "apps", "activity", "prompts", "safety"]) expect(html).toContain(`id="${id}"`);
    expect(t).toContain("https://aidwar.in/mcp");
    for (const tab of ["Claude", "ChatGPT", "Codex", "Cursor", "Other MCP apps"]) expect(t).toContain(tab);
    // The default tab's steps and the plan note; the other tabs' come from the same file.
    expect(t).toContain("Free (one custom connector)");
    const { CONNECT_CLIENTS } = await import("./mcp-connect");
    expect(CONNECT_CLIENTS.find((c) => c.key === "chatgpt")!.availability).toMatch(/Business and Enterprise\/Edu/);
    expect(t).toMatch(/Claude\s+drafted a campaign/);
    expect(t).toContain("Diwali VIP");
    expect(html).toContain('href="/app/campaigns/k1"');
    expect(t).toContain("3 of 60");
    expect(t).toContain("1 of 5");
    expect(t).toContain("15 minutes");
    expect(t).toMatch(/can't message a customer on its own, change Aiden, billing, your team or settings, or delete anything/);
    expect(html).not.toContain("<img");
  });

  it("owner/admin: everyone's apps and the workspace switch", async () => {
    const t = text(await renderPage(overview()));
    expect(t).toContain("Your team's apps");
    expect(t).toContain("Cursor");
    expect(t).toContain("for Asha");
    expect(t).toContain("AI assistants in this workspace");
  });

  it("a member without settings.manage: own apps only, no switch, no team list, no person filter", async () => {
    const html = await renderPage(
      overview({ canManage: false, seesEveryone: false, apps: overview().apps!.filter((a) => a.mine) }),
    );
    const t = text(html);
    expect(t).not.toContain("Your team's apps");
    expect(t).not.toContain("AI assistants in this workspace");
    expect(html).not.toContain('id="mcp-access"');
    expect(html).not.toContain('id="ai-filter-member"');
  });

  it("switched off: says so, and who can switch it on", async () => {
    const forOwner = text(await renderPage(overview({ mcpOn: false })));
    expect(forOwner).toContain("AI assistants are switched off for this workspace.");
    expect(forOwner).toContain("switch them on under Safety and limits");
    const forAgent = text(await renderPage(overview({ mcpOn: false, canManage: false, seesEveryone: false })));
    expect(forAgent).toContain("An owner or admin can switch them on from this page.");
    const locked = text(await renderPage(overview({ mcpOn: false, supportLocked: true })));
    expect(locked).toContain("AiDwar support switched them off");
  });

  it("an empty timeline teaches what will show and what to ask", async () => {
    const t = text(await renderPage(overview({ timeline: [] })));
    expect(t).toContain("Nothing yet.");
    expect(t).toContain("Try asking it");
  });

  it("renders the same in both designs (one page; PageHeader gives each its head)", () => {
    const route = src("routes/app/ai-assistants.tsx");
    expect(route).toContain("AiAssistantsPage");
    expect(route).not.toContain("useNewDesign");
    const page = src("components/ai-assistants/ai-assistants-page.tsx");
    expect(page).toContain("<PageHeader");
    expect(page).toContain("<ConnectedAiApps");
  });
});

describe("the menu: Classic sidebar, Aiden Workspace Automate tab + More sheet, command palette", () => {
  it("is a registry page gated by mcp.use, kept while mcp_access is off", async () => {
    const { filterNavItems, groupNav } = await import("@/components/shell/use-nav");
    const { buildShellModel } = await import("@/components/shell/sections");
    const run = (mcpOn: boolean, perms: string[]) =>
      filterNavItems({
        isFeatureEnabled: (k) => (k === "mcp_access" ? mcpOn : true),
        flagsLoading: false,
        can: (p) => perms.includes(p),
        permsLoading: false,
        planStatus: "active",
        automationsCount: 3,
      });
    const withMcp = run(false, ["mcp.use", "ai.use", "flows.view", "automations.view"]);
    const item = withMcp.items.find((i) => i.to === "/app/ai-assistants");
    expect(item?.label).toBe("AI assistants");
    expect(groupNav(withMcp.items, false).find((g) => g.label === "Automation")?.items.map((i) => i.to)).toContain(
      "/app/ai-assistants",
    );
    const model = buildShellModel(withMcp.items, false);
    expect(model.sections.find((s) => s.key === "automate")?.tabs.map((t) => t.label)).toContain("AI assistants");
    expect(model.assistants?.to).toBe("/app/ai-assistants");
    expect(src("components/shell/new-shell.tsx")).toContain("model.assistants");
    // Without mcp.use: nowhere.
    expect(run(true, ["ai.use"]).items.some((i) => i.to === "/app/ai-assistants")).toBe(false);
  });
});

describe("permissions on the server", () => {
  function fakeService(rows: Record<string, unknown[]>, calls: Array<{ table: string; op: string; args: unknown[] }>) {
    const builder = (table: string) => {
      const q: Record<string, unknown> = {};
      const log = (op: string) => (...args: unknown[]) => {
        calls.push({ table, op, args });
        return q;
      };
      for (const op of ["select", "eq", "in", "order", "limit", "not", "is"]) q[op] = log(op);
      q["maybeSingle"] = async () => ({ data: (rows[table] ?? [])[0] ?? null, error: null });
      q["upsert"] = async (row: unknown) => {
        calls.push({ table, op: "upsert", args: [row] });
        return { error: null };
      };
      q["insert"] = async (row: unknown) => {
        calls.push({ table, op: "insert", args: [row] });
        return { error: null };
      };
      q["then"] = (res: (v: unknown) => unknown) => res({ data: rows[table] ?? [], error: null });
      return q;
    };
    return {
      from: builder,
      rpc: async (fn: string, args: unknown) => {
        calls.push({ table: fn, op: "rpc", args: [args] });
        return { data: rows[fn] ?? [], error: null };
      },
    };
  }

  it("the timeline reads only this workspace's mcp entries; a non-admin only their own; apps only their own", async () => {
    const { assistantsOverview } = await import("./mcp-workspace.server");
    const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
    const svc = fakeService({ activity_log: [], mcp_workspace_apps: [] }, calls);
    await assistantsOverview(svc as never, { organizationId: "org-1", userId: "u-agent", role: "agent", permissions: new Set(["mcp.use"]) });
    const log = calls.filter((c) => c.table === "activity_log");
    expect(log).toContainEqual({ table: "activity_log", op: "eq", args: ["organization_id", "org-1"] });
    expect(log).toContainEqual({ table: "activity_log", op: "eq", args: ["details->>source", "mcp"] });
    expect(log).toContainEqual({ table: "activity_log", op: "eq", args: ["user_id", "u-agent"] });
    const inCall = log.find((c) => c.op === "in");
    expect(inCall?.args[1]).toEqual([
      "mcp_segment_created",
      "mcp_campaign_drafted",
      "mcp_campaign_sent",
      "mcp_flow_drafted",
      "mcp_flow_activated",
    ]);
    expect(calls.find((c) => c.op === "rpc" && c.table === "mcp_workspace_apps")?.args[0]).toEqual({ p_org: "org-1", p_user: "u-agent" });

    const adminCalls: typeof calls = [];
    await assistantsOverview(fakeService({}, adminCalls) as never, {
      organizationId: "org-1",
      userId: "u-owner",
      role: "owner",
      permissions: new Set(["mcp.use", "settings.manage"]),
    });
    expect(adminCalls.find((c) => c.op === "rpc" && c.table === "mcp_workspace_apps")?.args[0]).toEqual({ p_org: "org-1", p_user: null });
    expect(adminCalls.some((c) => c.table === "activity_log" && c.op === "eq" && c.args[0] === "user_id")).toBe(false);
  });

  it("the On/Off route checks settings.manage before writing; the write is the mcp_access override, audit-logged", async () => {
    const route = src("routes/api/ai-assistants.ts");
    const post = route.slice(route.indexOf("POST:"));
    expect(post.indexOf('requirePermission(auth, "settings.manage"')).toBeGreaterThan(-1);
    expect(post.indexOf('requirePermission(auth, "settings.manage"')).toBeLessThan(post.indexOf("setMcpAccess("));
    const { setMcpAccess } = await import("./mcp-workspace.server");
    const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
    const r = await setMcpAccess(fakeService({}, calls) as never, { organizationId: "org-1", userId: "u1", enabled: false });
    expect(r).toEqual({ ok: true, enabled: false });
    expect(calls.find((c) => c.op === "upsert")?.args[0]).toEqual({ organization_id: "org-1", flag_key: "mcp_access", enabled: false });
    expect(calls.find((c) => c.table === "activity_log" && c.op === "insert")?.args[0]).toMatchObject({
      organization_id: "org-1",
      action: "mcp_access_changed",
      details: { enabled: false },
    });
  });

  it("can't switch back on what AiDwar support switched off", async () => {
    const { setMcpAccess } = await import("./mcp-workspace.server");
    const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
    const svc = fakeService({ organization_billing_settings: [{ limits_override: { _manual_flags: { mcp: false } } }] }, calls);
    const r = await setMcpAccess(svc as never, { organizationId: "org-1", userId: "u1", enabled: true });
    expect(r.ok).toBe(false);
    expect(calls.some((c) => c.op === "upsert")).toBe(false);
  });
});

describe("Home card: Connect your AI assistant", () => {
  it("shows the URL, two starter prompts and the link; dismiss is remembered per person", async () => {
    const { ConnectAssistantCardView, readDismissed } = await import("@/components/ai-assistants/connect-card");
    const t = text(renderToStaticMarkup(<ConnectAssistantCardView />));
    expect(t).toContain("Connect your AI assistant");
    expect(t).toContain("https://aidwar.in/mcp");
    expect(t).toContain("Which chats need me right now, oldest first?");
    expect(t).toContain("Draft a Diwali campaign to customers tagged VIP");
    expect(renderToStaticMarkup(<ConnectAssistantCardView />)).toContain('href="/app/ai-assistants"');
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) } });
    expect(readDismissed("u1")).toBe(false);
    store.set("aidwar.ai_assistants_card.u1", "1");
    expect(readDismissed("u1")).toBe(true);
    expect(readDismissed("u2")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("hidden without mcp.use, while mcp_access is off, and once dismissed", async () => {
    const { ConnectAssistantCard } = await import("@/components/ai-assistants/connect-card");
    const base = { profile: { id: "u1" }, flagsLoading: false, permissions: [], permissionOverrides: {}, permissionsLoading: false, reloadPermissions: async () => undefined };
    h.org = { ...base, isFeatureEnabled: () => true, can: () => false };
    expect(renderToStaticMarkup(<ConnectAssistantCard />)).toBe("");
    h.org = { ...base, isFeatureEnabled: (k: string) => k !== "mcp_access", can: () => true };
    expect(renderToStaticMarkup(<ConnectAssistantCard />)).toBe("");
  });

  it("sits on both Homes; the Batch 41 Home's own code is untouched", () => {
    expect(src("routes/app/index.tsx")).toContain("<ConnectAssistantCard />");
    expect(src("components/home-v2/new-home.tsx")).toContain("<ConnectAssistantCard");
  });
});

describe("Hallmark floor on the new screens", () => {
  it("tokens only, no tracked capitals, no middle dots, focus-visible, reduced motion", () => {
    for (const f of [
      "components/ai-assistants/parts.tsx",
      "components/ai-assistants/ai-assistants-page.tsx",
      "components/ai-assistants/connect-card.tsx",
    ]) {
      const s = src(f);
      expect(s).not.toMatch(/transition-all|uppercase|tracking-\[0\.|tracking-wide|#[0-9a-fA-F]{6}\b| · /);
      expect(s.match(/animate-spin/g)?.length ?? 0).toBe(s.match(/motion-safe:animate-spin/g)?.length ?? 0);
    }
    expect(src("components/ai-assistants/parts.tsx")).toContain("focus-visible:");
  });
});
