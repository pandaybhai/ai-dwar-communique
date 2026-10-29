/**
 * Batch 46: the Inbox side by side — the approved preview's #inbox
 * (docs/design/preview.html) next to the app with the new design on, at 1440
 * and 390: the list, an open chat, a chat waiting for you, and the empty Inbox.
 * Needs the dev server from shoot.mjs's header running.
 *
 *   node scripts/ui-shots/compare-inbox.mjs [--base http://127.0.0.1:5199] [--out docs/screenshots/batch46/compare]
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
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://127.0.0.1:5199";
const OUT = args.out ?? "docs/screenshots/batch46/compare";
const PREVIEW = "file://" + resolve("docs/design/preview.html");
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const chat = (i) => `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`;

async function appPage(browser, viewport, path, conversations = 40) {
  const fake = createBackend({ conversations, newDesign: true });
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
  await page.waitForSelector("h1", { state: "attached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page;
}

async function previewPage(browser, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.goto(`${PREVIEW}#inbox`);
  await page.waitForTimeout(1000);
  return page;
}

async function pair(browser, name, left, right, width) {
  const img = (png) => `<img src="data:image/png;base64,${png.toString("base64")}">`;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#fff;font:600 15px system-ui;color:#0d2b2a;display:flex;gap:24px;align-items:flex-start}
    figure{margin:0;display:flex;flex-direction:column;gap:8px}img{width:${width}px;border:1px solid #dce7e4;border-radius:8px}
  </style>
  <figure><figcaption>${left ? "Approved preview" : "Approved preview (no such state)"}</figcaption>${left ? img(left) : ""}</figure>
  <figure><figcaption>App, new design on</figcaption>${img(right)}</figure>`;
  const context = await browser.newContext({ viewport: { width: 2 * width + 80, height: 900 } });
  const page = await context.newPage();
  await page.setContent(html);
  await page.waitForTimeout(200);
  const file = join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await context.close();
  console.log("wrote", file);
}

const draft = async (page) => {
  await page.getByRole("button", { name: "Draft a reply" }).first().click();
  await page.waitForTimeout(700);
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

// Desktop: the preview opens on a waiting chat with Aiden's suggestion.
{
  const p = await previewPage(browser, DESK);
  const left = await p.screenshot();
  const waiting = await appPage(browser, DESK, `/app/inbox?c=${chat(0)}`);
  await draft(waiting);
  await pair(browser, "needs-human-chat-desktop", left, await waiting.screenshot(), 720);
  const open = await appPage(browser, DESK, `/app/inbox?c=${chat(8)}`);
  await pair(browser, "open-chat-desktop", left, await open.screenshot(), 720);
  const list = await appPage(browser, DESK, "/app/inbox");
  await pair(browser, "list-desktop", left, await list.screenshot(), 720);
  const empty = await appPage(browser, DESK, "/app/inbox", 0);
  await pair(browser, "empty-desktop", null, await empty.screenshot(), 720);
}

// Phone: the list, then a chat opened full screen.
{
  const p = await previewPage(browser, PHONE);
  const list = await appPage(browser, PHONE, "/app/inbox");
  await pair(browser, "list-phone", await p.screenshot(), await list.screenshot(), 390);
  await p.click(".chatrow >> nth=0");
  await p.waitForTimeout(400);
  const left = await p.screenshot();
  const waiting = await appPage(browser, PHONE, `/app/inbox?c=${chat(0)}`);
  await draft(waiting);
  await pair(browser, "needs-human-chat-phone", left, await waiting.screenshot(), 390);
  const open = await appPage(browser, PHONE, `/app/inbox?c=${chat(8)}`);
  await pair(browser, "open-chat-phone", left, await open.screenshot(), 390);
  const empty = await appPage(browser, PHONE, "/app/inbox", 0);
  await pair(browser, "empty-phone", null, await empty.screenshot(), 390);
}

await browser.close();
