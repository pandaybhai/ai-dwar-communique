/**
 * Batch 49: Automate and Shop side by side at 1440 and 390 — the approved
 * preview's #automate / #shop (docs/design/preview.html: only a heading, its
 * sub-tabs and one line; the screens themselves are designed in its language
 * from docs/design/spec.md), the app with new_design on, and the app with it
 * off (today's page). Fake data (b49-backend.mjs); needs the dev server from
 * b49-shots.mjs's header running.
 *
 *   node scripts/ui-shots/b49-compare.mjs [--base http://127.0.0.1:5199] [--out docs/screenshots/batch49/compare]
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
const OUT = args.out ?? "docs/screenshots/batch49/compare";
const PREVIEW = "file://" + resolve("docs/design/preview.html");
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

const SCREENS = [
  { name: "aiden", hash: "automate", path: "/app/employee", wait: "text=Test Aiden" },
  { name: "flows", hash: "automate", path: "/app/flows", wait: "text=Welcome menu" },
  {
    name: "flow-builder",
    hash: "automate",
    path: "/app/flows/v2/00000000-0000-4000-8000-000000008001",
    wait: ".react-flow__node",
  },
  { name: "automations", hash: "automate", path: "/app/automations", wait: "text=Price list" },
  { name: "catalogue", hash: "shop", path: "/app/catalog", wait: "text=Temple jhumkas" },
  { name: "collections", hash: "shop", path: "/app/catalog/collections", wait: "text=Bridal edit" },
];

async function appShot(browser, viewport, screen, newDesign) {
  const fake = createB49Backend({ conversations: 40, newDesign });
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
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
    if (url.includes("fonts.googleapis.com") || url.includes("fonts.gstatic.com"))
      return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/fake-backend\.test/, (ws) => fake.realtime(ws));
  await context.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.connectToServer());
  const page = await context.newPage();
  await page.goto(BASE + screen.path, { waitUntil: "networkidle" });
  await page.waitForSelector(screen.wait, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const png = await page.screenshot();
  await context.close();
  return png;
}

async function previewShot(browser, viewport, hash) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${PREVIEW}#${hash}`);
  await page.waitForTimeout(800);
  const png = await page.screenshot();
  await context.close();
  return png;
}

async function compose(browser, file, shots, width) {
  const img = (png) => `<img src="data:image/png;base64,${png.toString("base64")}">`;
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px;background:#fff;font:600 15px system-ui;color:#0d2b2a;display:flex;gap:24px;align-items:flex-start}
    figure{margin:0;display:flex;flex-direction:column;gap:8px}img{width:${width}px;border:1px solid #dce7e4;border-radius:8px}
  </style>${shots.map(([cap, png]) => `<figure><figcaption>${cap}</figcaption>${img(png)}</figure>`).join("")}`;
  const context = await browser.newContext({
    viewport: { width: shots.length * (width + 24) + 48, height: 900 },
  });
  const page = await context.newPage();
  await page.setContent(html);
  await page.waitForTimeout(200);
  await page.screenshot({ path: file, fullPage: true });
  await context.close();
  console.log("wrote", file);
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [vpName, viewport] of Object.entries(VIEWPORTS)) {
  const width = vpName === "desktop" ? 560 : 300;
  for (const screen of SCREENS) {
    const preview = await previewShot(browser, viewport, screen.hash);
    const next = await appShot(browser, viewport, screen, true);
    const classic = await appShot(browser, viewport, screen, false);
    await compose(
      browser,
      join(OUT, `${screen.name}-${vpName}.png`),
      [
        [`Approved preview (#${screen.hash}: heading and tabs only)`, preview],
        ["App, new design on", next],
        ["App, new design off (today)", classic],
      ],
      width,
    );
  }
}
await browser.close();
