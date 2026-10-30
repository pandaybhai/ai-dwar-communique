/**
 * Batch 53: screenshots at 1440 and 390 on the fake backend (fake-backend.mjs)
 * plus Batch 53's own answers: the avatar-menu switch in both designs and the
 * first-time intro (taken with the release flag aiden_workspace ON in the
 * fake backend — how it will look after Batch 55; it ships OFF), the AI
 * assistants page in Classic and Aiden Workspace, the Home card in both, and
 * the public /ai-assistants page signed out. Fictional data; nothing leaves
 * the browser but the dev server and Google Fonts.
 *
 *   VITE_AIDWAR_SUPABASE_URL=http://fake-backend.test VITE_AIDWAR_SUPABASE_ANON_KEY=fake \
 *     npx vite dev --port 5199 --host 127.0.0.1
 *   node scripts/ui-shots/b53-shots.mjs --out docs/screenshots/batch53
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
const OUT = args.out ?? "docs/screenshots/batch53";
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const ME = session().user.id;

/**
 * release: the aiden_workspace flag's default; unlocked: the workspace's
 * unlock time; introSeen; grants: the person's OAuth grants.
 */
const SCENARIOS = {
  "switch-classic": { path: "/app/inbox", release: true, unlocked: null, introSeen: true, menu: "Account:", wait: "text=Try Aiden Workspace" },
  "switch-aiden-workspace": { path: "/app/inbox", release: true, unlocked: "2026-10-30T06:00:00Z", introSeen: true, menu: "account menu", wait: "text=Switch to Classic" },
  "intro-tour": { path: "/app", release: true, unlocked: "2026-10-30T06:00:00Z", introSeen: false, wait: "text=Welcome to Aiden Workspace" },
  "dark-classic-unlocked": { path: "/app/inbox", release: false, unlocked: "2026-10-30T06:00:00Z", introSeen: false, menu: "Account:", wait: "text=Keyboard shortcuts" },
  "ai-assistants-classic": { path: "/app/ai-assistants", release: false, wait: "text=What your AI did", full: true },
  "ai-assistants-aiden-workspace": { path: "/app/ai-assistants", release: false, newDesign: true, wait: "text=What your AI did", full: true },
  "home-card-classic": { path: "/app", release: false, grants: [], wait: "text=Connect your AI assistant", crop: "section[aria-labelledby=connect-ai-title]" },
  "home-card-aiden-workspace": { path: "/app", release: false, newDesign: true, grants: [], wait: "text=Connect your AI assistant", crop: "section[aria-labelledby=connect-ai-title]" },
  "public-page": { path: "/ai-assistants", signedOut: true, wait: "text=Run WhatsApp marketing", full: true, settle: 7000 },
};

const GRANTS = [
  { client: { id: "c-claude", name: "Claude", uri: "https://claude.ai", logo_uri: "" }, scopes: ["email"], granted_at: "2026-10-28T09:12:00Z" },
];

const OVERVIEW = {
  mcpOn: true,
  supportLocked: false,
  canManage: true,
  seesEveryone: true,
  apps: [
    { userId: ME, member: "You", mine: true, clientId: "c-claude", name: "Claude", site: "claude.ai", grantedAt: "2026-10-28T09:12:00Z", lastUsedAt: "2026-10-30T05:40:00Z" },
    { userId: "00000000-0000-4000-8000-0000000000b2", member: "Neha Joshi", mine: false, clientId: "c-cursor", name: "Cursor", site: "cursor.com", grantedAt: "2026-10-21T16:40:00Z", lastUsedAt: "2026-10-29T12:05:00Z" },
  ],
  timeline: [
    { id: "e3", action: "mcp_campaign_sent", at: "2026-10-30T05:41:00Z", userId: ME, member: "You", app: "Claude", appId: "c-claude", name: "Diwali for VIPs", link: "/app/campaigns/k1" },
    { id: "e2", action: "mcp_campaign_drafted", at: "2026-10-30T05:38:00Z", userId: ME, member: "You", app: "Claude", appId: "c-claude", name: "Diwali for VIPs", link: "/app/campaigns/k1" },
    { id: "e1", action: "mcp_flow_drafted", at: "2026-10-29T12:04:00Z", userId: "00000000-0000-4000-8000-0000000000b2", member: "Neha Joshi", app: "Cursor", appId: "c-cursor", name: null, link: "/app/flows/v2/f1" },
  ],
  usage: { callsThisMinute: 4, callsPerMinute: 60, sendsThisHour: 1, sendsPerHour: 5 },
};

async function shoot(browser, name, s, vp) {
  const fake = createBackend({ conversations: 12, newDesign: Boolean(s.newDesign), campaigns: 0 });
  // The app shell scrolls inside <main>: a tall window shows a whole page.
  const viewport = s.full && !s.signedOut ? { ...VIEWPORTS[vp], height: vp === "mobile" ? 4600 : 2700 } : VIEWPORTS[vp];
  const context = await browser.newContext({ viewport, deviceScaleFactor: vp === "mobile" ? 2 : 1, colorScheme: "light" });
  if (!s.signedOut)
    await context.addInitScript(
      ([key, value]) => {
        localStorage.setItem(key, value);
        localStorage.setItem("aidwar.active_org", "00000000-0000-4000-8000-0000000000a1");
        localStorage.setItem("aidwar.theme", "light");
        sessionStorage.setItem("aidwar.journey.exited.00000000-0000-4000-8000-0000000000a1", "1");
      },
      [STORAGE_KEY, JSON.stringify(session())],
    );
  const json = (route, body) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const href = url.href;
    if (href.startsWith(BACKEND)) {
      if (url.pathname === "/auth/v1/user/oauth/grants") return json(route, s.grants ?? GRANTS);
      if (url.pathname === "/rest/v1/feature_flags") {
        const res = await fetchFake(fake, route);
        const rows = JSON.parse(res || "[]");
        rows.push({ key: "mcp_access", default_enabled: true }, { key: "new_design", default_enabled: false }, { key: "aiden_workspace", default_enabled: Boolean(s.release) });
        return json(route, rows);
      }
      return fake.backend(route);
    }
    if (href.startsWith(`${BASE}/api/`)) {
      if (url.pathname === "/api/permissions") return json(route, { permissions: PERMS, overrides: {} });
      if (url.pathname === "/api/design")
        return json(route, route.request().method() === "GET"
          ? { super_admin_override: null, choice: null, unlocked_at: s.unlocked ?? null, intro_seen_at: s.introSeen ? "2026-10-30T06:00:00Z" : null }
          : { saved: true });
      if (url.pathname === "/api/ai-assistants") return json(route, OVERVIEW);
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
  await page.goto(`${BASE}${s.path}`, { waitUntil: "networkidle" });
  if (s.menu) {
    await page.waitForTimeout(1500);
    await page.locator(`button[aria-label*="${s.menu}"]`).first().click();
  }
  await page.waitForSelector(s.wait, { timeout: 20000 }).catch(() => console.error(`${name}/${vp}: never saw ${s.wait}`));
  await page.waitForTimeout(s.settle ?? 1200);
  const file = join(OUT, `${name}-${vp}.png`);
  if (s.crop) await page.locator(s.crop).first().screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: Boolean(s.full) });
  console.log("wrote", file);
  await context.close();
}

const PERMS = [
  "ai.configure", "ai.use", "analytics.view", "automations.manage", "billing.view", "campaigns.create",
  "campaigns.send", "campaigns.view", "cards.view", "catalog.view", "contacts.view", "flows.manage", "flows.view",
  "inbox.reply", "inbox.view", "inbox.assign", "integrations.view", "segments.manage", "settings.manage",
  "settings.view", "team.manage", "templates.manage", "mcp.use",
];

/** The fake backend's own answer for a REST read, as text. */
async function fetchFake(fake, route) {
  let body = "[]";
  await fake.backend({
    request: () => route.request(),
    fulfill: async (o) => {
      body = o.body ?? "[]";
    },
    continue: async () => undefined,
    abort: async () => undefined,
  });
  return body;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [name, scenario] of Object.entries(SCENARIOS)) {
  if (args.only && !args.only.split(",").includes(name)) continue;
  for (const vp of Object.keys(VIEWPORTS)) await shoot(browser, name, scenario, vp);
}
await browser.close();
