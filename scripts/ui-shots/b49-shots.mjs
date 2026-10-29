/**
 * Batch 49: screenshots of Automate (Aiden, Flows, Automations) and Shop
 * (Catalogue, Collections) with fake data, flag on or off.
 *
 *   VITE_AIDWAR_SUPABASE_URL=http://fake-backend.test VITE_AIDWAR_SUPABASE_ANON_KEY=fake \
 *     npx vite dev --port 5199 --host 127.0.0.1
 *   node scripts/ui-shots/b49-shots.mjs --design new --out docs/screenshots/batch49/new [--only aiden,flows]
 *
 * Same mechanics as shoot.mjs (Chromium + Playwright on the machine; every
 * request answered by b49-backend.mjs over fake-backend.mjs; anything else
 * leaving the page is blocked). Prints console errors and a reduced-motion
 * check at the end.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKEND, STORAGE_KEY, session } from "./fake-backend.mjs";
import { createB49Backend } from "./b49-backend.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc),
      [],
    ),
);
const BASE = args.base ?? "http://127.0.0.1:5199";
const OUT = args.out ?? "docs/screenshots/batch49/new";
const ONLY = args.only ? args.only.split(",") : null;
const DESIGN = args.design ?? "new";
const MOTION = args.motion ?? "no-preference";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const WELCOME = "00000000-0000-4000-8000-000000008001";

const SCENARIOS = {
  aiden: { path: "/app/employee", wait: "text=Needs your answer", fullPage: true, settle: 1800 },
  "aiden-test": {
    path: "/app/employee",
    wait: "text=Test Aiden",
    settle: 1500,
    act: async (page) => {
      await page
        .getByLabel("A question a customer might ask")
        .fill("Is the Meenakari set available in red?");
      await page.getByRole("button", { name: "Ask", exact: true }).click();
      await page.waitForTimeout(1400);
      await page.locator("#test-aiden-heading").scrollIntoViewIfNeeded();
    },
  },
  "aiden-teach": {
    path: "/app/employee",
    wait: "text=Needs your answer",
    settle: 800,
    act: async (page) => {
      await page.getByRole("button", { name: "Teach Aiden" }).first().click();
      await page.waitForTimeout(400);
      await page.locator("#aiden-review-heading").scrollIntoViewIfNeeded();
    },
  },
  "aiden-draft": {
    path: "/app/employee",
    aidenMode: "draft",
    wait: "text=Needs your answer",
    settle: 1500,
  },
  "aiden-switched-off": {
    path: "/app/employee",
    aidenMode: "off",
    aiEnabled: false,
    wait: "text=Needs your answer",
    settle: 1500,
  },
  "aiden-empty": {
    path: "/app/employee",
    empty: true,
    wait: "text=Nothing waits on you",
    settle: 1500,
  },
  flows: { path: "/app/flows", wait: "text=Welcome menu", fullPage: true, settle: 1500 },
  "flows-deleted": {
    path: "/app/flows",
    wait: "text=Welcome menu",
    act: async (page) => {
      await page.getByRole("button", { name: /Deleted flows/ }).click();
      await page.waitForTimeout(500);
    },
  },
  "flows-empty": { path: "/app/flows", empty: true, wait: "text=No chat flows yet", settle: 1200 },
  "flow-builder": { path: `/app/flows/v2/${WELCOME}`, wait: ".react-flow__node", settle: 1800 },
  automations: { path: "/app/automations", wait: "text=Price list", fullPage: true, settle: 1200 },
  "automations-empty": { path: "/app/automations", empty: true, wait: "h1", settle: 1200 },
  catalogue: { path: "/app/catalog", wait: "text=Temple jhumkas", fullPage: true, settle: 1500 },
  "catalogue-empty": { path: "/app/catalog", empty: true, wait: "h1", settle: 1500 },
  collections: {
    path: "/app/catalog/collections",
    wait: "text=Bridal edit",
    fullPage: true,
    settle: 1200,
  },
};

const consoleErrors = [];

async function shoot(browser, name, scenario, viewportName) {
  const fake = createB49Backend({
    conversations: 40,
    newDesign: DESIGN === "new",
    aidenMode: scenario.aidenMode,
    aiEnabled: scenario.aiEnabled,
    empty: scenario.empty,
  });
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewportName],
    deviceScaleFactor: viewportName === "mobile" ? 2 : 1,
    colorScheme: "light",
    reducedMotion: MOTION,
  });
  await context.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
      localStorage.setItem("aidwar.active_org", "00000000-0000-4000-8000-0000000000a1");
      localStorage.setItem("aidwar.theme", "light");
      sessionStorage.setItem("aidwar.journey.exited.00000000-0000-4000-8000-0000000000a1", "1");
    },
    [STORAGE_KEY, JSON.stringify(session())],
  );
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BACKEND)) return fake.backend(route);
    if (url.startsWith(`${BASE}/api/`)) return fake.api(route);
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:"))
      return route.continue();
    if (
      url.startsWith("https://fonts.googleapis.com") ||
      url.startsWith("https://fonts.gstatic.com")
    )
      return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/fake-backend\.test/, (ws) => fake.realtime(ws));
  await context.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.connectToServer());

  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`${name}/${viewportName}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`${name}/${viewportName}: ${err.message}`));
  await page.goto(`${BASE}${scenario.path}`, { waitUntil: "networkidle" });
  if (scenario.wait) await page.waitForSelector(scenario.wait, { timeout: 15000 }).catch(() => {});
  if (scenario.act) await scenario.act(page);
  await page.waitForTimeout(scenario.settle ?? 800);
  // No horizontal page scroll at any width (the Hallmark floor's overflow-x rule).
  const overflow = await page.evaluate(() => {
    const main = document.querySelector("main");
    const doc = document.documentElement;
    return Math.max(
      doc.scrollWidth - doc.clientWidth,
      main ? main.scrollWidth - main.clientWidth : 0,
    );
  });
  if (overflow > 1)
    consoleErrors.push(`${name}/${viewportName}: page is ${overflow}px wider than the screen`);
  if (scenario.fullPage) {
    const extra = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? Math.max(0, main.scrollHeight - main.clientHeight) : 0;
    });
    if (extra > 0) {
      const vp = VIEWPORTS[viewportName];
      await page.setViewportSize({ width: vp.width, height: vp.height + extra });
      await page.waitForTimeout(500);
    }
  }
  const file = join(OUT, `${name}-${viewportName}.png`);
  await page.screenshot({ path: file, fullPage: Boolean(scenario.fullPage) });
  console.log("wrote", file);
  await context.close();
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (ONLY && !ONLY.includes(name)) continue;
  for (const vp of Object.keys(VIEWPORTS)) await shoot(browser, name, scenario, vp);
}
await browser.close();
if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} problem(s):`);
  for (const e of [...new Set(consoleErrors)]) console.log("  ", e);
} else console.log("\nNo console errors, no horizontal overflow.");
