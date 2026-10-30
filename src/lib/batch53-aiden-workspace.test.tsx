import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DESIGN_SWITCHED_EVENT,
  RELEASE_FLAG,
  resolveDesign,
  routeInOtherDesign,
  superAdminOverrideFrom,
  type DesignInputs,
} from "./aiden-workspace";

/**
 * Batch 53 — who sees Aiden Workspace (the new design). Shipped dark: the
 * release flag is OFF by default and a missing row is OFF, which is exactly
 * today's answer (only Super Admin new_design overrides). With it on:
 * Super Admin override > the person's choice > unlocked workspace > Classic.
 * No live database: the org context, router and API are fakes.
 */

const h = vi.hoisted(() => ({
  org: {} as Record<string, unknown>,
  navigations: [] as Array<{ to: string; search: unknown }>,
  location: { pathname: "/app/inbox", search: {} as Record<string, unknown> },
}));

vi.mock("@/lib/org-context", () => ({ useOrg: () => h.org }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  useNavigate: () => (o: { to: string; search: unknown }) => {
    h.navigations.push({ to: o.to, search: o.search });
  },
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) => select({ location: h.location }),
}));
// Under `test:new-design` the setup file forces useNewDesign on; these tests
// exercise the real resolver.
vi.mock("@/lib/new-design", async (orig) => await orig<typeof import("./new-design")>());

const base: DesignInputs = {
  releaseOn: true,
  newDesignToday: false,
  superAdminOverride: null,
  choice: null,
  unlockedAt: null,
  newDesignDefault: false,
};

describe("the resolver, layer by layer", () => {
  it("release flag off or missing: today's new_design answer, never the switch", () => {
    for (const releaseOn of [false, undefined]) {
      expect(resolveDesign({ ...base, releaseOn, newDesignToday: false })).toEqual({
        design: "classic",
        source: "today",
        switchVisible: false,
      });
      // A Super Admin override (Meezoy, Aidwar demo) keeps Aiden Workspace exactly as today.
      expect(resolveDesign({ ...base, releaseOn, newDesignToday: true }).design).toBe("aiden_workspace");
      // Nobody is moved by the unlock rule or their own saved choice.
      expect(
        resolveDesign({ ...base, releaseOn, unlockedAt: "2026-10-01T00:00:00Z", choice: "aiden_workspace" }),
      ).toEqual({ design: "classic", source: "today", switchVisible: false });
    }
  });

  it("a Super Admin override wins over the person's choice and the unlock", () => {
    expect(resolveDesign({ ...base, superAdminOverride: false, choice: "aiden_workspace", unlockedAt: "x" })).toEqual({
      design: "classic",
      source: "super_admin",
      switchVisible: false,
    });
    expect(resolveDesign({ ...base, superAdminOverride: true, choice: "classic" }).design).toBe("aiden_workspace");
  });

  it("the person's own choice beats the workspace default", () => {
    expect(resolveDesign({ ...base, choice: "classic", unlockedAt: "x" })).toEqual({
      design: "classic",
      source: "choice",
      switchVisible: true,
    });
    expect(resolveDesign({ ...base, choice: "aiden_workspace" }).design).toBe("aiden_workspace");
  });

  it("an unlocked workspace defaults to Aiden Workspace; otherwise Classic, with the switch to try it", () => {
    expect(resolveDesign({ ...base, unlockedAt: "2026-10-01T00:00:00Z" })).toEqual({
      design: "aiden_workspace",
      source: "unlocked",
      switchVisible: true,
    });
    expect(resolveDesign(base)).toEqual({ design: "classic", source: "default", switchVisible: true });
  });

  it("a Super Admin override is a hand-set flag or an on row; a plan change's off row is no decision", () => {
    expect(superAdminOverrideFrom(false, null)).toBeNull(); // written by every plan change
    expect(superAdminOverrideFrom(true, null)).toBe(true); // Meezoy, Aidwar demo
    expect(superAdminOverrideFrom(false, false)).toBe(false); // a Super Admin switched it off
    expect(superAdminOverrideFrom(null, true)).toBe(true);
    expect(superAdminOverrideFrom(null, null)).toBeNull();
  });
});

describe("switching keeps the page", () => {
  it("maps every route to the same page, and new-only Settings sections to Classic's equivalent", () => {
    expect(routeInOtherDesign("/app/inbox", { c: "abc" }, "aiden_workspace")).toEqual({ to: "/app/inbox", search: { c: "abc" } });
    expect(routeInOtherDesign("/app/contacts", { tab: "segments" }, "classic")).toEqual({ to: "/app/contacts", search: { tab: "segments" } });
    expect(routeInOtherDesign("/app/campaigns/123/", {}, "classic")).toEqual({ to: "/app/campaigns/123", search: {} });
    expect(routeInOtherDesign("/app/settings", { tab: "ai_apps" }, "classic")).toEqual({ to: "/app/ai-assistants", search: {} });
    expect(routeInOtherDesign("/app/settings", { tab: "notifications" }, "classic").to).toBe("/app/employee");
    expect(routeInOtherDesign("/app/settings", { tab: "optout" }, "classic")).toEqual({ to: "/app/settings", search: { tab: "sources" } });
    expect(routeInOtherDesign("/app/settings", { tab: "team" }, "classic")).toEqual({ to: "/app/settings", search: { tab: "team" } });
    expect(routeInOtherDesign("/app/settings", { tab: "team" }, "aiden_workspace")).toEqual({ to: "/app/settings", search: { tab: "team" } });
    expect(routeInOtherDesign("/app", {}, "aiden_workspace")).toEqual({ to: "/app", search: {} });
  });
});

/** Renders a hook inside a component and hands back what it returned. */
async function hookValue<T>(use: () => T): Promise<T> {
  let out: T | undefined;
  function Probe() {
    out = use();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out as T;
}

function orgWith(over: Record<string, unknown> = {}) {
  const chosen: unknown[] = [];
  h.org = {
    active: { role: "owner", organization: { id: "org-zoori", name: "ZOORI Jewels" } },
    flagsLoading: false,
    isFeatureEnabled: (k: string) => k === "new_design" ? Boolean(over["newDesignToday"]) : false,
    flagDefaults: over["flagDefaults"] ?? {},
    designPrefs: over["designPrefs"] ?? null,
    designPrefsLoading: over["designPrefsLoading"] ?? false,
    chooseDesign: async (...args: unknown[]) => {
      chosen.push(args);
    },
    markIntroSeen: async () => undefined,
  };
  return chosen;
}

describe("the app: flag OFF ships dark", () => {
  beforeEach(() => {
    h.navigations = [];
    h.location = { pathname: "/app/inbox", search: {} };
  });

  it("flag OFF + workspace unlocked + Aiden replying -> Classic, and the switch is hidden in both menus", async () => {
    const { useDesignAnswer, useNewDesign } = await import("./new-design");
    const { DesignSwitchItem } = await import("@/components/shell/design-switch");
    // ZOORI Jewels: Aiden replying, so unlocked by the backfill; the flag row is off.
    orgWith({
      flagDefaults: { [RELEASE_FLAG]: false, new_design: false },
      designPrefs: { superAdminOverride: null, choice: null, unlockedAt: "2026-10-30T00:00:00Z", introSeenAt: null },
    });
    expect(await hookValue(useNewDesign)).toBe(false);
    expect(await hookValue(useDesignAnswer)).toEqual({ design: "classic", source: "today", switchVisible: false });
    expect(renderToStaticMarkup(<DesignSwitchItem current="classic" />)).toBe("");
    expect(renderToStaticMarkup(<DesignSwitchItem current="aiden_workspace" />)).toBe("");
    // A missing release row is off too.
    orgWith({ flagDefaults: { new_design: false }, designPrefs: { superAdminOverride: null, choice: "aiden_workspace", unlockedAt: "x", introSeenAt: null } });
    expect(await hookValue(useNewDesign)).toBe(false);
  });

  it("flag OFF: a Super Admin new_design override still sees Aiden Workspace exactly as today", async () => {
    const { useNewDesign } = await import("./new-design");
    orgWith({ newDesignToday: true, flagDefaults: { new_design: false } });
    expect(await hookValue(useNewDesign)).toBe(true);
  });

  it("a context without the Batch 53 fields (an older test double) answers as Batch 44", async () => {
    const { useNewDesign } = await import("./new-design");
    h.org = { active: { organization: { id: "o" } }, flagsLoading: false, isFeatureEnabled: (k: string) => k === "new_design" };
    expect(await hookValue(useNewDesign)).toBe(true);
    h.org = { active: { organization: { id: "o" } }, flagsLoading: false, isFeatureEnabled: () => false };
    expect(await hookValue(useNewDesign)).toBe(false);
  });

  it("no intro tour while the flag is off, even for an override workspace", async () => {
    const { AidenWorkspaceIntro } = await import("@/components/shell/design-switch");
    orgWith({ newDesignToday: true, flagDefaults: {}, designPrefs: null });
    expect(renderToStaticMarkup(<AidenWorkspaceIntro />)).toBe("");
  });
});

describe("the app: flag ON (after Batch 55)", () => {
  beforeEach(() => {
    h.navigations = [];
  });
  const on = { [RELEASE_FLAG]: true, new_design: false };

  it("an unlocked workspace opens in Aiden Workspace; the switch says Switch to Classic", async () => {
    const { useNewDesign } = await import("./new-design");
    const { useDesignSwitch } = await import("@/components/shell/design-switch");
    orgWith({ flagDefaults: on, designPrefs: { superAdminOverride: null, choice: null, unlockedAt: "x", introSeenAt: null } });
    expect(await hookValue(useNewDesign)).toBe(true);
    const sw = await hookValue(() => useDesignSwitch("aiden_workspace"));
    expect(sw.visible).toBe(true);
    expect(sw.label).toBe("Switch to Classic");
  });

  it("the switch remembers the choice and keeps the page", async () => {
    const { useDesignSwitch } = await import("@/components/shell/design-switch");
    const chosen = orgWith({ flagDefaults: on, designPrefs: { superAdminOverride: null, choice: null, unlockedAt: null, introSeenAt: null } });
    h.location = { pathname: "/app/settings", search: { tab: "ai_apps" } };
    const fromNew = await hookValue(() => useDesignSwitch("aiden_workspace"));
    await fromNew.run();
    expect(chosen).toEqual([["classic", "aiden_workspace", "/app/settings"]]);
    expect(h.navigations).toEqual([{ to: "/app/ai-assistants", search: {} }]);

    h.location = { pathname: "/app/campaigns/42", search: {} };
    const fromClassic = await hookValue(() => useDesignSwitch("classic"));
    expect(fromClassic.label).toBe("Try Aiden Workspace");
    await fromClassic.run();
    expect(chosen[1]).toEqual(["aiden_workspace", "classic", "/app/campaigns/42"]);
    expect(h.navigations[1]).toEqual({ to: "/app/campaigns/42", search: {} });
  });

  it("a saved choice is what the next device shows", async () => {
    const { useNewDesign } = await import("./new-design");
    orgWith({ flagDefaults: on, designPrefs: { superAdminOverride: null, choice: "classic", unlockedAt: "x", introSeenAt: null } });
    expect(await hookValue(useNewDesign)).toBe(false);
    orgWith({ flagDefaults: on, designPrefs: { superAdminOverride: null, choice: "aiden_workspace", unlockedAt: null, introSeenAt: null } });
    expect(await hookValue(useNewDesign)).toBe(true);
  });

  it("a Super Admin override still wins, and then there's no switch to offer", async () => {
    const { useNewDesign } = await import("./new-design");
    const { DesignSwitchItem } = await import("@/components/shell/design-switch");
    orgWith({ flagDefaults: on, designPrefs: { superAdminOverride: true, choice: "classic", unlockedAt: null, introSeenAt: null } });
    expect(await hookValue(useNewDesign)).toBe(true);
    expect(renderToStaticMarkup(<DesignSwitchItem current="aiden_workspace" />)).toBe("");
  });

  it("the first-time intro shows three steps once, then never after it was seen", async () => {
    const { AidenWorkspaceIntro } = await import("@/components/shell/design-switch");
    orgWith({ flagDefaults: on, designPrefs: { superAdminOverride: null, choice: null, unlockedAt: "x", introSeenAt: null } });
    // Radix renders dialogs in a portal (nothing in static markup); the gate is what matters here.
    const { INTRO_STEPS } = await import("./aiden-workspace");
    expect(INTRO_STEPS).toHaveLength(3);
    expect(INTRO_STEPS.map((s) => s.body).join(" ")).toMatch(/Home, Inbox, Campaigns, Customers, Automate and Shop/);
    expect(INTRO_STEPS[2]!.body).toMatch(/Switch to Classic/);
    orgWith({ flagDefaults: on, designPrefs: { superAdminOverride: null, choice: null, unlockedAt: "x", introSeenAt: "2026-10-30T00:00:00Z" } });
    expect(renderToStaticMarkup(<AidenWorkspaceIntro />)).toBe("");
  });
});

describe("the unlock is recorded on the server path that switches Aiden on", () => {
  function fakeDb(mode: string, rpcError: { code?: string; message: string } | null = null) {
    const rpc: Array<{ fn: string; args: unknown }> = [];
    const builder = (table: string) => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      Object.assign(q, {
        select: chain,
        eq: chain,
        is: chain,
        gte: chain,
        limit: () => Promise.resolve({ data: [{ id: "r" }], error: null }),
        insert: () => Promise.resolve({ error: null }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        maybeSingle: () =>
          Promise.resolve({ data: table === "ai_agents" ? { id: "a1", mode } : null, error: null }),
      });
      return q;
    };
    return {
      rpc,
      db: {
        from: builder,
        rpc: async (fn: string, args: unknown) => {
          rpc.push({ fn, args });
          return { data: null, error: rpcError };
        },
      },
    };
  }

  beforeEach(() => {
    vi.doMock("@/lib/ai-agent.server", () => ({ syncAiSwitch: async () => undefined }));
  });

  it("off -> draft or replying stamps; off doesn't; a missing function (file not applied) changes nothing", async () => {
    const { setAgentMode } = await import("./agent-mode.server");
    for (const mode of ["draft", "replying"]) {
      const f = fakeDb("off");
      const r = await setAgentMode(f.db as never, { organizationId: "o1", userId: "u1", mode, skipTest: true });
      expect(r).toEqual({ ok: true, mode });
      expect(f.rpc).toEqual([{ fn: "aiden_workspace_stamp_unlock", args: { p_org: "o1" } }]);
    }
    const off = fakeDb("replying");
    expect(await setAgentMode(off.db as never, { organizationId: "o1", userId: "u1", mode: "off" })).toEqual({ ok: true, mode: "off" });
    expect(off.rpc).toEqual([]);
    const missing = fakeDb("off", { code: "PGRST202", message: "not found" });
    expect(await setAgentMode(missing.db as never, { organizationId: "o1", userId: "u1", mode: "draft" })).toEqual({ ok: true, mode: "draft" });
    const throws = { ...fakeDb("off").db, rpc: () => { throw new Error("boom"); } };
    expect(await setAgentMode(throws as never, { organizationId: "o1", userId: "u1", mode: "draft" })).toEqual({ ok: true, mode: "draft" });
  });

  it("the owner channel's switch-on stamps too", () => {
    const src = readFileSync(new URL("./merchant-channel.server.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("async function switchAgentOn"), src.indexOf("function guardMessage"));
    expect(fn).toContain('stampAidenWorkspaceUnlock(supabase, organizationId, "replying")');
  });
});

describe("the choice is stored server-side and design.switched is recorded", () => {
  it("upserts the caller's own row and emits from / to / path", async () => {
    const writes: Array<{ table: string; row: unknown }> = [];
    const service = {
      from: (table: string) => ({
        upsert: async (row: unknown) => {
          writes.push({ table, row });
          return { error: null };
        },
        insert: async (row: unknown) => {
          writes.push({ table, row });
          return { error: null };
        },
      }),
    };
    const { saveDesignChoice } = await import("./aiden-workspace.server");
    const r = await saveDesignChoice(service as never, {
      organizationId: "org-1",
      userId: "user-1",
      design: "classic",
      from: "aiden_workspace",
      path: "/app/inbox",
    });
    expect(r).toEqual({ saved: true });
    expect(writes[0]).toMatchObject({ table: "user_design_preferences", row: { user_id: "user-1", design: "classic" } });
    expect(writes[1]).toMatchObject({
      table: "analytics_events",
      row: {
        organization_id: "org-1",
        event_type: DESIGN_SWITCHED_EVENT,
        actor_user_id: "user-1",
        properties: { from: "aiden_workspace", to: "classic", path: "/app/inbox" },
      },
    });
  });

  it("the API takes the user from the session, never the body", () => {
    const src = readFileSync(new URL("../routes/api/design.ts", import.meta.url), "utf8");
    expect(src).toContain("userId: auth.userId");
    expect(src).not.toMatch(/payload\["user_id"\]/);
  });
});

describe("the words", () => {
  it("say Aiden Workspace and Classic, never 'Aiden mode', and follow the Hallmark floor", () => {
    for (const file of ["../components/shell/design-switch.tsx", "./aiden-workspace.ts", "../components/admin/design-counts.tsx"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(src).not.toMatch(/Aiden mode/i);
      expect(src).not.toMatch(/transition-all|uppercase|tracking-wide|#[0-9a-fA-F]{6}\b| · /);
    }
    const sw = readFileSync(new URL("../components/shell/design-switch.tsx", import.meta.url), "utf8");
    expect(sw).toContain("motion-reduce:");
  });
});
