/**
 * Batch 61: screenshots of Settings → API & webhooks → "Copies to your team"
 * (the default copy numbers for API template sends), Classic and Aiden
 * Workspace, at 1440 and 390, on the fake backend (fake-backend.mjs).
 * Fictional data; nothing leaves the machine but Google Fonts.
 *
 *   VITE_AIDWAR_SUPABASE_URL=http://fake-backend.test VITE_AIDWAR_SUPABASE_ANON_KEY=fake \
 *     npx vite dev --port 5199 --host 127.0.0.1
 *   node scripts/ui-shots/b61-shots.mjs --out docs/screenshots/batch61
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
const OUT = args.out ?? "docs/screenshots/batch61";

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const SCENARIOS = {
  classic: { newDesign: false },
  "aiden-workspace": { newDesign: true },
  "classic-error": { newDesign: false, typeBad: true },
};

async function shoot(browser, name, s, vp) {
  const fake = createBackend({ conversations: 4, newDesign: s.newDesign, campaigns: 0 });
  const context = await browser.newContext({
    viewport: VIEWPORTS[vp],
    deviceScaleFactor: 2,
    colorScheme: "light",
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
  let saved = ["+918000000001", "+918000000002"];
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const href = url.href;
    if (href.startsWith(BACKEND)) return fake.backend(route);
    if (href.startsWith(`${BASE}/api/`)) {
      if (url.pathname === "/api/developer/copies") {
        if (route.request().method() === "GET") return json(route, { available: true, max: 3, numbers: saved });
        saved = JSON.parse(route.request().postData() || "{}").numbers ?? saved;
        return json(route, { ok: true, numbers: saved });
      }
      return fake.api(route);
    }
    if (href.startsWith(BASE) || href.startsWith("data:") || href.startsWith("blob:")) return route.continue();
    if (href.startsWith("https://fonts.googleapis.com") || href.startsWith("https://fonts.gstatic.com")) return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/fake-backend\.test/, (ws) => fake.realtime(ws));
  await context.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.connectToServer());
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error(`${name}/${vp}: ${err.message}`));
  await page.goto(`${BASE}/app/settings?tab=api`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=Copies to your team", { timeout: 30000 });
  if (s.typeBad) {
    await page.fill("#api-cc-2", "+91 12");
    await page.click("button:has-text('Save copy numbers')");
    await page.waitForSelector("[role=alert]");
  }
  await page.waitForTimeout(1200);
  const card = page.locator("section[aria-labelledby=api-copies-title]");
  await card.scrollIntoViewIfNeeded();
  const file = join(OUT, `${name}-${vp}.png`);
  await card.screenshot({ path: file });
  // The card in its page, too (where it sits under API keys).
  if (!s.typeBad) await page.screenshot({ path: join(OUT, `${name}-${vp}-page.png`) });
  console.log("wrote", file);
  await context.close();
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, s] of Object.entries(SCENARIOS))
    for (const vp of Object.keys(VIEWPORTS)) {
      if (name === "classic-error" && vp === "mobile") continue;
      await shoot(browser, name, s, vp);
    }
} finally {
  await browser.close();
}
