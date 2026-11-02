import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_THEME_KEY, APP_THEME_SCRIPT } from "./theme";
import { undoBootDesignGuess } from "./new-design";

/**
 * Batch 58 item 6: the cold load of /app paints at once. The server sends
 * AppGate's own loading skeleton (route pendingComponent); a browser that
 * last saw Aiden Workspace gets its surface before paint (instead of a blank
 * Classic-dark page), undone if the settled answer is Classic; Classic is
 * otherwise exactly as before.
 */

vi.mock("@/integrations/aidwar/client", () => ({ aidwar: {} }));

function runScript(path: string, store: Record<string, string>, osDark = true) {
  const attrs = new Map<string, string>();
  const classes = new Set<string>();
  new Function("location", "document", "localStorage", "matchMedia", APP_THEME_SCRIPT)(
    { pathname: path },
    {
      documentElement: {
        setAttribute: (k: string, v: string) => attrs.set(k, v),
        classList: { add: (c: string) => classes.add(c) },
      },
    },
    { getItem: (k: string) => store[k] ?? null },
    () => ({ matches: osDark }),
  );
  return { attrs: Object.fromEntries(attrs), dark: classes.has("dark") };
}

describe("the pre-paint script", () => {
  it("a browser that last saw Aiden Workspace in its workspace: the new surface, no dark class, marked as a guess", () => {
    const store = { [APP_THEME_KEY]: "dark", "aidwar.active_org": "org-1", "aidwar.new_design.org-1": "1" };
    expect(runScript("/app", store)).toEqual({ attrs: { "data-app": "", "data-design": "new", "data-design-boot": "" }, dark: false });
  });

  it("Classic (no cache, another workspace's cache, or no workspace yet) is exactly as before", () => {
    for (const store of [
      { [APP_THEME_KEY]: "dark" },
      { [APP_THEME_KEY]: "dark", "aidwar.active_org": "org-2", "aidwar.new_design.org-1": "1" },
      { [APP_THEME_KEY]: "dark", "aidwar.new_design.org-1": "1" },
    ])
      expect(runScript("/app/inbox", store)).toEqual({ attrs: { "data-app": "" }, dark: true });
    expect(runScript("/app", { [APP_THEME_KEY]: "light" })).toEqual({ attrs: { "data-app": "" }, dark: false });
    // Never outside the app.
    expect(runScript("/", { "aidwar.active_org": "org-1", "aidwar.new_design.org-1": "1" })).toEqual({ attrs: {}, dark: false });
  });
});

describe("undoing the guess when the answer settles on Classic", () => {
  const root = (attrs: string[]) => {
    const set = new Set(attrs);
    const classes = new Set<string>();
    return {
      set,
      classes,
      hasAttribute: (n: string) => set.has(n),
      removeAttribute: (n: string) => void set.delete(n),
      classList: { toggle: (c: string, on?: boolean) => (on ? classes.add(c) : classes.delete(c)) },
    };
  };

  it("removes the new surface and puts the theme's dark class back", () => {
    const r = root(["data-app", "data-design", "data-design-boot"]);
    expect(undoBootDesignGuess(r, true)).toBe(true);
    expect([...r.set]).toEqual(["data-app"]);
    expect(r.classes.has("dark")).toBe(true);
  });

  it("leaves a surface the app itself set (no boot marker) alone", () => {
    const r = root(["data-app", "data-design"]);
    expect(undoBootDesignGuess(r, true)).toBe(false);
    expect([...r.set]).toEqual(["data-app", "data-design"]);
  });

  it("useDesignSurface only undoes it once the answer is settled", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/new-design.ts"), "utf8");
    expect(src).toContain("if (settled) undoBootDesignGuess(root, resolveTheme(readThemeChoice()) === \"dark\");");
    const route = readFileSync(join(process.cwd(), "src/routes/app/route.tsx"), "utf8");
    expect(route).toContain("useDesignSurface(newDesign, useDesignSettled());");
  });
});

describe("the /app route paints its loading skeleton from the server", () => {
  it("pendingComponent with no delay; AppGate's loading state is the same component", async () => {
    const { Route, AppPending } = await import("@/routes/app/route");
    expect(Route.options.pendingComponent).toBe(AppPending);
    expect(Route.options.pendingMs).toBe(0);
    expect(Route.options.pendingMinMs).toBe(0);
    expect(Route.options.ssr).toBe(false);
    const route = readFileSync(join(process.cwd(), "src/routes/app/route.tsx"), "utf8");
    expect(route).toContain("if (loading) return <AppPending />;");
  });

  it("for Classic it draws what AppGate drew before (the extra parts are nd:-only or hidden)", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { AppPending } = await import("@/routes/app/route");
    const { PageSkeleton } = await import("@/components/empty-state");
    const html = renderToStaticMarkup(createElement(AppPending));
    const before = renderToStaticMarkup(
      createElement(
        "div",
        { className: "min-h-screen bg-muted/30 px-5 py-12 sm:px-8" },
        createElement("div", { className: "mx-auto max-w-5xl" }, createElement(PageSkeleton)),
      ),
    );
    // The placeholder bar is the first child and is display:none (hidden)
    // unless the new surface is on; the nd: classes do nothing without it.
    const start = html.indexOf('<div aria-hidden="true" class="hidden ');
    const end = html.indexOf('<div class="mx-auto');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const classic = (html.slice(0, start) + html.slice(end)).replace(/ nd:[^\s"]+/g, "");
    expect(classic).toBe(before);
  });
});

describe("feature flags are read at the same time", () => {
  it("defaults and the workspace's overrides in one Promise.all, applied in the same order", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/org-context.tsx"), "utf8");
    const block = src.slice(src.indexOf("setFlagsLoading(true);"), src.indexOf("setFlagDefaults(defaults);"));
    expect(block).toContain("await Promise.all([");
    expect(block.indexOf('from("feature_flags")')).toBeLessThan(block.indexOf('from("organization_feature_overrides")'));
    expect(block.indexOf("resolved[f.key] = f.default_enabled")).toBeLessThan(block.indexOf("resolved[o.flag_key] = o.enabled"));
  });
});
