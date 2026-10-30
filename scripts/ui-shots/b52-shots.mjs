/**
 * Batch 52: screenshots of AiDwar MCP's screens at 1440 and 390, on the fake
 * backend (fake-backend.mjs) plus fake Supabase OAuth answers: the consent
 * page, /developers#mcp, the new_site landing's "Works with" section and
 * Settings > Connected AI apps. Fictional data; nothing leaves the browser
 * but the dev server and Google Fonts.
 *
 *   VITE_AIDWAR_SUPABASE_URL=http://fake-backend.test VITE_AIDWAR_SUPABASE_ANON_KEY=fake \
 *     npx vite dev --port 5199 --host 127.0.0.1
 *   node scripts/ui-shots/b52-shots.mjs --out docs/screenshots/batch52
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
const OUT = args.out ?? "docs/screenshots/batch52";
const AUTH_ID = "6f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

const SCENARIOS = {
  consent: { path: `//oauth/consent?authorization_id=${AUTH_ID}`, wait: "text=wants to use your AiDwar workspace" },
  "developers-mcp": { path: "/developers#mcp", wait: "#mcp", crop: "#mcp", signedOut: true },
  "landing-mcp": { path: "/?site=new", wait: "#ai-assistants", crop: "#ai-assistants", signedOut: true, scrollTo: "#ai-assistants", settle: 7000 },
  "settings-ai-apps": { path: "/app/settings?tab=ai_apps", wait: "text=Claude", newDesign: true },
};

const oauth = (route) => {
  const url = new URL(route.request().url());
  const json = (body) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
  if (url.pathname === `/auth/v1/oauth/authorizations/${AUTH_ID}`)
    return json({
      authorization_id: AUTH_ID,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      client: { id: "c-claude", name: "Claude", uri: "https://claude.ai", logo_uri: "" },
      user: { id: session().user.id, email: session().user.email },
      scope: "openid email profile",
    });
  if (url.pathname === "/auth/v1/user/oauth/grants")
    return json([
      { client: { id: "c-claude", name: "Claude", uri: "https://claude.ai", logo_uri: "" }, scopes: ["email"], granted_at: "2026-10-28T09:12:00Z" },
      { client: { id: "c-cursor", name: "Cursor", uri: "https://cursor.com", logo_uri: "" }, scopes: ["email"], granted_at: "2026-10-21T16:40:00Z" },
    ]);
  return null;
};

async function shoot(browser, name, scenario, vp) {
  const fake = createBackend({ conversations: 12, newDesign: Boolean(scenario.newDesign) });
  const context = await browser.newContext({ viewport: VIEWPORTS[vp], deviceScaleFactor: vp === "mobile" ? 2 : 1, colorScheme: "light" });
  if (!scenario.signedOut)
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
    if (url.startsWith(BACKEND)) return oauth(route) ?? fake.backend(route);
    if (url.startsWith(`${BASE}/api/`)) return fake.api(route);
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    if (url.startsWith("https://fonts.googleapis.com") || url.startsWith("https://fonts.gstatic.com")) return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/fake-backend\.test/, (ws) => fake.realtime(ws));
  await context.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.connectToServer());
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error(`${name}/${vp}: ${err.message}`));
  await page.goto(`${BASE}${scenario.path}`, { waitUntil: "networkidle" });
  await page.waitForSelector(scenario.wait, { timeout: 20000 }).catch(() => console.error(`${name}/${vp}: never saw ${scenario.wait}`));
  if (scenario.scrollTo) await page.locator(scenario.scrollTo).scrollIntoViewIfNeeded();
  await page.waitForTimeout(scenario.settle ?? 1200);
  const file = join(OUT, `${name}-${vp}.png`);
  if (scenario.crop) await page.locator(scenario.crop).screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: true });
  console.log("wrote", file, "at", page.url());
  await context.close();
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (args.only && !args.only.split(",").includes(name)) continue;
  for (const vp of Object.keys(VIEWPORTS)) await shoot(browser, name, scenario, vp);
}
await browser.close();
