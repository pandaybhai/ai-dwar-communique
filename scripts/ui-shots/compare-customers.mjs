/**
 * Batch 48: Customers side by side — the approved preview's #customers
 * (docs/design/preview.html) next to the app with the new design on, at 1440
 * and 390: the list, rows selected (the bulk bar), and the screens the preview
 * doesn't draw (drawer, import, segments, sales from chats) against its list.
 * Needs the dev server from shoot.mjs's header running.
 *
 *   node scripts/ui-shots/compare-customers.mjs [--base http://127.0.0.1:5199] [--out docs/screenshots/batch48/compare]
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
const OUT = args.out ?? "docs/screenshots/batch48/compare";
const PREVIEW = "file://" + resolve("docs/design/preview.html");
const DESK = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

async function appPage(browser, viewport, path, conversations = 40) {
  const fake = createBackend({ conversations, newDesign: true, customers: true });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
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
  await page.goto(BASE + path, { waitUntil: "networkidle" });
  await page.waitForSelector("h1", { state: "attached", timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  return page;
}

async function previewPage(browser, viewport) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${PREVIEW}#customers`);
  await page.waitForTimeout(1000);
  return page;
}

async function pair(browser, name, left, right, width) {
  const img = (png) => `<img src="data:image/png;base64,${png.toString("base64")}">`;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#fff;font:600 15px system-ui;color:#0d2b2a;display:flex;gap:24px;align-items:flex-start}
    figure{margin:0;display:flex;flex-direction:column;gap:8px}img{width:${width}px;border:1px solid #dce7e4;border-radius:8px}
  </style>
  <figure><figcaption>${left ? "Approved preview" : "Approved preview (doesn't draw this screen; see the spec)"}</figcaption>${left ? img(left) : ""}</figure>
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

const visible = (page, role, name) => page.getByRole(role, { name }).filter({ visible: true }).first();
async function select(page) {
  for (const n of ["Select Asha Iyer", "Select Vikram Mehta", "Select Meera Nair"]) {
    await visible(page, "checkbox", n).click();
  }
  await page.waitForTimeout(500);
}
async function previewSelect(p) {
  for (const i of [0, 1, 2]) await p.click(`#ctbody input >> nth=${i}`);
  await p.waitForTimeout(300);
}
async function drawer(page) {
  await page.getByRole("button", { name: /Asha Iyer/ }).filter({ visible: true }).first().click();
  await page.waitForTimeout(1500);
}
const CSV = "phone,name,tags,city\n+919876543210,Priya Sharma,\"vip,repeat-buyer\",Hyderabad\n+919812345678,Rahul Verma,new-customer,Mumbai\n";
async function importStep(page, step) {
  await page.getByRole("button", { name: /^Import/ }).first().click();
  await page.waitForTimeout(600);
  if (step < 2) return;
  await page.locator('input[type="file"]').setInputFiles({ name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from(CSV) });
  await page.waitForTimeout(700);
  if (step < 3) return;
  await page.getByRole("button", { name: /^Continue/ }).click();
  await page.waitForTimeout(600);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

for (const [vp, tag, width] of [
  [DESK, "desktop", 720],
  [PHONE, "phone", 390],
]) {
  const p = await previewPage(browser, vp);
  const list = await previewPage(browser, vp).then((x) => x.screenshot());
  await pair(browser, `list-${tag}`, list, await (await appPage(browser, vp, "/app/contacts")).screenshot(), width);
  await previewSelect(p);
  const sel = await appPage(browser, vp, "/app/contacts");
  await select(sel);
  if (tag === "phone") {
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await p.waitForTimeout(200);
  }
  await pair(browser, `selected-${tag}`, await p.screenshot(), await sel.screenshot(), width);
  const d = await appPage(browser, vp, "/app/contacts");
  await drawer(d);
  await pair(browser, `drawer-${tag}`, null, await d.screenshot(), width);
  for (const step of [1, 2, 3]) {
    const im = await appPage(browser, vp, "/app/contacts");
    await importStep(im, step);
    await pair(browser, `import-${step}-${tag}`, null, await im.screenshot(), width);
  }
  const seg = await appPage(browser, vp, "/app/contacts?tab=segments");
  await pair(browser, `segments-${tag}`, null, await seg.screenshot(), width);
  const rec = await appPage(browser, vp, "/app/receipts");
  await pair(browser, `sales-from-chats-${tag}`, null, await rec.screenshot(), width);
}

await browser.close();
