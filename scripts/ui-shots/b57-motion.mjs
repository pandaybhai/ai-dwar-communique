/**
 * Batch 57: short recordings of the key motions on the fake backend (fake
 * data only; nothing leaves the browser but the dev server and Google Fonts):
 * Home loading, Aiden typing in the Inbox, the campaign send moment, and the
 * phone's More sheet. Writes .webm per clip; turn them into GIFs with ffmpeg.
 *
 *   VITE_AIDWAR_SUPABASE_URL=http://fake-backend.test VITE_AIDWAR_SUPABASE_ANON_KEY=fake \
 *     npx vite dev --port 5199 --host 127.0.0.1
 *   node scripts/ui-shots/b57-motion.mjs --out docs/screenshots/batch57/motion
 */
import { createRequire } from "node:module";
import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { BACKEND, STORAGE_KEY, createBackend, session } from "./fake-backend.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://127.0.0.1:5199";
const OUT = args.out ?? "docs/screenshots/batch57/motion";
const chatAt = (i) => `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`;

const CLIPS = {
  "home-load": {
    size: { width: 1280, height: 800 },
    path: "/app",
    run: async (page) => page.waitForTimeout(5200),
  },
  "inbox-typing": {
    size: { width: 1280, height: 800 },
    path: `/app/inbox?c=${chatAt(8)}`,
    typingIn: chatAt(8),
    run: async (page) => page.waitForTimeout(4200),
  },
  "campaign-send": {
    size: { width: 1280, height: 800 },
    path: "/app/campaigns",
    run: async (page) => {
      await page.waitForSelector("text=Diwali preview", { timeout: 15000 });
      await page.getByRole("button", { name: /new campaign/i }).first().click();
      await page.waitForTimeout(600);
      await page.getByLabel("Campaign name").fill("Diwali offer: 15% off earrings");
      await page.waitForTimeout(500);
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(400);
      await page.getByRole("dialog").getByText("order_shipped", { exact: true }).click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(400);
      for (const n of [1, 2]) {
        await page.getByRole("combobox", { name: `Source for {{${n}}}` }).click();
        await page.getByRole("option").first().click();
        await page.waitForTimeout(150);
      }
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(300);
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: /^(Send to|Schedule for|Send for approval)/ }).click();
      await page.waitForTimeout(3600);
    },
  },
  "phone-more": {
    size: { width: 390, height: 844 },
    path: "/app",
    run: async (page) => {
      await page.waitForTimeout(2600);
      await page.getByRole("button", { name: "More" }).click();
      await page.waitForTimeout(1600);
    },
  },
};

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [name, clip] of Object.entries(CLIPS)) {
  if (args.only && !args.only.split(",").includes(name)) continue;
  const fake = createBackend({ conversations: 40, newDesign: true, aidenMode: "replying", typingIn: clip.typingIn });
  const context = await browser.newContext({
    viewport: clip.size,
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: clip.size },
  });
  await context.addInitScript(([key, value]) => {
    localStorage.setItem(key, value);
    localStorage.setItem("aidwar.active_org", "00000000-0000-4000-8000-0000000000a1");
    sessionStorage.setItem("aidwar.journey.exited.00000000-0000-4000-8000-0000000000a1", "1");
  }, [STORAGE_KEY, JSON.stringify(session())]);
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
  await page.goto(`${BASE}${clip.path}`);
  await clip.run(page);
  const video = page.video();
  await context.close();
  if (video) renameSync(await video.path(), join(OUT, `${name}.webm`));
  console.log("wrote", join(OUT, `${name}.webm`));
}
await browser.close();
