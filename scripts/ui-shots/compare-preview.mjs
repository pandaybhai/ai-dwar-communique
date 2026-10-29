/**
 * Batch 44: side-by-side pictures, the approved preview (docs/design/preview.html)
 * next to the app with the new design on, for the shell and each shared
 * component. Needs the dev server from shoot.mjs's header running.
 *
 *   node scripts/ui-shots/compare-preview.mjs [--base http://127.0.0.1:5199] [--out docs/screenshots/batch44/compare]
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKEND, STORAGE_KEY, createBackend, session } from "./fake-backend.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://127.0.0.1:5199";
const OUT = args.out ?? "docs/screenshots/batch44/compare";
const PREVIEW = "file://" + resolve("docs/design/preview.html");
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function appPage(browser, viewport, path) {
  const fake = createBackend({ conversations: 40, newDesign: true });
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce" });
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
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.waitForSelector("h1", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return page;
}

async function previewPage(browser, viewport, hash) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${PREVIEW}#${hash}`);
  await page.waitForTimeout(1200);
  return page;
}

const shot = async (page, target) =>
  typeof target === "string"
    ? page.locator(target).first().screenshot()
    : page.screenshot({ clip: target });

async function pair(browser, name, left, right) {
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#fff;font:600 15px system-ui;color:#0d2b2a;display:flex;gap:24px;align-items:flex-start}
    figure{margin:0;display:flex;flex-direction:column;gap:8px}img{max-width:${left.width ?? 720}px;border:1px solid #dce7e4;border-radius:8px}
  </style>
  <figure><figcaption>Approved preview</figcaption><img src="data:image/png;base64,${left.png.toString("base64")}"></figure>
  <figure><figcaption>App, new design on</figcaption><img src="data:image/png;base64,${right.png.toString("base64")}"></figure>`;
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
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

// Shell, desktop.
{
  const p = await previewPage(browser, DESK, "campaigns");
  const a = await appPage(browser, DESK, "/app/campaigns");
  await pair(browser, "top-bar-and-page-head-desktop", { png: await shot(p, { x: 100, y: 0, width: 1240, height: 140 }) }, { png: await shot(a, { x: 100, y: 0, width: 1240, height: 140 }) });
  await p.click("#meBtn");
  await a.getByRole("button", { name: /account menu$/ }).click();
  await p.waitForTimeout(300);
  await a.waitForTimeout(500);
  await pair(browser, "avatar-menu-desktop", { png: await shot(p, { x: 1040, y: 0, width: 300, height: 320 }), width: 340 }, { png: await shot(a, { x: 1040, y: 0, width: 300, height: 360 }), width: 340 });
}

// Shell, phone.
{
  const p = await previewPage(browser, PHONE, "customers");
  const a = await appPage(browser, PHONE, "/app/contacts");
  await pair(browser, "top-bar-and-page-head-phone", { png: await shot(p, { x: 0, y: 0, width: 390, height: 230 }), width: 390 }, { png: await shot(a, { x: 0, y: 0, width: 390, height: 230 }), width: 390 });
  await pair(browser, "bottom-bar-phone", { png: await shot(p, "#bnav"), width: 390 }, { png: await shot(a, "nav.nd-bottom-bar"), width: 390 });
  await p.click("#moreBtn");
  await a.getByRole("button", { name: "More" }).click();
  await p.waitForTimeout(500);
  await a.waitForTimeout(700);
  await pair(browser, "more-sheet-phone", { png: await shot(p, ".sheetin"), width: 390 }, { png: await shot(a, "[role=dialog]"), width: 390 });
}

// Shared components: the preview's live screens next to /app/design.
{
  const p = await previewPage(browser, DESK, "home");
  const a = await appPage(browser, DESK, "/app/design");
  const demo = (name) => `[data-demo="${name}"] > div`;
  await pair(browser, "aiden-orb", { png: await shot(p, "#orb"), width: 200 }, { png: await shot(a, demo("aiden-s-orb")), width: 520 });
  await pair(browser, "needs-you-card", { png: await shot(p, ".beam"), width: 460 }, { png: await shot(a, demo("needs-you")), width: 460 });
  await pair(browser, "number-ticker", { png: await shot(p, "#stats"), width: 460 }, { png: await shot(a, demo("number-ticker")), width: 460 });
  await pair(browser, "animated-list", { png: await shot(p, "#sig"), width: 700 }, { png: await shot(a, demo("animated-list-newest-on-top")), width: 700 });
  await pair(browser, "typing-text", { png: await shot(p, ".item .reply"), width: 700 }, { png: await shot(a, demo("typing-text")), width: 700 });
  await pair(browser, "avatar-circles", { png: await shot(p, ".item .av"), width: 120 }, { png: await shot(a, demo("avatars-and-arrival")), width: 520 });
  await p.click("[data-mode=off]");
  await p.waitForTimeout(600);
  await pair(browser, "countdown-ring", { png: await shot(p, ".ring"), width: 460 }, { png: await shot(a, demo("countdown-ring")), width: 460 });
  const pcamp = await previewPage(browser, DESK, "campaigns");
  await pair(browser, "page-head-tabs", { png: await shot(pcamp, ".phead"), width: 720 }, { png: await shot(a, "#page-header > div > div"), width: 720 });
  await p.click("[data-mode=draft]");
  const pi = await previewPage(browser, DESK, "inbox");
  await pair(browser, "whatsapp-bubbles", { png: await shot(pi, "#wall"), width: 700 }, { png: await shot(a, demo("bubbles")), width: 700 });
  await pair(browser, "phone-frame", { png: await shot(pcamp, ".phone"), width: 320 }, { png: await shot(a, demo("phone")), width: 320 });
  // The bottom sheet component on its own (the More sheet above is the shell's use of it).
  await a.getByRole("button", { name: "Open a bottom sheet" }).click();
  await a.waitForTimeout(600);
  const pm = await previewPage(browser, PHONE, "home");
  await pm.click("#moreBtn");
  await pm.waitForTimeout(500);
  await pair(browser, "bottom-sheet", { png: await shot(pm, ".sheetin"), width: 390 }, { png: await shot(a, "[role=dialog]"), width: 720 });
}

await browser.close();
