/**
 * Batch 55: screenshots of no-GST billing on the fake backend (fake-backend.mjs):
 * /pricing (classic and new_site), the plan checkout dialog, and Super Admin >
 * Billing > GST. The server-rendered pricing page reads plans and the GST switch
 * from a local fake PostgREST this script starts (--rest-port, default 54399);
 * start the dev server against it. Fictional data; nothing leaves the machine
 * but Google Fonts.
 *
 *   AIDWAR_SUPABASE_URL=http://127.0.0.1:54399 AIDWAR_SUPABASE_SERVICE_ROLE_KEY=fake \
 *   VITE_AIDWAR_SUPABASE_URL=http://fake-backend.test VITE_AIDWAR_SUPABASE_ANON_KEY=fake \
 *     npx vite dev --port 5199 --host 127.0.0.1
 *   node scripts/ui-shots/b55-shots.mjs --out docs/screenshots/batch55
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKEND, STORAGE_KEY, createBackend, session } from "./fake-backend.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://127.0.0.1:5199";
const OUT = args.out ?? "docs/screenshots/batch55";
const REST_PORT = Number(args["rest-port"] ?? 54399);

const PLANS = [
  { key: "starter", name: "Starter", tagline: "One number, one person", sort_order: 1, price: 999 },
  { key: "growth", name: "Growth", tagline: "For a busy shop", sort_order: 2, price: 2499 },
  { key: "scale", name: "Scale", tagline: "Several numbers and teams", sort_order: 3, price: 4999 },
  { key: "enterprise", name: "Enterprise", tagline: "Talk to us", sort_order: 4, price: null },
];

/** Just enough PostgREST for getPublicPlans / getPublicRates on the server. */
function startRest() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${REST_PORT}`);
    const send = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const single = String(req.headers["accept"] ?? "").includes("vnd.pgrst.object");
    if (url.pathname === "/rest/v1/platform_settings") {
      const row = { id: true, gst_registered: false, supplier_gstin: null };
      return send(single ? row : [row]);
    }
    if (url.pathname === "/rest/v1/plans") {
      return send(
        PLANS.map((p) => ({
          key: p.key,
          name: p.name,
          tagline: p.tagline,
          sort_order: p.sort_order,
          plan_versions: [
            {
              price_monthly: p.price,
              price_annual: p.price ? p.price * 10 : null,
              currency: "INR",
              is_current: true,
              limits: p.price
                ? { members: Math.round(p.price / 500), numbers: p.price > 3000 ? 3 : 1, ai_answers: p.price }
                : { members: -1, numbers: -1, ai_answers: -1 },
              highlights: ["Aiden replies in your voice", "Campaigns and flows"],
            },
          ],
        })),
      );
    }
    return send(single ? null : []);
  });
  return new Promise((resolve) => server.listen(REST_PORT, "127.0.0.1", () => resolve(server)));
}

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

const SCENARIOS = {
  pricing: { path: "/pricing", wait: "text=Plus credits", signedOut: true, fullPage: true },
  "pricing-new-site": { path: "/pricing?site=new", wait: "text=Plus credits", signedOut: true, fullPage: true, settle: 4000 },
  checkout: { path: "/app/billing", wait: "text=Choose plan", planStatus: "trial", click: "button:has-text('Choose plan') >> nth=1", dialog: true },
  "admin-gst": { path: "/admin/billing", wait: "text=GST", admin: true, click: "role=tab[name='GST']", after: "text=Invoices issued with GST", fullPage: true },
};

const GST_INVOICES = [
  {
    id: "inv-11",
    organization_name: "ZOORI Jewels",
    invoice_number: "AD/2026-27/00011",
    purpose: "credit_purchase",
    status: "paid",
    issue_date: "2026-10-12",
    taxable_value: 200,
    gst: 36,
    total: 236,
    amount_paid: 236,
    blocked: null,
    reissued_as: null,
  },
  {
    id: "inv-09",
    organization_name: "Kesar Sarees",
    invoice_number: "AD/2026-27/00009",
    purpose: "plan_fee",
    status: "issued",
    issue_date: "2026-10-03",
    taxable_value: 2499,
    gst: 449.82,
    total: 2948.82,
    amount_paid: 0,
    blocked: "Not paid in full — no GST was collected to give back. Decide on this one by hand.",
    reissued_as: null,
  },
];

async function shoot(browser, name, scenario, vp) {
  const fake = createBackend({ conversations: 4, planStatus: scenario.planStatus });
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
  const json = (route, body) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body), headers: { "access-control-allow-origin": "*" } });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.href.startsWith(BACKEND)) {
      if (scenario.admin && url.pathname === "/rest/v1/rpc/is_super_admin") return json(route, true);
      return fake.backend(route);
    }
    if (url.href.startsWith(`${BASE}/api/`)) {
      if (url.pathname === "/api/billing/plan") {
        return fake.api({
          request: () => route.request(),
          fulfill: (r) => {
            const body = JSON.parse(r.body);
            return route.fulfill({ ...r, body: JSON.stringify({ ...body, gst_registered: false }) });
          },
        });
      }
      if (url.pathname === "/api/admin/billing") {
        const body = JSON.parse(route.request().postData() || "{}");
        if (body.action === "gst_settings")
          return json(route, { gst_registered: false, supplier_gstin: null, supplier_pan: null, demo_values: false, column_ready: true });
        if (body.action === "gst_invoices") return json(route, { invoices: GST_INVOICES });
        if (body.action === "overview") return json(route, { rows: [], totals: null });
        if (body.action === "topup_tasks") return json(route, { tasks: [] });
        if (body.action === "billing_templates") return json(route, { templates: [] });
        return json(route, {});
      }
      return fake.api(route);
    }
    if (url.href.startsWith(BASE) || url.href.startsWith("data:") || url.href.startsWith("blob:")) return route.continue();
    if (url.href.startsWith("https://fonts.googleapis.com") || url.href.startsWith("https://fonts.gstatic.com")) return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/fake-backend\.test/, (ws) => fake.realtime(ws));
  await context.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.connectToServer());
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error(`${name}/${vp}: ${err.message}`));
  await page.goto(`${BASE}${scenario.path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(scenario.wait, { timeout: 60_000 });
  if (scenario.click) await page.locator(scenario.click).first().click();
  if (scenario.after) await page.waitForSelector(scenario.after, { timeout: 30_000 });
  if (scenario.signedOut) {
    // The pricing cards fade in as they scroll into view.
    for (let y = 0; y < 6000; y += 400) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(120);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.waitForTimeout(scenario.settle ?? 1500);
  const file = join(OUT, `${name}-${vp}.png`);
  if (scenario.dialog) await page.locator("[role=dialog]").screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage: Boolean(scenario.fullPage) });
  console.log("wrote", file);
  await context.close();
}

const rest = await startRest();
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    for (const vp of Object.keys(VIEWPORTS)) await shoot(browser, name, scenario, vp);
  }
} finally {
  await browser.close();
  rest.close();
}
