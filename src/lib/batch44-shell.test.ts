import { describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { FEATURES, roleDefaults, type OrgRole } from "./feature-registry";

/**
 * Batch 44 (new design, behind the new_design flag): nothing that works today
 * may break. These lock (1) every page the classic sidebar shows, for every
 * role, flag mix and plan state, is reachable in the new shell — a section,
 * a sub-tab, the avatar menu or the More sheet; (2) the new shell shows
 * nothing the sidebar wouldn't; (3) the flag is off unless its row says on,
 * so the app is the classic look before 20261180 is applied.
 */

const orgState: { value: Record<string, unknown> } = { value: {} };
vi.mock("@/lib/org-context", () => ({ useOrg: () => orgState.value }));
vi.mock("@/hooks/use-automations-count", () => ({ useAutomationsCount: () => null }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: () => true, loading: false }),
}));

const ROLES: OrgRole[] = ["owner", "admin", "marketer", "agent"];
const FLAG_KEYS = Array.from(new Set(FEATURES.map((f) => f.flag_key)));

/** All on, all off, each flag alone off, each flag alone on. */
function flagMixes(): Array<Record<string, boolean>> {
  const all = (on: boolean) => Object.fromEntries(FLAG_KEYS.map((k) => [k, on]));
  const mixes = [all(true), all(false)];
  for (const k of FLAG_KEYS) {
    mixes.push({ ...all(true), [k]: false });
    mixes.push({ ...all(false), [k]: true });
  }
  return mixes;
}

describe("route safety: the new shell reaches every page the sidebar shows", () => {
  it("for every role, flag mix, plan state and automations count", async () => {
    const { filterNavItems, groupNav, isActivePath } = await import("@/components/shell/use-nav");
    const { buildShellModel, reachablePaths } = await import("@/components/shell/sections");
    let cases = 0;
    for (const role of ROLES) {
      const perms = new Set(roleDefaults(role));
      for (const flags of flagMixes()) {
        for (const planStatus of ["active", "trial", "locked", "paused"]) {
          for (const automationsCount of [null, 0, 3]) {
            const { items, restricted } = filterNavItems({
              isFeatureEnabled: (k) => flags[k] === true,
              flagsLoading: false,
              can: (p) => perms.has(p),
              permsLoading: false,
              planStatus,
              automationsCount,
            });
            const sidebar = groupNav(items, restricted).flatMap((g) => g.items.map((i) => i.to));
            for (const shopify of [false, true]) {
              const model = buildShellModel(items, restricted, { shopify });
              const reachable = reachablePaths(model);
              const missing = sidebar.filter((to) => !reachable.has(to));
              expect(missing, `${role} ${planStatus} ${JSON.stringify(flags)}`).toEqual([]);
              // And never more than the sidebar offers: Home aside, every link
              // is a sidebar page or a page under one (Catalogue → Collections).
              const extra = [...reachable].filter(
                (to) => to !== "/app" && !sidebar.some((p) => p !== "/app" && isActivePath(to, p)),
              );
              expect(extra, `${role} ${planStatus}`).toEqual([]);
              cases++;
            }
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(1000);
  });

  it("a registry page the map doesn't know yet still shows up (avatar menu and More sheet)", async () => {
    const { HOME_ITEM } = await import("@/components/shell/use-nav");
    const { buildShellModel, reachablePaths } = await import("@/components/shell/sections");
    const items = [
      { to: "/app/inbox", label: "Shared Inbox", icon: HOME_ITEM.icon, flag: null, perm: null },
      {
        to: "/app/something-new",
        label: "New thing",
        icon: HOME_ITEM.icon,
        flag: null,
        perm: null,
      },
    ];
    const model = buildShellModel(items, false);
    expect(model.overflow.map((o) => o.to)).toEqual(["/app/something-new"]);
    expect(reachablePaths(model).has("/app/something-new")).toBe(true);
  });

  it("every registry nav page has a home in the map (no page only in overflow today)", async () => {
    const { navFeatures } = await import("./feature-registry");
    const { HOME_ITEM } = await import("@/components/shell/use-nav");
    const { buildShellModel } = await import("@/components/shell/sections");
    const items = navFeatures().map((f) => ({
      to: f.nav_path!,
      label: f.name,
      icon: HOME_ITEM.icon,
      flag: f.flag_key,
      perm: null,
    }));
    const model = buildShellModel(items, false, { shopify: true });
    expect(model.overflow).toEqual([]);
    expect(model.sections.map((s) => s.label)).toEqual([
      "Home",
      "Inbox",
      "Campaigns",
      "Customers",
      "Automate",
      "Shop",
    ]);
    const tabs = Object.fromEntries(model.sections.map((s) => [s.key, s.tabs.map((t) => t.label)]));
    expect(tabs).toEqual({
      home: [],
      inbox: ["Inbox"],
      campaigns: ["Campaigns", "Templates", "Cards"],
      customers: ["Contacts", "Segments", "Sales from chats"],
      automate: ["Aiden", "Flows", "Automations", "AI assistants"],
      shop: ["Catalogue", "Collections", "Shopify"],
    });
    expect(model.account.map((a) => a.label)).toEqual(["Settings", "Billing and wallet", "Team"]);
    expect(model.analytics?.to).toBe("/app/analytics");
  });

  it("a locked workspace: Inbox and Billing only, no Home", async () => {
    const { filterNavItems } = await import("@/components/shell/use-nav");
    const { buildShellModel, reachablePaths } = await import("@/components/shell/sections");
    const { items, restricted } = filterNavItems({
      isFeatureEnabled: () => true,
      flagsLoading: false,
      can: () => true,
      permsLoading: false,
      planStatus: "locked",
      automationsCount: 3,
    });
    const model = buildShellModel(items, restricted, { shopify: true });
    expect([...reachablePaths(model)].sort()).toEqual(["/app/billing", "/app/inbox"]);
  });
});

describe("active section and sub-tab", () => {
  it("follows the address, search params and the longest path", async () => {
    const { navFeatures } = await import("./feature-registry");
    const { HOME_ITEM } = await import("@/components/shell/use-nav");
    const { activeSection, activeTab, buildShellModel } =
      await import("@/components/shell/sections");
    const items = navFeatures().map((f) => ({
      to: f.nav_path!,
      label: f.name,
      icon: HOME_ITEM.icon,
      flag: f.flag_key,
      perm: null,
    }));
    const model = buildShellModel(items, false, { shopify: true });
    const at = (path: string, search: Record<string, unknown> = {}) => {
      const s = activeSection(model, path, search);
      return [s?.key ?? null, s ? (activeTab(s, path, search)?.label ?? null) : null];
    };
    expect(at("/app")).toEqual(["home", null]);
    expect(at("/app/analytics")).toEqual(["home", null]);
    expect(at("/app/inbox")).toEqual(["inbox", "Inbox"]);
    expect(at("/app/campaigns/123")).toEqual(["campaigns", "Campaigns"]);
    expect(at("/app/templates")).toEqual(["campaigns", "Templates"]);
    expect(at("/app/contacts")).toEqual(["customers", "Contacts"]);
    expect(at("/app/contacts", { tab: "segments" })).toEqual(["customers", "Segments"]);
    expect(at("/app/receipts")).toEqual(["customers", "Sales from chats"]);
    expect(at("/app/flows/v2/abc")).toEqual(["automate", "Flows"]);
    expect(at("/app/catalog")).toEqual(["shop", "Catalogue"]);
    expect(at("/app/catalog/collections")).toEqual(["shop", "Collections"]);
    // Settings and Billing belong to the avatar menu, not to a section — even
    // when Shop → Shopify opened Settings → Integrations.
    expect(at("/app/settings", { tab: "integrations" })).toEqual([null, null]);
    expect(at("/app/billing")).toEqual([null, null]);
  });
});

describe("the new_design flag", () => {
  it("is off by default and declared like every other flag", () => {
    const f = FEATURES.find((x) => x.key === "new_design");
    expect(f?.flag_key).toBe("new_design");
    expect(f?.flag_default_enabled).toBe(false);
    expect(f && "nav_path" in f).toBe(false);
  });

  it("the migration only inserts the flag rows, off, idempotently, and is the only SQL", () => {
    const dir = new URL("../../supabase/aidwar-migrations/", import.meta.url);
    const file = readdirSync(dir).find((n) => n.startsWith("20261180_"));
    expect(file).toBe("20261180_batch44_new_design_flag.sql");
    const sql = readFileSync(new URL(file!, dir), "utf8");
    const code = sql.replace(/--.*$/gm, "");
    expect(code).toMatch(/INSERT INTO public\.feature_flags[\s\S]*'new_design'[\s\S]*false\s*\)/);
    expect(code).toMatch(
      /ON CONFLICT \(key\) DO UPDATE SET name = excluded\.name, description = excluded\.description;/,
    );
    // Never switches it on, never touches an override or a workspace.
    expect(code).not.toMatch(
      /organization_feature_overrides|default_enabled\s*=\s*true|UPDATE public\.organizations/i,
    );
    expect(code).not.toMatch(/\bDROP TABLE|\bDELETE FROM|\bTRUNCATE/i);
  });

  it("useNewDesign: off while the row is missing, off while loading with nothing cached, on only when the flag says so", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    // The real switch, also in the flag-ON run (which forces useNewDesign on).
    const { useNewDesign } = await vi.importActual<typeof import("./new-design")>("./new-design");
    let seen: boolean | null = null;
    const Probe = () => {
      seen = useNewDesign();
      return null;
    };
    const org = (flags: Record<string, boolean>, flagsLoading = false) => ({
      active: { organization: { id: "org-1" } },
      flagsLoading,
      isFeatureEnabled: (k: string) => flags[k] ?? false,
    });

    orgState.value = org({}); // 20261180 not applied: no row at all
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe(false);

    orgState.value = org({ new_design: false });
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe(false);

    orgState.value = org({ new_design: true }, true); // still loading
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe(false);

    orgState.value = org({ new_design: true });
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe(true);

    orgState.value = {}; // a test or a page with no org at all
    renderToStaticMarkup(createElement(Probe));
    expect(seen).toBe(false);
  });

  it("the classic shell is kept, and the gate picks it whenever the flag is off", () => {
    const route = readFileSync(new URL("../routes/app/route.tsx", import.meta.url), "utf8");
    expect(route).toContain("const newDesign = useNewDesign() && Boolean(active);");
    expect(route).toMatch(
      /if \(newDesign\) \{[\s\S]*<NewAppShell>[\s\S]*\}\s*return \(\s*<AppShell>/,
    );
    const classic = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
    expect(classic).toContain("export function AppShell(");
    expect(classic).toContain('aria-label="Sidebar"');
  });

  it("the new look's CSS only applies under data-design=new", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    expect(css).toContain('@custom-variant nd (&:where([data-design="new"] *));');
    expect(css).toContain('html[data-app][data-design="new"] {');
    // The classic app block still sets the Batch 39 primary.
    expect(css).toMatch(
      /html\[data-app\] \{\s*--background: var\(--gray-25\);[\s\S]*?--primary: var\(--brand-700\);/,
    );
    // Classic buttons are the primary colour, as before.
    expect(css).toMatch(/--btn-primary: var\(--primary\);/);
  });
});
