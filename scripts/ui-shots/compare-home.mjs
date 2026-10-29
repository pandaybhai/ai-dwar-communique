/**
 * Batch 45: the new Home next to the approved preview (docs/design/preview.html
 * #home), in each of Aiden's three modes, at 1440 and 390. The app runs against
 * the fake backend (fake-backend.mjs, aidenMode) with the new design on; both
 * sides with reduced motion so lists, tickers and typing show their end state.
 * Needs the dev server from shoot.mjs's header running.
 *
 *   node scripts/ui-shots/compare-home.mjs [--base http://127.0.0.1:5199] [--out docs/screenshots/batch45/compare]
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
const OUT = args.out ?? "docs/screenshots/batch45/compare";
const PREVIEW = "file://" + resolve("docs/design/preview.html");
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const MODES = [
  { name: "replying", preview: "rep", app: "replying" },
  { name: "draft", preview: "draft", app: "draft" },
  { name: "off", preview: "off", app: "off" },
];

async function appShot(browser, viewport, mode) {
  const fake = createBackend({ conversations: 40, newDesign: true, aidenMode: mode });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
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
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:"))
      return route.continue();
    if (url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com"))
      return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/fake-backend\.test/, (ws) => fake.realtime(ws));
  await context.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.connectToServer());
  const page = await context.newPage();
  await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
  await page.waitForSelector("#home-headline", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const png = await page.screenshot();
  await context.close();
  return png;
}

async function previewShot(browser, viewport, mode) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${PREVIEW}#home`);
  await page.click(`[data-mode=${mode}]`);
  await page.waitForTimeout(1200);
  const png = await page.screenshot();
  await context.close();
  return png;
}

async function pair(browser, name, left, right, width) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#fff;font:600 15px system-ui;color:#0d2b2a;display:flex;gap:24px;align-items:flex-start}
    figure{margin:0;display:flex;flex-direction:column;gap:8px}img{width:${width}px;border:1px solid #dce7e4;border-radius:8px}
  </style>
  <figure><figcaption>Approved preview</figcaption><img src="data:image/png;base64,${left.toString("base64")}"></figure>
  <figure><figcaption>App, new design on</figcaption><img src="data:image/png;base64,${right.toString("base64")}"></figure>`;
  const context = await browser.newContext({ viewport: { width: width * 2 + 96, height: 600 } });
  const page = await context.newPage();
  await page.setContent(html);
  await page.waitForTimeout(200);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await context.close();
  console.log("wrote", file);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const m of MODES) {
  for (const [vp, viewport] of Object.entries(VIEWPORTS)) {
    const left = await previewShot(browser, viewport, m.preview);
    const right = await appShot(browser, viewport, m.app);
    await pair(browser, `home-${m.name}-${vp}`, left, right, vp === "desktop" ? 960 : 390);
  }
}
await browser.close();
