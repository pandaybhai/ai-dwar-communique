/**
 * Screenshots of the app with fake data (Batch 39).
 *
 *   VITE_AIDWAR_SUPABASE_URL=http://fake-backend.test VITE_AIDWAR_SUPABASE_ANON_KEY=fake \
 *     npx vite dev --port 5199 --host 127.0.0.1
 *   node scripts/ui-shots/shoot.mjs --out docs/screenshots/batch39/before [--themes light,dark] [--only inbox-chat] [--set b39|b41]
 *
 * Uses the Chromium + Playwright installed on the machine (not a project
 * dependency). The dev server must point the app at the fake backend host:
 * every request to it, and to the app's own /api/*, is answered by
 * fake-backend.mjs; any other request leaving the page is blocked.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKEND, STORAGE_KEY, createBackend, session } from "./fake-backend.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://127.0.0.1:5199";
const OUT = args.out ?? "docs/screenshots/batch39/after";
const THEMES = (args.themes ?? "light").split(",");
const ONLY = args.only ? args.only.split(",") : null;

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const firstId = createBackend({ conversations: 1 }).conversations[0].id;

/** name → { path, conversations, prepare(page) } */
const SCENARIOS = {
  shell: { path: "/app", conversations: 40, wait: "h1" },
  "inbox-list": { path: "/app/inbox", conversations: 40 },
  "inbox-chat": { path: `/app/inbox?c=${firstId}`, conversations: 40, wait: "text=Meenakari" },
  "inbox-empty": { path: "/app/inbox", conversations: 0 },
  "inbox-needs-human": { path: `/app/inbox?c=${firstId}`, conversations: 40, wait: "text=Waiting for you.", crop: "[data-shot=needs-human], div.bg-amber-50" },
  design: { path: "/app/design", conversations: 40, fullPage: true },
  palette: {
    path: "/app",
    conversations: 40,
    wait: "h1",
    act: async (page) => {
      await page.keyboard.press("Control+k");
      await page.keyboard.type("as", { delay: 40 });
      await page.waitForTimeout(700);
    },
  },
  shortcuts: { path: "/app", conversations: 40, wait: "h1", act: async (page) => page.keyboard.press("Shift+?") },
};

const firstCampaign = "00000000-0000-4000-8000-000000007000";

/** The campaign wizard, walked to a step (Batch 41: audience → … → review). */
function wizardTo(target) {
  return {
    path: "/app/campaigns",
    conversations: 40,
    wait: "text=Diwali preview",
    act: async (page) => {
      await page.getByRole("button", { name: /create campaign/i }).first().click();
      await page.waitForTimeout(700);
      await page.getByLabel("Campaign name").fill("Diwali preview — VIP list");
      await page.waitForTimeout(900);
      if (target < 1) return;
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(500);
      await page.getByRole("dialog").getByText("order_shipped", { exact: true }).click();
      await page.waitForTimeout(500);
      if (target < 2) return;
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(500);
      for (const n of [1, 2]) {
        await page.getByRole("combobox", { name: `Source for {{${n}}}` }).click();
        await page.getByRole("option").first().click();
        await page.waitForTimeout(200);
      }
      if (target < 3) return;
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(600);
    },
  };
}

/** Batch 41: Home, Campaigns, Templates. */
const SCENARIOS_B41 = {
  home: { path: "/app", conversations: 40, wait: "text=Waiting on you", fullPage: true },
  "home-journey": { path: "/app", conversations: 40, journey: true, wait: "text=Continue setup" },
  "home-low-credits": { path: "/app", conversations: 40, lowCredits: true, wait: "text=Waiting on you", fullPage: true },
  campaigns: { path: "/app/campaigns", conversations: 40, wait: "text=Diwali preview" },
  "campaigns-empty": { path: "/app/campaigns", conversations: 40, campaigns: 0, wait: "h1" },
  "campaign-detail": { path: `/app/campaigns/${firstCampaign}`, conversations: 40, wait: "text=Offer performance", fullPage: true },
  "campaign-wizard": { ...wizardTo(0) },
  "campaign-wizard-message": { ...wizardTo(1) },
  "campaign-wizard-personalise": { ...wizardTo(2) },
  "campaign-wizard-review": { ...wizardTo(4) },
  templates: { path: "/app/templates", conversations: 40, wait: "text=order_shipped" },
  "templates-empty": { path: "/app/templates", conversations: 40, templates: 0, wait: "h1" },
  "template-create": {
    fullPage: false,
    path: "/app/templates",
    conversations: 40,
    wait: "text=order_shipped",
    act: async (page) => {
      await page.getByRole("button", { name: /create template/i }).first().click();
      await page.waitForTimeout(900);
    },
  },
};

/** Batch 43: Settings, Billing and the public website. */
const settingsAt = (tab, wait, extra = {}) => ({ path: `/app/settings?tab=${tab}`, conversations: 40, wait, fullPage: true, ...extra });
const SCENARIOS_B43 = {
  "settings-workspace": settingsAt("general", "text=Organization name"),
  "settings-team": settingsAt("team", "text=Neha Joshi"),
  "settings-whatsapp": settingsAt("whatsapp", "text=+91 98200 00000"),
  "settings-api": settingsAt("api", "text=Shopify order updates"),
  "settings-sending": settingsAt("sending", "text=Quiet hours"),
  "settings-notifications": settingsAt("notifications", "text=+91 98111 22334"),
  "settings-danger": settingsAt("danger", "text=Delete workspace"),
  billing: { path: "/app/billing", conversations: 40, wait: "text=AD/26-27/0142", fullPage: true },
  "billing-low": { path: "/app/billing", conversations: 40, lowCredits: true, wait: "text=AD/26-27/0142", fullPage: true },
  "billing-trial": { path: "/app/billing", conversations: 40, planStatus: "trial", wait: "text=Growth", fullPage: true },
  "billing-past-due": { path: "/app/billing", conversations: 40, planStatus: "past_due", wait: "text=AD/26-27/0142", fullPage: true },
  "billing-locked": { path: "/app/billing", conversations: 40, planStatus: "locked", wait: "text=Growth", fullPage: true },
  "billing-buy": {
    path: "/app/billing",
    conversations: 40,
    wait: "text=AD/26-27/0142",
    act: async (page) => {
      await page.getByRole("button", { name: /buy credits/i }).first().click();
      await page.waitForTimeout(400);
      await page.getByRole("dialog").getByText("Growth pack").click();
      await page.waitForTimeout(500);
    },
  },
  // The Batch 39 shell's light-mode contrast fixes: sidebar foot, account chip, primary hover.
  "shell-a11y": {
    path: "/app/campaigns",
    conversations: 40,
    wait: "text=Diwali preview",
    desktopOnly: true,
    act: async (page) => {
      await page.getByRole("button", { name: /create campaign/i }).first().hover();
      await page.waitForTimeout(300);
    },
    clips: { top: { x: 240, y: 0, width: 1200, height: 260 }, foot: { x: 0, y: 820, width: 240, height: 80 } },
  },
  landing: { path: "/", anon: true, wait: "h1", fullPage: true },
  "landing-fold": { path: "/", anon: true, wait: "h1" },
  pricing: { path: "/pricing", anon: true, wait: "text=Message credit rates (India)", fullPage: true },
  contact: { path: "/contact", anon: true, wait: "h1", fullPage: true },
  refunds: { path: "/refunds", anon: true, wait: "h1", fullPage: true },
  terms: { path: "/terms", anon: true, wait: "h1" },
  demo: { path: "/demo", anon: true, wait: "h1", fullPage: true },
};

const SETS = { b39: SCENARIOS, b41: SCENARIOS_B41, b43: SCENARIOS_B43 };

const consoleErrors = [];

async function shoot(browser, name, scenario, viewportName, theme) {
  const fake = createBackend({
    conversations: scenario.conversations,
    campaigns: scenario.campaigns,
    templates: scenario.templates,
    lowCredits: scenario.lowCredits,
    journey: scenario.journey,
    planStatus: scenario.planStatus,
  });
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewportName],
    deviceScaleFactor: viewportName === "mobile" ? 2 : 1,
    colorScheme: theme,
  });
  await context.addInitScript(
    ([key, value, theme]) => {
      if (value) localStorage.setItem(key, value);
      localStorage.setItem("aidwar.active_org", "00000000-0000-4000-8000-0000000000a1");
      localStorage.setItem("aidwar.theme", theme);
      // Batch 40's "Save & exit": Home shows the Continue setup card instead of redirecting.
      sessionStorage.setItem("aidwar.journey.exited.00000000-0000-4000-8000-0000000000a1", "1");
    },
    [STORAGE_KEY, scenario.anon ? null : JSON.stringify(session()), theme],
  );
  // Only the dev server and the fake backend; nothing else leaves the page.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BACKEND)) return fake.backend(route);
    if (url.startsWith(`${BASE}/api/`)) return fake.api(route);
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    if (url.startsWith("https://fonts.googleapis.com") || url.startsWith("https://fonts.gstatic.com")) return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/fake-backend\.test/, (ws) => fake.realtime(ws));
  await context.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.connectToServer());

  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`${name}/${viewportName}/${theme}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`${name}/${viewportName}/${theme}: ${err.message}`));
  await page.goto(`${BASE}${scenario.path}`, { waitUntil: "networkidle" });
  if (scenario.wait) await page.waitForSelector(scenario.wait, { timeout: 15000 }).catch(() => {});
  if (scenario.act) await scenario.act(page);
  await page.waitForTimeout(800);
  if (scenario.fullPage) {
    // The app's work area scrolls, not the window: grow the window to fit it.
    const extra = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? Math.max(0, main.scrollHeight - main.clientHeight) : 0;
    });
    if (extra > 0) {
      const vp = VIEWPORTS[viewportName];
      await page.setViewportSize({ width: vp.width, height: vp.height + extra });
      await page.waitForTimeout(400);
    }
  }
  const file = join(OUT, `${name}-${viewportName}${theme === "dark" ? "-dark" : ""}.png`);
  if (scenario.clips) {
    for (const [part, clip] of Object.entries(scenario.clips)) {
      const f = join(OUT, `${name}-${part}${theme === "dark" ? "-dark" : ""}.png`);
      await page.screenshot({ path: f, clip });
      console.log("wrote", f);
    }
    await context.close();
    return;
  }
  if (scenario.crop) {
    const el = await page.$(scenario.crop);
    if (el) await el.screenshot({ path: file });
    else await page.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: Boolean(scenario.fullPage) });
  }
  console.log("wrote", file);
  await context.close();
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [name, scenario] of Object.entries(SETS[args.set ?? "b39"])) {
  if (ONLY && !ONLY.includes(name)) continue;
  for (const vp of Object.keys(VIEWPORTS)) {
    if (scenario.desktopOnly && vp !== "desktop") continue;
    for (const theme of THEMES) await shoot(browser, name, scenario, vp, theme);
  }
}
await browser.close();
if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s):`);
  for (const e of [...new Set(consoleErrors)]) console.log("  ", e);
}
