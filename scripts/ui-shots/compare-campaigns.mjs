/**
 * Batch 47: the new Campaigns next to the approved preview
 * (docs/design/preview.html #campaigns) at 1440 and 390, and the screens the
 * preview doesn't draw (wizard, Templates gallery and editor, Cards) next to
 * their Batch 41 look. The app runs against the fake backend (fake-backend.mjs);
 * reduced motion on both sides, so tickers and bars show their end state.
 * Needs the dev server from shoot.mjs's header running.
 *
 *   node scripts/ui-shots/compare-campaigns.mjs [--base http://127.0.0.1:5199] [--out docs/screenshots/batch47/compare]
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKEND, STORAGE_KEY, createBackend, session } from "./fake-backend.mjs";

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
const OUT = args.out ?? "docs/screenshots/batch47/compare";
const PREVIEW = "file://" + resolve("docs/design/preview.html");
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const DHANTERAS = "00000000-0000-4000-8000-000000007005";

async function appShot(browser, viewport, { path, newDesign, wait, act, fullPage }) {
  const fake = createBackend({ conversations: 40, newDesign });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  await context.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
      localStorage.setItem("aidwar.active_org", "00000000-0000-4000-8000-0000000000a1");
      sessionStorage.setItem("aidwar.journey.exited.00000000-0000-4000-8000-0000000000a1", "1");
    },
    [STORAGE_KEY, JSON.stringify(session())],
  );
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BACKEND)) return fake.backend(route);
    if (url.startsWith(`${BASE}/api/`)) return fake.api(route);
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    if (url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com")) return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/fake-backend\.test/, (ws) => fake.realtime(ws));
  await context.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.connectToServer());
  const page = await context.newPage();
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  if (wait) await page.waitForSelector(wait, { timeout: 15000 }).catch(() => {});
  if (act) await act(page);
  await page.waitForTimeout(1500);
  if (fullPage) {
    const extra = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? Math.max(0, main.scrollHeight - main.clientHeight) : 0;
    });
    if (extra > 0) await page.setViewportSize({ width: viewport.width, height: viewport.height + extra });
    await page.waitForTimeout(300);
  }
  const png = await page.screenshot({ fullPage: Boolean(fullPage) });
  await context.close();
  return png;
}

async function previewShot(browser, viewport, fullPage) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${PREVIEW}#campaigns`);
  await page.waitForTimeout(1200);
  const png = await page.screenshot({ fullPage: Boolean(fullPage) });
  await context.close();
  return png;
}

async function pair(browser, name, left, right, width, labels) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#fff;font:600 15px system-ui;color:#0d2b2a;display:flex;gap:24px;align-items:flex-start}
    figure{margin:0;display:flex;flex-direction:column;gap:8px}img{width:${width}px;border:1px solid #dce7e4;border-radius:8px}
  </style>
  <figure><figcaption>${labels[0]}</figcaption><img src="data:image/png;base64,${left.toString("base64")}"></figure>
  <figure><figcaption>${labels[1]}</figcaption><img src="data:image/png;base64,${right.toString("base64")}"></figure>`;
  const context = await browser.newContext({ viewport: { width: width * 2 + 96, height: 600 } });
  const page = await context.newPage();
  await page.setContent(html);
  await page.waitForTimeout(200);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await context.close();
  console.log("wrote", file);
}

const openWizard = (button, toReview) => async (page) => {
  await page.getByRole("button", { name: button }).first().click();
  await page.waitForTimeout(700);
  await page.getByLabel("Campaign name").fill("Diwali preview — VIP list");
  await page.waitForTimeout(900);
  if (!toReview) return;
  await page.getByRole("button", { name: /^continue/i }).click();
  await page.waitForTimeout(500);
  await page.getByRole("dialog").getByText("order_shipped", { exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^continue/i }).click();
  await page.waitForTimeout(500);
  for (const n of [1, 2]) {
    await page.getByRole("combobox", { name: `Source for {{${n}}}` }).click();
    await page.getByRole("option").first().click();
    await page.waitForTimeout(200);
  }
  for (let i = 0; i < 2; i += 1) {
    await page.getByRole("button", { name: /^continue/i }).click();
    await page.waitForTimeout(500);
  }
};
const openEditor = (button) => async (page) => {
  await page.getByRole("button", { name: button }).first().click();
  await page.waitForTimeout(900);
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

// 1. The preview's #campaigns against the app: the list with the first campaign's results.
for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
  const width = vp === "desktop" ? 960 : 390;
  const left = await previewShot(browser, viewport, vp === "mobile");
  const list = await appShot(browser, viewport, {
    path: "/app/campaigns",
    newDesign: true,
    wait: "text=Diwali preview",
    fullPage: vp === "mobile",
  });
  await pair(browser, `campaigns-list-${vp}`, left, list, width, ["Approved preview", "App, new design on"]);
  // A finished campaign opened (on a phone: full width, the phone below its numbers).
  const results = await appShot(browser, viewport, {
    path: `/app/campaigns/${DHANTERAS}`,
    newDesign: true,
    wait: "text=Sales from this campaign",
    fullPage: vp === "mobile",
  });
  await pair(browser, `campaigns-results-${vp}`, left, results, width, ["Approved preview", "App, new design on"]);
}

// 2. Screens the preview doesn't draw: the Batch 41 look against the new one.
const SCREENS = [
  { name: "wizard-audience", path: "/app/campaigns", wait: "text=Diwali preview", act: (nd) => openWizard(nd ? /new campaign/i : /create campaign/i, false) },
  { name: "wizard-review", path: "/app/campaigns", wait: "text=Diwali preview", act: (nd) => openWizard(nd ? /new campaign/i : /create campaign/i, true) },
  { name: "templates-gallery", path: "/app/templates", wait: "text=order_shipped" },
  { name: "template-editor", path: "/app/templates", wait: "text=order_shipped", act: (nd) => openEditor(nd ? /new template/i : /create template/i) },
  { name: "cards", path: "/app/cards", wait: "h1" },
];
for (const s of SCREENS) {
  for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
    const shot = (nd) => appShot(browser, viewport, { path: s.path, newDesign: nd, wait: s.wait, act: s.act?.(nd) });
    const left = await shot(false);
    const right = await shot(true);
    await pair(browser, `${s.name}-${vp}`, left, right, vp === "desktop" ? 960 : 390, ["Batch 41 (flag off)", "New design (flag on)"]);
  }
}
await browser.close();
