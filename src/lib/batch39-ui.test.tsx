import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { navFeatures } from "./feature-registry";
import { APP_THEME_KEY, APP_THEME_SCRIPT } from "./theme";
import { isTypingTarget } from "./keyboard";

/**
 * Batch 39 (design system, shell, Inbox): visual only — these lock the few
 * places where the redesign could have changed what someone sees or can do.
 */

vi.mock("@/lib/org-context", () => ({ useOrg: () => ({}) }));
vi.mock("@/hooks/use-automations-count", () => ({ useAutomationsCount: () => null }));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: () => true, loading: false }),
}));

describe("sidebar groups", () => {
  it("every registry nav item lands in exactly one group, Home first; a new path lands in More", async () => {
    const { groupNav, HOME_ITEM } = await import("@/components/shell/use-nav");
    const items = navFeatures().map((f) => ({
      to: f.nav_path!,
      label: f.name,
      icon: HOME_ITEM.icon,
      flag: f.flag_key,
      perm: null,
    }));
    const extra = {
      to: "/app/something-new",
      label: "New thing",
      icon: HOME_ITEM.icon,
      flag: null,
      perm: null,
    };
    const groups = groupNav([...items, extra], false);
    const placed = groups.flatMap((g) => g.items.map((i) => i.to));
    expect(placed[0]).toBe("/app");
    expect(placed.slice(1).sort()).toEqual([...items, extra].map((i) => i.to).sort());
    expect(groups.at(-1)).toMatchObject({ label: "More", items: [extra] });
  });

  it("a locked workspace gets no Home (the gate sends it to Billing) and nothing it didn't have", async () => {
    const { groupNav, HOME_ITEM } = await import("@/components/shell/use-nav");
    const locked = [
      { to: "/app/inbox", label: "Shared Inbox", icon: HOME_ITEM.icon, flag: null, perm: null },
      { to: "/app/billing", label: "Billing", icon: HOME_ITEM.icon, flag: null, perm: null },
    ];
    expect(groupNav(locked, true).flatMap((g) => g.items.map((i) => i.to))).toEqual([
      "/app/inbox",
      "/app/billing",
    ]);
  });

  it("active path: Home only on /app itself; a page and its children", async () => {
    const { isActivePath } = await import("@/components/shell/use-nav");
    expect(isActivePath("/app", "/app")).toBe(true);
    expect(isActivePath("/app/inbox", "/app")).toBe(false);
    expect(isActivePath("/app/campaigns/123", "/app/campaigns")).toBe(true);
    expect(isActivePath("/app/catalogue", "/app/catalog")).toBe(false);
  });
});

describe("theme", () => {
  it("the head script only touches /app pages (the marketing site and the portal keep their look)", () => {
    const run = (path: string, stored: string | null) => {
      const attrs = new Map<string, string>();
      const classes = new Set<string>();
      const fn = new Function(
        "location",
        "document",
        "localStorage",
        "matchMedia",
        APP_THEME_SCRIPT,
      );
      fn(
        { pathname: path },
        {
          documentElement: {
            setAttribute: (k: string, v: string) => attrs.set(k, v),
            classList: { add: (c: string) => classes.add(c) },
          },
        },
        { getItem: (k: string) => (k === APP_THEME_KEY ? stored : null) },
        () => ({ matches: true }),
      );
      return { app: attrs.has("data-app"), dark: classes.has("dark") };
    };
    expect(run("/", "dark")).toEqual({ app: false, dark: false });
    expect(run("/developers", "dark")).toEqual({ app: false, dark: false });
    expect(run("/application", "dark")).toEqual({ app: false, dark: false });
    expect(run("/app", null)).toEqual({ app: true, dark: false });
    expect(run("/app/inbox", "dark")).toEqual({ app: true, dark: true });
    expect(run("/app/inbox", "system")).toEqual({ app: true, dark: true });
    expect(run("/app/inbox", "light")).toEqual({ app: true, dark: false });
  });
});

describe("keyboard shortcuts never fire while typing", () => {
  const el = (tag: string, extra: Record<string, unknown> = {}) =>
    ({
      tagName: tag,
      isContentEditable: false,
      closest: () => null,
      ...extra,
    }) as unknown as EventTarget;
  it("inputs, text areas, selects, editable text and open menus/dialogs are typing targets", () => {
    expect(isTypingTarget(el("INPUT"))).toBe(true);
    expect(isTypingTarget(el("TEXTAREA"))).toBe(true);
    expect(isTypingTarget(el("SELECT"))).toBe(true);
    expect(isTypingTarget(el("DIV", { isContentEditable: true }))).toBe(true);
    expect(isTypingTarget(el("BUTTON", { closest: () => ({}) }))).toBe(true);
    expect(isTypingTarget(el("BUTTON"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe("the Inbox keeps its words", () => {
  it("contact panel says opt-in with the Contacts page's own labels", async () => {
    const { OPT_IN_LABELS } = await import("./contacts");
    const src = (await import("node:fs")).readFileSync(
      new URL("../components/inbox/contact-panel.tsx", import.meta.url),
      "utf8",
    );
    expect(src).toContain("OPT_IN_LABELS[optIn]");
    expect(Object.values(OPT_IN_LABELS)).toEqual(["Opted in", "Opted out", "Unknown"]);
  });

  it("a failed bubble, an AI bubble and a test send still say so", async () => {
    const { Bubble } = await import("@/components/inbox/chat-thread");
    const row = (over: Record<string, unknown>) =>
      ({
        id: "m",
        conversation_id: "c",
        direction: "outbound",
        type: "text",
        body: "Hello",
        media_url: null,
        media_mime: null,
        template_name: null,
        status: "sent",
        error_detail: null,
        created_at: "2026-10-28T10:00:00Z",
        metadata: null,
        ...over,
      }) as never;
    const ai = renderToStaticMarkup(
      <Bubble
        message={row({})}
        organizationId="o"
        agentName="Aiden"
        aiRun={{ question: "q", reply: "Hello", taughtOn: null }}
      />,
    );
    expect(ai).toContain("Written by Aiden");
    const failed = renderToStaticMarkup(
      <Bubble message={row({ status: "failed" })} organizationId="o" agentName="Aiden" />,
    );
    expect(failed).toContain('aria-label="Failed to send"');
    const test = renderToStaticMarkup(
      <Bubble message={row({ metadata: { test: true } })} organizationId="o" agentName="Aiden" />,
    );
    expect(test).toContain(">Test<");
  });
});
