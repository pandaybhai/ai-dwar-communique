/**
 * Batch 63: screenshots of a template's Sent report and the "Not on WhatsApp"
 * badge (Inbox chat header), Classic and Aiden Workspace, at 1440 and 390,
 * on the fake backend (fake-backend.mjs). Fictional data; nothing leaves the
 * machine but Google Fonts.
 *
 *   VITE_AIDWAR_SUPABASE_URL=http://fake-backend.test VITE_AIDWAR_SUPABASE_ANON_KEY=fake \
 *     npx vite dev --port 5199 --host 127.0.0.1
 *   node scripts/ui-shots/b63-shots.mjs --out docs/screenshots/batch63
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKEND, STORAGE_KEY, createBackend, makeConversations, session } from "./fake-backend.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://127.0.0.1:5199";
const OUT = args.out ?? "docs/screenshots/batch63";
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const DESIGNS = { classic: false, "aiden-workspace": true };

const ORG = "00000000-0000-4000-8000-0000000000a1";
const HOUR = 3600e3;
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ERR = JSON.stringify([{ code: 131026, title: "Message undeliverable" }]);
const ERR_CAP = JSON.stringify([{ code: 131049, title: "Healthy ecosystem engagement" }]);
const person = (name, phone) => ({ contact_id: `c-${phone}`, contacts: { id: `c-${phone}`, name, phone } });

/** The order_shipped template's sends (fictional), every source. */
function sends() {
  const rows = [];
  const add = (id, over) =>
    rows.push({
      id,
      organization_id: ORG,
      direction: "outbound",
      type: "template",
      template_name: "order_shipped",
      status: "delivered",
      error_detail: null,
      campaign_id: null,
      flow_id: null,
      sent_by: null,
      metadata: {},
      conversation_id: null,
      created_at: ago(HOUR),
      conversations: person("Asha Iyer", "+919820011111"),
      ...over,
    });
  add("s1", { created_at: ago(0.4 * HOUR), status: "read", metadata: { source: "api", idempotency_key: "INV-2041", document_filename: "INV-2041.pdf" } });
  add("s1c1", { created_at: ago(0.39 * HOUR), status: "delivered", metadata: { source: "api", copy: true, cc_of: "s1", to: "+918121310333" }, conversations: person(null, "+918121310333") });
  add("s1c2", { created_at: ago(0.38 * HOUR), status: "failed", error_detail: ERR, metadata: { source: "api", copy: true, cc_of: "s1", to: "+919121883067" }, conversations: person(null, "+919121883067") });
  add("s2", { created_at: ago(1.2 * HOUR), status: "failed", error_detail: ERR, metadata: { source: "api", idempotency_key: "INV-2040" }, conversations: person("Rohan Mehta", "+919820022222") });
  add("s3", { created_at: ago(3 * HOUR), status: "delivered", campaign_id: "camp-1", conversations: person("Priya Nair", "+919820033333") });
  add("s4", { created_at: ago(5 * HOUR), status: "failed", error_detail: ERR_CAP, campaign_id: "camp-1", conversations: person("Farhan Khan", "+919820044444") });
  add("s5", { created_at: ago(7 * HOUR), status: "read", flow_id: "f-order", metadata: { kind: "flow_v2", run_id: "r1" }, conversations: person("Kavya Rao", "+919820055555") });
  add("s6", { created_at: ago(26 * HOUR), status: "sent", sent_by: "me", conversations: person("Meera Shah", "+919820066666") });
  add("s7", { created_at: ago(30 * HOUR), status: "read", metadata: { source: "api", idempotency_key: "INV-2031" }, conversations: person("Ishaan Gupta", "+919820077777") });
  return rows;
}

/** PostgREST-ish filtering for the Sent report's reads (eq, is, not.is, in on metadata->>cc_of, or on source). */
function filterSends(url) {
  const p = url.searchParams;
  let rows = sends();
  for (const [k, v] of p) {
    if (["select", "order", "limit", "offset"].includes(k)) continue;
    const get = (r) => (k.startsWith("metadata->>") ? r.metadata?.[k.slice(11)] ?? null : r[k]);
    if (k === "or") {
      if (v.includes("metadata->>source.eq.api")) rows = rows.filter((r) => r.metadata?.source === "api");
      else if (v.includes("flow_id.not.is.null")) rows = rows.filter((r) => r.flow_id || r.metadata?.kind === "flow_v2");
      continue;
    }
    if (v === "is.null") rows = rows.filter((r) => get(r) == null);
    else if (v === "not.is.null") rows = rows.filter((r) => get(r) != null);
    else if (v.startsWith("eq.")) rows = rows.filter((r) => String(get(r)) === v.slice(3));
    else if (v.startsWith("in.")) {
      const list = v.slice(3).replace(/[()"]/g, "").split(",");
      rows = rows.filter((r) => list.includes(String(get(r))));
    } else if (v.startsWith("gte.")) rows = rows.filter((r) => r.created_at >= v.slice(4));
    else if (v.startsWith("lt.")) rows = rows.filter((r) => r.created_at < v.slice(3));
  }
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

async function shoot(browser, design, vp, what) {
  const newDesign = DESIGNS[design];
  const fake = createBackend({ conversations: 6, newDesign });
  const firstContact = makeConversations(6)[0].contact.id;
  const context = await browser.newContext({ viewport: VIEWPORTS[vp], deviceScaleFactor: 2, colorScheme: "light" });
  await context.addInitScript(
    ([key, value]) => {
      localStorage.setItem(key, value);
      localStorage.setItem("aidwar.active_org", "00000000-0000-4000-8000-0000000000a1");
      localStorage.setItem("aidwar.theme", "light");
      sessionStorage.setItem("aidwar.journey.exited.00000000-0000-4000-8000-0000000000a1", "1");
    },
    [STORAGE_KEY, JSON.stringify(session())],
  );
  const json = (route, body, headers = {}) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
      headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", ...headers },
    });
  await context.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const href = url.href;
    if (href.startsWith(BACKEND)) {
      const select = url.searchParams.get("select") ?? "";
      if (url.pathname === "/rest/v1/messages" && url.searchParams.get("template_name")) {
        const rows = filterSends(url);
        if (req.method() === "HEAD") return json(route, null, { "content-range": `*/${rows.length}` });
        return json(route, rows.slice(0, 51));
      }
      if (url.pathname === "/rest/v1/messages" && url.searchParams.get("metadata->>cc_of")) return json(route, filterSends(url));
      if (url.pathname === "/rest/v1/messages" && req.method() === "HEAD" && url.searchParams.get("type") === "eq.template") {
        // Home's "Needs attention": 3 failed in 24 h, 2 to numbers not on WhatsApp.
        return json(route, null, { "content-range": `*/${url.searchParams.get("or") ? 2 : 3}` });
      }
      if (url.pathname === "/rest/v1/campaigns" && select === "id,name") return json(route, [{ id: "camp-1", name: "Dhanteras reminder" }]);
      if (url.pathname === "/rest/v1/contacts" && select === "wa_unreachable") {
        const id = (url.searchParams.get("id") ?? "").replace(/^eq\./, "");
        const mark =
          id === firstContact
            ? { since: ago(30 * HOUR), last_at: ago(1.2 * HOUR), code: "131026", reason: "Not on WhatsApp (or can't receive messages) (131026)", template: "order_shipped", message_id: "s2", failures: 6 }
            : null;
        return json(route, { wa_unreachable: mark }, { "content-type": "application/vnd.pgrst.object+json" });
      }
      if (url.pathname === "/rest/v1/organizations" && select === "branding") return json(route, { branding: {} });
      return fake.backend(route);
    }
    if (href.startsWith(`${BASE}/api/`)) return fake.api(route);
    if (href.startsWith(BASE) || href.startsWith("data:") || href.startsWith("blob:")) return route.continue();
    if (href.startsWith("https://fonts.googleapis.com") || href.startsWith("https://fonts.gstatic.com")) return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/fake-backend\.test/, (ws) => fake.realtime(ws));
  await context.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.connectToServer());
  const page = await context.newPage();
  page.on("pageerror", (err) => console.error(`${design}/${vp}/${what}: ${err.message}`));

  if (what === "sent") {
    await page.goto(`${BASE}/app/templates`, { waitUntil: "networkidle" });
    await page.locator("button:has-text('Sent')").first().click();
    await page.waitForSelector("[data-testid=sent-line]", { timeout: 30000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: join(OUT, `sent-report-${design}-${vp}.png`) });
  } else if (what === "badge") {
    await page.goto(`${BASE}/app/inbox`, { waitUntil: "networkidle" });
    await page.getByText("Asha Iyer").first().click().catch(() => undefined);
    await page.waitForSelector("[data-testid=not-on-whatsapp]", { timeout: 30000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, `contact-badge-${design}-${vp}.png`) });
  } else if (what === "home") {
    await page.goto(`${BASE}/app`, { waitUntil: "networkidle" });
    await page.waitForSelector("[data-testid=needs-attention-failed-sends]", { timeout: 30000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(OUT, `home-needs-attention-${design}-${vp}.png`) });
  }
  console.log("wrote", design, vp, what);
  await context.close();
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  for (const what of (args.only ?? "sent,badge,home").split(","))
    for (const design of Object.keys(DESIGNS))
      for (const vp of Object.keys(VIEWPORTS)) {
        if (what === "home" && vp === "mobile") continue;
        await shoot(browser, design, vp, what).catch((e) => console.error("FAILED", design, vp, what, e.message));
      }
} finally {
  await browser.close();
}
