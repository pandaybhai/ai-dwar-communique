import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComponentType, ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CreditsExplained } from "@/components/marketing/pricing-copy";

/**
 * Batch 50 — Settings, Billing and wallet, the public site and sign-up in the
 * new design. No live database, Meta or Cashfree: these tests read the code,
 * call the pure helpers and render with fakes.
 */

const h = vi.hoisted(() => ({ newDesign: false, newSite: false, canEdit: true }));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/new-design", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/new-design")>()),
  useNewDesign: () => h.newDesign,
}));
vi.mock("@/lib/new-site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/new-site")>()),
  useNewSite: () => h.newSite,
}));
vi.mock("@/hooks/use-permissions", () => ({
  usePermissions: () => ({ can: () => h.canEdit, loading: false }),
}));
vi.mock("@/lib/whatsapp-client", () => ({
  callApi: async () => ({ data: null, error: "not in this test", raw: null }),
  uploadApi: async () => ({ data: null, error: "not in this test" }),
}));

const ROOT = join(__dirname, "..");
/** sha256 of the landing's and the pricing page's head on main (title, description, og, canonical, JSON-LD). */
const INDEX_HEAD = "5df4128ddbb6d581e6aa07833f7d73efd782d90e9c76d1639f901e3d11dc68a1";
const PRICING_HEAD = "5038479965261d278bdd615f54c6bd3a5dba7c953dc4e672f52c6d8ccf2484bb";
const src = (path: string) => readFileSync(join(ROOT, path), "utf8");
/** Code without its comments. */
const code = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/**
 * The additive changes to a classic file: `nd:` classes, `export` on a
 * function, and the a11y fixes axe asked for on these screens (a focusable,
 * named scroll region round the billing tables, a name for the download
 * column), which help both looks and change nothing else.
 */
const withoutNd = (text: string) =>
  text
    .replace(/ nd:[^\s"`]+/g, "")
    .replace(/^export function /gm, "function ")
    .replace(/ tabIndex=\{0\} role="region" aria-label="[^"]+"/g, "")
    .replace(
      /<th className="py-2">\n\s*<span className="sr-only">Download<\/span>\n\s*<\/th>/,
      '<th className="py-2" />',
    );

type LazyRoute = {
  options: {
    component: ComponentType & { preload?: () => Promise<void> };
    head?: (ctx: { match: { search: Record<string, unknown> } }) => {
      meta?: Array<Record<string, unknown>>;
      links?: Array<Record<string, unknown>>;
    };
  };
};

/** The route's own component function (the router plugin splits it into a lazy chunk). */
const APP_ROUTES = {
  "app/settings": () => import("../routes/app/settings"),
  "app/billing": () => import("../routes/app/billing"),
};
async function routeComponent(path: keyof typeof APP_ROUTES): Promise<() => ReactElement> {
  const { Route } = (await APP_ROUTES[path]()) as unknown as { Route: LazyRoute };
  const lazy = Route.options.component as unknown as {
    (props: object): { type: () => ReactElement };
    preload: () => Promise<void>;
  };
  await lazy.preload();
  return lazy({}).type;
}

describe("Settings: one page, a left sub-nav, the classic tabs' own cards", () => {
  it("shows each section under exactly the flags and permissions the classic tab used", async () => {
    const { visibleSections } = await import("@/components/settings-v2/settings-sections");
    const none = {
      shopify: false,
      connections: false,
      sending: false,
      api: false,
      compliance: false,
      notifications: false,
      owner: false,
    };
    expect(visibleSections(none).map((s) => s.key)).toEqual([
      "general",
      "team",
      "whatsapp",
      "sources",
    ]);
    const all = Object.fromEntries(Object.keys(none).map((k) => [k, true])) as typeof none;
    expect(visibleSections(all).map((s) => s.label)).toEqual([
      "Workspace",
      "Team and roles",
      "WhatsApp",
      "API and webhooks",
      "Notifications",
      "Opt-out keywords",
      "Integrations",
      "Flow connections",
      "Send settings",
      "Lead sources",
      "Danger zone",
    ]);
    // The danger zone is the owner's (the delete card shows only to them) and always last.
    expect(visibleSections({ ...none, owner: true }).at(-1)?.key).toBe("danger");
  });

  it("every old link still lands where it did (?tab= and Google's return)", async () => {
    const { sectionFor, visibleSections } =
      await import("@/components/settings-v2/settings-sections");
    const all = visibleSections({
      shopify: true,
      connections: true,
      sending: true,
      api: true,
      compliance: true,
      notifications: true,
      owner: true,
    });
    for (const tab of ["general", "team", "whatsapp", "integrations", "sending", "sources", "api"])
      expect(sectionFor(tab, false, all)).toBe(tab);
    expect(sectionFor("workspace", false, all)).toBe("general");
    expect(sectionFor(null, true, all)).toBe("connections");
    expect(sectionFor(null, false, all)).toBe("general");
    expect(sectionFor("nonsense", false, all)).toBe("general");
    // A hidden section never opens: API without the flag or permission falls back to Workspace.
    const noApi = all.filter((s) => s.key !== "api");
    expect(sectionFor("api", false, noApi)).toBe("general");
    // The classic Integrations tab held Shopify and Flow connections: without Shopify it opens connections.
    const noShopify = all.filter((s) => s.key !== "integrations");
    expect(sectionFor("integrations", false, noShopify)).toBe("connections");
  });

  it("writes nothing of its own: every card is a classic component, the one read is the numbers list", () => {
    const page = src("components/settings-v2/new-settings.tsx");
    expect(page).not.toMatch(/\.(insert|upsert|update|delete|rpc)\(/);
    expect(page).not.toContain("callApi");
    expect([...page.matchAll(/\.from\("([^"]+)"\)/g)].map((m) => m[1])).toEqual([
      "whatsapp_accounts",
    ]);
    const classic = src("routes/app/settings.tsx");
    for (const card of [
      "TeamSettings",
      "WhatsAppTab",
      "LeadSourcesTab",
      "OptOutKeywordsCard",
      "DeleteWorkspaceCard",
      "IntegrationsTab",
      "FlowConnections",
      "SendSettingsTab",
      "ApiSettingsTab",
      "ApiConsoleCard",
    ]) {
      expect(page).toContain(`<${card} `.trimEnd());
      expect(classic).toContain(`<${card}`);
    }
    // Notifications is the Aiden page's own hand-off alerts card, same component and permission.
    expect(page).toContain(
      '<HandoffAlertsCard organizationId={orgId} canConfigure={can("ai.configure")} />',
    );
    expect(src("routes/app/employee.tsx")).toContain("<HandoffAlertsCard");
    // The Workspace form is the classic GeneralTab itself, handed in by the route.
    expect(classic).toContain("<NewSettingsPage workspace={<GeneralTab />} />");
  });

  it("the WhatsApp profile is its own card on top, and steps aside inside each number", async () => {
    const { WhatsAppProfileCard, WhatsAppProfileHoisted } =
      await import("@/components/whatsapp-profile-card");
    const card = (placement: "number" | "top", hoisted: boolean) =>
      renderToStaticMarkup(
        <WhatsAppProfileHoisted.Provider value={hoisted}>
          <WhatsAppProfileCard orgId="o1" accountId="a1" placement={placement} />
        </WhatsAppProfileHoisted.Provider>,
      );
    // Classic (no provider): the per-number card exactly as before.
    const classic = renderToStaticMarkup(<WhatsAppProfileCard orgId="o1" accountId="a1" />);
    expect(classic).toContain("mt-6 rounded-xl border border-border/70 p-4");
    expect(classic).toContain('<p class="text-sm font-medium">WhatsApp profile</p>');
    // New Settings: the copy inside a number is gone, the top card has a heading.
    expect(card("number", true)).toBe("");
    expect(card("top", true)).toContain("<h3");
    expect(card("top", true)).toContain("WhatsApp profile");
    // Still only for people who may change it (settings.manage).
    h.canEdit = false;
    expect(card("top", true)).toBe("");
    h.canEdit = true;
  });
});

describe("⌘K jumps to profile, API and team", () => {
  it("offers WhatsApp profile and Team always, API only with the public_api flag and permission", async () => {
    const { settingsJumps } = await import("@/components/settings-v2/settings-jumps");
    const run = (flag: boolean, perm: boolean, visible = true) =>
      settingsJumps({
        settingsVisible: visible,
        isFeatureEnabled: (k) => k === "public_api" && flag,
        can: (p) => p === "public_api.manage" && perm,
      });
    expect(run(true, true).map((j) => [j.label, j.tab])).toEqual([
      ["WhatsApp profile", "whatsapp"],
      ["Team and roles", "team"],
      ["API and webhooks", "api"],
    ]);
    expect(run(true, false).map((j) => j.key)).toEqual(["profile", "team"]);
    expect(run(false, true).map((j) => j.key)).toEqual(["profile", "team"]);
    expect(run(true, true, false)).toEqual([]);
    // Typing the word matches: cmdk filters on the value.
    for (const [word, key] of [
      ["profile", "profile"],
      ["api", "api"],
      ["team", "team"],
    ] as const)
      expect(run(true, true).find((j) => j.key === key)!.value).toContain(word);
  });

  it("the entries are added to the new shell's palette only (the classic palette is unchanged)", () => {
    const palette = src("components/shell/command-palette.tsx");
    const at = palette.indexOf("settingsJumps({");
    expect(at).toBeGreaterThan(-1);
    expect(palette.slice(palette.lastIndexOf('design === "new"', at), at)).toContain(
      '<CommandPrimitive.Group heading="Settings"',
    );
    expect(palette).toContain("search: { tab: j.tab }");
  });
});

describe("Billing and wallet: same payments, same amounts", () => {
  it("explains trial, past due, paused, locked and cancelled with one next step", async () => {
    const { billingStateNote } = await import("@/components/billing-v2/billing-v2");
    const now = Date.parse("2026-10-29T10:00:00Z");
    const note = (planStatus: string, hasPlan = true, trialEndsAt: string | null = null) =>
      billingStateNote({ planStatus, hasPlan, trialEndsAt, now });
    expect(note("trial", false, "2026-11-07T10:00:00Z")).toMatchObject({
      title: "9 days left in your free trial.",
      action: "Choose a plan",
      target: "plans",
    });
    expect(note("trial", false, "2026-10-29T09:00:00Z")?.title).toBe("Your free trial ends today.");
    expect(note("trial", false, null)?.title).toBe("You're on a free trial.");
    expect(note("locked", false)).toMatchObject({
      action: "Reactivate",
      target: "plans",
      tone: "danger",
    });
    expect(note("paused")).toMatchObject({ action: "See open invoices", target: "invoices" });
    expect(note("past_due")).toMatchObject({ action: "See open invoices", tone: "gold" });
    expect(note("cancelled")?.href).toMatch(/^mailto:hello@aidwar\.in/);
    // Active, and a trial with a plan already bought, need no note.
    expect(note("active")).toBeNull();
    expect(note("trial", true)).toBeNull();
  });

  it("the usage chart shows only what was spent, largest first", async () => {
    const { usageBars } = await import("@/components/billing-v2/billing-v2");
    const bars = usageBars([
      { category: "inbox", label: "Inbox", amount: 50, count: 5 },
      { category: "ai", label: "AI", amount: 0, count: 0 },
      { category: "messaging", label: "Messages", amount: 200, count: 9 },
    ]);
    expect(bars.map((b) => [b.category, b.share])).toEqual([
      ["messaging", 100],
      ["inbox", 25],
    ]);
    expect(usageBars([])).toEqual([]);
  });

  it("pays and asks only through the classic pieces: no endpoint, write or amount of its own", () => {
    const page = code(src("components/billing-v2/new-billing.tsx"));
    // Plan purchase, credit purchase (Cashfree checkout), top-up request, invoices and history.
    for (const piece of [
      "<PlanChooser",
      "<BuyCreditsDialog",
      "<RequestTopupDialog",
      "<InvoicesPanel",
      "<HistoryTabs",
    ])
      expect(page).toContain(piece);
    expect(page).toMatch(/from "@\/components\/billing\/billing-view"/);
    // Its own calls are the two reads the classic page makes, and the gateway check on return.
    expect([...page.matchAll(/`(\/api\/[^`?]+)/g)].map((m) => m[1])).toEqual([
      "/api/billing/summary",
      "/api/billing/plan",
    ]);
    expect(page.match(/method: "GET"/g)).toHaveLength(2);
    expect(page).toContain("confirmCashfreeReturn(paymentId)");
    expect(page).not.toMatch(
      /openCashfreeCheckout|\/api\/billing\/purchase|\.(insert|update|upsert|delete|rpc)\(/,
    );
    // The same gate as the classic page decides who may top up.
    expect(page).toContain("creditPurchaseBlock(org?.plan_status)");
    expect(page).toContain('can("billing.pay")');
    // The classic dialogs still own the payment calls.
    const view = src("components/billing/billing-view.tsx");
    expect(view).toContain('"/api/billing/purchase"');
    expect(view).toContain("openCashfreeCheckout(data.checkout)");
    expect(view).toContain('"/api/billing/request-topup"');
  });

  it("an active workspace's plan cards are read only (it changes plan by writing to us, as before)", () => {
    const page = src("components/billing-v2/new-billing.tsx");
    const cards = page.slice(page.indexOf("function PlanCards("));
    expect(cards).not.toContain("<Button");
    expect(cards).not.toContain("body:");
    expect(cards).toContain("mailto:hello@aidwar.in?subject=Change%20plan");
    expect(cards).toContain('aria-current={current ? "true" : undefined}');
  });
});

describe("flag off: today's Settings, Billing and journey", () => {
  it("the routes draw the classic page with new_design off and the new one with it on", async () => {
    for (const [path, classic, fresh] of [
      ["app/settings", "SettingsPage", "NewSettingsPage"],
      ["app/billing", "BillingPage", "NewBillingPage"],
    ] as const) {
      const route = await routeComponent(path);
      h.newDesign = false;
      expect((route().type as { name: string }).name).toBe(classic);
      h.newDesign = true;
      expect((route().type as { name: string }).name).toBe(fresh);
    }
    h.newDesign = false;
  });

  it("the classic code is what main had (only `export` and `nd:` classes were added)", () => {
    const from = (text: string, marker: string) => text.slice(text.indexOf(marker));
    expect(sha(from(src("routes/app/settings.tsx"), "function SettingsPage()"))).toBe(
      "df2551925c43daf5c72cdd73e731e50a33c748fcc2074d775532539f5d76d57f",
    );
    expect(sha(from(src("routes/app/billing.tsx"), "function BillingPage()"))).toBe(
      "77898688546d747ed4244dafe45769bf4553bc6ccf0fdd6748ecfed9aa128609",
    );
    expect(sha(withoutNd(src("components/billing/billing-view.tsx")))).toBe(
      "4f984ef1ce359803c8fa4efd9825bc731caea8fa10ed9fc409a73347f5ab4ba3",
    );
    expect(sha(withoutNd(src("components/billing/invoices-panel.tsx")))).toBe(
      "dd584231aa2056ae5002f653405259318e98500d4bf99507bf49c154b6deebdf",
    );
    expect(sha(withoutNd(src("components/onboarding/journey-shell.tsx")))).toBe(
      "52d4f39fde47c7aae269757fcfeab40630d97dc81f95d595909079ee96aec933",
    );
    // PlanChooser: also its new-design-only cn() entries and their comment.
    const plan = withoutNd(src("components/billing/plan-chooser.tsx"))
      .split("\n")
      .filter(
        (l) => !/^\s*\/\/ (Batch 50, new design only|in emerald, the plan you had in ink)/.test(l),
      )
      .filter(
        (l) =>
          !/^\s*("nd:[^"]*"|suggested && "nd:[^"]*"|current && !suggested && "nd:[^"]*"),?$/.test(
            l,
          ),
      )
      .join("\n")
      .replace(
        /<h2 className="text-xl font-bold tracking-tight text-foreground">\n\s*\{heading\}\n\s*<\/h2>/,
        '<h2 className="text-xl font-bold tracking-tight text-foreground">{heading}</h2>',
      );
    expect(sha(plan)).toBe("dc4d782c5477dbdf671fa103a41d6ef65944160d54ba3c1c771c544493a35b4c");
  });

  it('nd: classes do nothing without the new design (the variant needs data-design="new")', () => {
    expect(src("styles.css")).toContain('@custom-variant nd (&:where([data-design="new"] *));');
  });
});

describe("the public site: new_site switch, default off", () => {
  it("is off unless the build turns it on or the address asks for the preview", async () => {
    const { newSiteOn, NEW_SITE_ENV } =
      await vi.importActual<typeof import("@/lib/new-site")>("@/lib/new-site");
    expect(NEW_SITE_ENV).toBe(false);
    expect(newSiteOn({}, false)).toBe(false);
    expect(newSiteOn(undefined, false)).toBe(false);
    expect(newSiteOn({ site: "old" }, false)).toBe(false);
    expect(newSiteOn({ site: "new" }, false)).toBe(true);
    expect(newSiteOn({}, true)).toBe(true);
  });

  it("landing and pricing draw today's page with the switch off and the new one with it on", async () => {
    for (const [path, classic, fresh] of [
      ["index", "Index", "NewLanding"],
      ["pricing", "PricingPage", "NewPricing"],
    ] as const) {
      const { Route } = (await import(`../routes/${path}.tsx`)) as {
        Route: LazyRoute & { useLoaderData: () => unknown };
      };
      const lazy = Route.options.component as unknown as {
        (props: object): { type: () => ReactElement };
        preload: () => Promise<void>;
      };
      await lazy.preload();
      const page = lazy({}).type;
      // The route's loader data, as the page reads it.
      (Route as unknown as { useLoaderData: () => unknown }).useLoaderData = () => ({
        plans: [],
        ok: true,
        rates: [],
      });
      h.newSite = false;
      expect((page().type as { name: string }).name).toBe(classic);
      h.newSite = true;
      expect((page().type as { name: string }).name).toBe(fresh);
    }
    h.newSite = false;
  });

  it("today's landing and pricing code is unchanged; their words only moved, word for word", () => {
    const from = (text: string, marker: string) => text.slice(text.indexOf(marker));
    expect(sha(from(src("routes/index.tsx"), "function scrollToId("))).toBe(
      "0989f3fa71fb50c09af04af293cca08918705578fcfd2ce1e9d6ad78895b22ec",
    );
    const copy = src("components/marketing/landing-copy.ts");
    expect(
      sha(
        copy
          .slice(copy.indexOf("export const CAPABILITIES = ["))
          .replace(/^export const /gm, "const ")
          .trim(),
      ),
    ).toBe("3fb26b2481c7961d760b6630666867270e8e7c02e0a06a3f3a3d822d510f991e");
    const pricing = src("components/marketing/pricing-copy.tsx");
    expect(
      sha(
        pricing
          .slice(
            pricing.indexOf("export type Plan = {"),
            pricing.indexOf('/** "How message credits work"'),
          )
          .replace(/^export (type|const|function) /gm, "$1 ")
          .trim(),
      ),
    ).toBe("5bfb51f5d45a3b1164299cce9ffcfc137d99c5a461c0938072224dee111f82a5");
    // The three "How message credits work" paragraphs, as main had them.
    const words = renderToStaticMarkup(<CreditsHost />).replace(/\s+/g, " ");
    for (const line of [
      "Meta charges per conversation, and the rate depends on what you're sending — promotions, order updates or one-time passcodes. We pass that through with a clear margin, show you the exact rate in your billing page before you send, and never bill you for replies inside the 24-hour service window.",
      "Credits are prepaid: top up whenever you like, and every campaign tells you what it will cost before it goes out. If a campaign would take you below zero, we stop it and ask you first.",
      "Every payment gets a GST tax invoice with your GSTIN on it, downloadable from your billing page. Turn on auto-pay and the plan fee takes care of itself.",
    ])
      expect(words.replace(/&#x27;/g, "'")).toContain(line);
  });

  it("legal, policy and Cashfree pages, the footer, sitemap and llms.txt are byte for byte main's", () => {
    const MAIN: Record<string, string> = {
      "routes/terms.tsx": "e660541f1acb896ece7951f466f05f5af9ce28ef0a8fd6f04246991cf0b298fb",
      "routes/privacy.tsx": "e1b42dae00e26213e2344d89ca36515e49dd018f5cd1da34ed3ba694cb423610",
      "routes/refunds.tsx": "5c607bfde33a444b086b4ac8a56548580307d33bf7c3eac5412a4108f0e385ab",
      "routes/refund-policy.tsx":
        "804c9591fb15bec80f1fd8aa537cac15cc4a111e387a3b86a49024d2369ee382",
      "routes/cancellation-policy.tsx":
        "e082813f3b4a4e7f6cffc77eec9f130ca99c0a2306adbd04e0b18d4dff5c6c46",
      "routes/shipping.tsx": "3e880f1944bfba67859e315180e7ec3fa5b5b8a2772011ecea672822af4bd565",
      "routes/data-deletion.tsx":
        "6f2f9ea19b612c58b8f55aebc032dde6e4d76fc1062bea826ccd6329345d403f",
      "routes/contact.tsx": "abbb9abb202f0859103d8fae3b8beeb62d3caf3d5bf477366766bcbaac410dd2",
      "routes/demo.tsx": "afe9afbb19d09234dfaedc8ad89d772a53945d8c4da4e2bf89f450a208bf33b4",
      // Batch 53: + /ai-assistants (sitemap) and its footer link; nothing else moved.
      "routes/sitemap[.]xml.ts": "db222f4e00056edf4feeb43e3aac46f5b9ae0061794e54fffe7454b3f0ebe85f",
      "routes/llms[.]txt.ts": "2d5a5402596064070a3ac3beaef4f5090fcc5f4b88f8a999287504a65f1a0ef3",
      "routes/llms-full[.]txt.ts":
        "b9df56c53b009a18831ea1b757718ba2721e4f6ab3345ca28fce6d6a5a6a96b7",
      "components/legal-page.tsx":
        "45bc8ac3f0f1dbd52fb0a422139db9873cdc7168ac451927b993dc5db0ad08c3",
      "components/site-footer.tsx":
        "d7226cdcefeb8ee8d67bd4a31c97eb3c13951acb82b6e3003ab4449663c8cd28",
      "lib/company.ts": "7b0ac09c4b2100a50dc4aa688d9c610184ebf227f8c6c8ba892491cdd6f79208",
      "components/marketing/message-rates.tsx":
        "bbf1e85fe19704c587108e63cc80f4330d7680e50c2c951699d1e395ffff85ba",
    };
    for (const [file, hash] of Object.entries(MAIN))
      expect([file, sha(src(file))]).toEqual([file, hash]);
  });

  it("keeps each page's SEO meta exactly; the new fonts load after the page is up, not in the head", async () => {
    const head = async (path: string) => {
      const { Route } = (await import(`../routes/${path}.tsx`)) as { Route: LazyRoute };
      return Route.options.head!({ match: { search: {} } });
    };
    const landing = await head("index");
    expect(landing.meta).toContainEqual({ title: "AiDwar — Your AI employee inside WhatsApp" });
    expect(landing.links).toEqual([{ rel: "canonical", href: "https://aidwar.in/" }]);
    const pricing = await head("pricing");
    expect(pricing.meta).toContainEqual({ title: "Pricing — AiDwar WhatsApp marketing plans" });
    expect(pricing.links).toBeUndefined();
    // The head definitions are main's, byte for byte.
    const headOf = (file: string) => {
      const text = src(file);
      return text.slice(text.indexOf("  head: () => ({"), text.indexOf("  component:"));
    };
    expect(sha(headOf("routes/index.tsx"))).toBe(INDEX_HEAD);
    expect(sha(headOf("routes/pricing.tsx"))).toBe(PRICING_HEAD);
    const site = src("lib/new-site.ts");
    expect(site).toContain("ensureSiteFonts();");
    expect(site).toContain("NEW_DESIGN_FONTS_HREF");
  });

  it("the new pages use the same plans, rates, sign-up links and demo form", () => {
    const landing = src("components/site-v2/new-landing.tsx");
    expect(landing).toContain("<DemoForm />");
    expect(landing).toContain("<ProductProof");
    expect(landing).toContain('from "@/components/marketing/landing-copy"');
    const pricing = src("components/site-v2/new-pricing.tsx");
    expect(pricing).toContain("<MessageRatesTable rates={rates} />");
    expect(pricing).toContain("<CreditsExplained />");
    expect(pricing).toContain('href="mailto:support@aidwar.in?subject=AiDwar%20Enterprise"');
    expect(pricing).toContain('to="/refunds"');
    const route = src("routes/pricing.tsx");
    expect(route).toContain("rates={loaded.rates}");
    // Every public page keeps the unchanged footer (policy links and the company line).
    expect(src("components/site-v2/site-shell.tsx")).toContain("<SiteFooter />");
    // Demo examples are labelled as examples.
    expect(landing).toContain("Examples with a sample shop.");
  });
});

describe("sign-up and log-in: restyled only", () => {
  it("the classic frame is main's; the new one only with the new_site switch", async () => {
    const auth = src("components/auth-shell.tsx");
    expect(sha(auth.slice(auth.lastIndexOf('  return (\n    <main className="ob-stage')))).toBe(
      "688c38c43688d009bd369ffdddffabecf47b5a4996eba5289b00ba8490afcf46",
    );
    const { AuthShell } = await import("@/components/auth-shell");
    const frame = (design?: "new") =>
      renderToStaticMarkup(
        <AuthShell
          title="Welcome back"
          subtitle="Log in."
          footer="x"
          {...(design ? { design } : {})}
        >
          <form />
        </AuthShell>,
      );
    expect(frame()).toContain('Ai<span class="text-primary">Dwar</span>');
    expect(frame("new")).toContain(">aidwar</a>");
    for (const page of ["routes/login.tsx", "routes/signup.tsx"]) {
      const body = src(page);
      expect(body).toContain("useDesignSurface(newSite)");
      expect(body).not.toMatch(/design="new"/);
    }
  });
});

/** Renders the moved paragraphs on their own. */
function CreditsHost(): ReactNode {
  return <div>{CreditsExplained()}</div>;
}
