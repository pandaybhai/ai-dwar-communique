/**
 * Screenshots of the app with fake data (Batch 39).
 *
 *   VITE_AIDWAR_SUPABASE_URL=http://fake-backend.test VITE_AIDWAR_SUPABASE_ANON_KEY=fake \
 *     npx vite dev --port 5199 --host 127.0.0.1
 *   node scripts/ui-shots/shoot.mjs --out docs/screenshots/batch39/before [--themes light,dark] [--only inbox-chat] [--set b39|b41|b44|b45|b46|b47|b48] [--design classic|new]
 *
 * Uses the Chromium + Playwright installed on the machine (not a project
 * dependency). The dev server must point the app at the fake backend host:
 * every request to it, and to the app's own /api/*, is answered by
 * fake-backend.mjs; any other request leaving the page is blocked.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKEND, HAND_PICKED, STORAGE_KEY, createBackend, session } from "./fake-backend.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.base ?? "http://127.0.0.1:5199";
const OUT = args.out ?? "docs/screenshots/batch39/after";
const THEMES = (args.themes ?? "light").split(",");
const ONLY = args.only ? args.only.split(",") : null;
/** Batch 44: "new" turns the workspace's new_design flag on. */
const DESIGN = args.design ?? "classic";

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
};

const firstId = createBackend({ conversations: 1 }).conversations[0].id;

/** name → { path, conversations, prepare(page) } */
const SCENARIOS = {
  shell: { path: "/app", conversations: 40, wait: "h1" },
  "inbox-list": { path: "/app/inbox", conversations: 40 },
  "inbox-chat": { path: `/app/inbox?c=${firstId}`, conversations: 40, wait: "text=Meenakari" },
  "inbox-empty": { path: "/app/inbox", conversations: 0 },
  "inbox-needs-human": { path: `/app/inbox?c=${firstId}`, conversations: 40, wait: "text=Waiting for you.", crop: "[data-shot=needs-human], div.bg-amber-50" },
  design: { path: "/app/design", conversations: 40, fullPage: true },
  palette: {
    path: "/app",
    conversations: 40,
    wait: "h1",
    act: async (page) => {
      await page.keyboard.press("Control+k");
      await page.keyboard.type("as", { delay: 40 });
      await page.waitForTimeout(700);
    },
  },
  shortcuts: { path: "/app", conversations: 40, wait: "h1", act: async (page) => page.keyboard.press("Shift+?") },
};

const firstCampaign = "00000000-0000-4000-8000-000000007000";

/** The campaign wizard, walked to a step (Batch 41: audience → … → review). */
function wizardTo(target, open = /create campaign/i) {
  return {
    path: "/app/campaigns",
    conversations: 40,
    wait: "text=Diwali preview",
    act: async (page) => {
      await page.getByRole("button", { name: open }).first().click();
      await page.waitForTimeout(700);
      await page.getByLabel("Campaign name").fill("Diwali preview — VIP list");
      await page.waitForTimeout(900);
      if (target < 1) return;
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(500);
      await page.getByRole("dialog").getByText("order_shipped", { exact: true }).click();
      await page.waitForTimeout(500);
      if (target < 2) return;
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(500);
      for (const n of [1, 2]) {
        await page.getByRole("combobox", { name: `Source for {{${n}}}` }).click();
        await page.getByRole("option").first().click();
        await page.waitForTimeout(200);
      }
      if (target < 3) return;
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: /^continue/i }).click();
      await page.waitForTimeout(600);
    },
  };
}

/** Batch 41: Home, Campaigns, Templates. */
const SCENARIOS_B41 = {
  home: { path: "/app", conversations: 40, wait: "text=Waiting on you", fullPage: true },
  "home-journey": { path: "/app", conversations: 40, journey: true, wait: "text=Continue setup" },
  "home-low-credits": { path: "/app", conversations: 40, lowCredits: true, wait: "text=Waiting on you", fullPage: true },
  campaigns: { path: "/app/campaigns", conversations: 40, wait: "text=Diwali preview" },
  "campaigns-empty": { path: "/app/campaigns", conversations: 40, campaigns: 0, wait: "h1" },
  "campaign-detail": { path: `/app/campaigns/${firstCampaign}`, conversations: 40, wait: "text=Offer performance", fullPage: true },
  "campaign-wizard": { ...wizardTo(0) },
  "campaign-wizard-message": { ...wizardTo(1) },
  "campaign-wizard-personalise": { ...wizardTo(2) },
  "campaign-wizard-review": { ...wizardTo(4) },
  templates: { path: "/app/templates", conversations: 40, wait: "text=order_shipped" },
  "templates-empty": { path: "/app/templates", conversations: 40, templates: 0, wait: "h1" },
  "template-create": {
    fullPage: false,
    path: "/app/templates",
    conversations: 40,
    wait: "text=order_shipped",
    act: async (page) => {
      await page.getByRole("button", { name: /create template/i }).first().click();
      await page.waitForTimeout(900);
    },
  },
};

/** Batch 44: the new shell and every page inside it (run with --design new and --design classic). */
const openAccount = async (page) => {
  await page.getByRole("button", { name: /^Account:|account menu$/ }).click();
  await page.waitForTimeout(500);
};
const SCENARIOS_B44 = {
  shell: { path: "/app", conversations: 40, wait: "h1" },
  "avatar-menu": { path: "/app", conversations: 40, wait: "h1", act: openAccount },
  "more-sheet": {
    path: "/app",
    conversations: 40,
    wait: "h1",
    mobileOnly: true,
    act: async (page) => {
      await page.getByRole("button", { name: "More" }).click();
      await page.waitForTimeout(600);
    },
  },
  palette: SCENARIOS.palette,
  design: { path: "/app/design", conversations: 40, wait: "h1", fullPage: true },
  inbox: { path: "/app/inbox", conversations: 40 },
  "inbox-chat": SCENARIOS["inbox-chat"],
  campaigns: { path: "/app/campaigns", conversations: 40, wait: "h1" },
  "campaign-detail": { path: `/app/campaigns/${firstCampaign}`, conversations: 40, wait: "h1" },
  templates: { path: "/app/templates", conversations: 40, wait: "h1" },
  cards: { path: "/app/cards", conversations: 40, wait: "h1" },
  contacts: { path: "/app/contacts", conversations: 40, wait: "h1" },
  segments: { path: "/app/contacts?tab=segments", conversations: 40, wait: "h1" },
  receipts: { path: "/app/receipts", conversations: 40, wait: "h1" },
  employee: { path: "/app/employee", conversations: 40, wait: "h1" },
  flows: { path: "/app/flows", conversations: 40, wait: "h1" },
  automations: { path: "/app/automations", conversations: 40, wait: "h1" },
  catalog: { path: "/app/catalog", conversations: 40, wait: "h1" },
  collections: { path: "/app/catalog/collections", conversations: 40, wait: "h1" },
  analytics: { path: "/app/analytics", conversations: 40, wait: "h1" },
  settings: { path: "/app/settings", conversations: 40, wait: "h1" },
  team: { path: "/app/settings?tab=team", conversations: 40, wait: "h1" },
  billing: { path: "/app/billing", conversations: 40, wait: "h1" },
};

/** Batch 45: the new Home in each of Aiden's modes (run with --design new; classic = Batch 41's Home). */
const SCENARIOS_B45 = {
  "home-replying": { path: "/app", conversations: 40, aidenMode: "replying", wait: "text=Aiden is replying", settle: 4500 },
  "home-draft": { path: "/app", conversations: 40, aidenMode: "draft", wait: "text=ready for you", settle: 3000 },
  "home-off": { path: "/app", conversations: 40, aidenMode: "off", wait: "text=customers are waiting", settle: 3000 },
  "home-classic": { path: "/app", conversations: 40, wait: "h1", fullPage: true },
};

/** Batch 46: the new Inbox (run with --design new; --design classic shows flag off is unchanged). */
const chatAt = (i) => `00000000-0000-4000-8000-${String(1000 + i).padStart(12, "0")}`;
const SCENARIOS_B46 = {
  "inbox-list": { path: "/app/inbox", conversations: 40, wait: "text=Asha Iyer" },
  "inbox-chat": { path: `/app/inbox?c=${chatAt(8)}`, conversations: 40, wait: "text=Meenakari" },
  "inbox-needs-human": {
    path: `/app/inbox?c=${firstId}`,
    conversations: 40,
    wait: "text=Meenakari",
    act: async (page) => {
      const draft = page.getByRole("button", { name: "Draft a reply" });
      if (await draft.count()) {
        await draft.first().click();
        await page.waitForTimeout(600);
      }
    },
  },
  "inbox-taken-over": { path: `/app/inbox?c=${chatAt(1)}`, conversations: 40, wait: "text=Meenakari" },
  "inbox-window-closed": { path: `/app/inbox?c=${chatAt(3)}`, conversations: 40, wait: "text=Meenakari" },
  "inbox-empty": { path: "/app/inbox", conversations: 0, wait: "h1" },
  "inbox-back": {
    path: `/app/inbox?c=${firstId}`,
    conversations: 40,
    wait: "text=Meenakari",
    mobileOnly: true,
    act: async (page) => {
      await page.getByRole("button", { name: "Back to chats" }).click();
      await page.waitForTimeout(500);
    },
  },
};

/** Batch 47: Campaigns, Templates and Cards in the new design (run with --design new). */
const dhanteras = "00000000-0000-4000-8000-000000007005";
const SCENARIOS_B47 = {
  campaigns: { path: "/app/campaigns", conversations: 40, wait: "text=Diwali preview", settle: 4000 },
  "campaign-results": { path: `/app/campaigns/${dhanteras}`, conversations: 40, wait: "text=Sales from this campaign", settle: 4000 },
  "campaign-results-full": { path: `/app/campaigns/${dhanteras}`, conversations: 40, wait: "text=Sales from this campaign", settle: 2500, fullPage: true },
  "campaign-sending": { path: `/app/campaigns/${firstCampaign}`, conversations: 40, wait: "text=Took code", settle: 2500 },
  "campaign-wizard": { ...wizardTo(0, /new campaign/i), settle: 1200 },
  "campaign-wizard-message": { ...wizardTo(1, /new campaign/i), settle: 1200 },
  "campaign-wizard-personalise": { ...wizardTo(2, /new campaign/i), settle: 1200 },
  "campaign-wizard-review": { ...wizardTo(4, /new campaign/i), settle: 1200 },
  templates: { path: "/app/templates", conversations: 40, wait: "text=order_shipped", settle: 1200 },
  "template-editor": {
    path: "/app/templates",
    conversations: 40,
    wait: "text=order_shipped",
    act: async (page) => {
      await page.getByRole("button", { name: /new template/i }).first().click();
      await page.waitForTimeout(900);
    },
  },
  "template-editor-invoice": {
    path: "/app/templates",
    conversations: 40,
    wait: "text=order_shipped",
    act: async (page) => {
      await page.getByRole("button", { name: /new template/i }).first().click();
      await page.waitForTimeout(700);
      await page.getByRole("dialog").getByText("Invoice or receipt with a PDF").click();
      await page.waitForTimeout(700);
    },
  },
  cards: { path: "/app/cards", conversations: 40, wait: "h1", settle: 1200, fullPage: true },
};

/** Batch 50: Settings (each section), Billing in each plan state (run with --design new and classic). */
const settingsAt = (tab, wait = "h1") => ({ path: `/app/settings${tab ? `?tab=${tab}` : ""}`, conversations: 10, wait, settle: 1200 });
const SCENARIOS_B50 = {
  settings: settingsAt(""),
  "settings-team": settingsAt("team"),
  "settings-whatsapp": settingsAt("whatsapp", "text=WhatsApp profile"),
  "settings-api": settingsAt("api"),
  "settings-notifications": settingsAt("notifications"),
  "settings-sending": settingsAt("sending"),
  "settings-danger": settingsAt("danger"),
  "settings-palette": {
    path: "/app/settings",
    conversations: 10,
    wait: "h1",
    act: async (page) => {
      await page.keyboard.press("Control+k");
      await page.keyboard.type("profile", { delay: 40 });
      await page.waitForTimeout(700);
    },
  },
  billing: { path: "/app/billing", conversations: 10, richBilling: true, wait: "text=Credits available", settle: 6000, fullPage: true },
  "billing-low": { path: "/app/billing", conversations: 10, richBilling: true, lowCredits: true, wait: "text=Credits available", settle: 6000 },
  "billing-trial": { path: "/app/billing", conversations: 10, richBilling: true, plan: "trial", wait: "text=Choose your plan", settle: 6000, fullPage: true },
  "billing-locked": { path: "/app/billing", conversations: 10, richBilling: true, plan: "locked", wait: "text=Reactivate", settle: 6000 },
  "billing-past-due": { path: "/app/billing", conversations: 10, richBilling: true, plan: "past_due", wait: "text=Credits available", settle: 6000 },
  start: { path: "/app/start?step=connect", conversations: 10, journeyFull: true, wait: "h1", settle: 1500 },
};

/** Batch 48: Customers (run with --design new; --design classic shows flag off is unchanged). */
const firstContactRow = async (page) => {
  await page.getByRole("button", { name: /Asha Iyer/ }).first().click();
  await page.waitForTimeout(1200);
};
const SCENARIOS_B48 = {
  contacts: { path: "/app/contacts", conversations: 40, customers: true, wait: "text=Asha Iyer" },
  "contacts-filtered": { path: "/app/contacts?opt_in=unknown", conversations: 40, customers: true, wait: "h1" },
  "contacts-selected": {
    path: "/app/contacts",
    conversations: 40,
    customers: true,
    wait: "text=Asha Iyer",
    act: async (page) => {
      for (const name of ["Select Asha Iyer", "Select Vikram Mehta", "Select Meera Nair"]) {
        await page.getByRole("checkbox", { name }).filter({ visible: true }).first().click();
      }
      await page.waitForTimeout(600);
    },
  },
  "contact-drawer": { path: "/app/contacts", conversations: 40, customers: true, wait: "text=Asha Iyer", act: firstContactRow },
  "contacts-empty": { path: "/app/contacts", conversations: 0, customers: true, wait: "h1" },
  "import-upload": {
    path: "/app/contacts",
    conversations: 40,
    customers: true,
    wait: "text=Asha Iyer",
    act: async (page) => {
      await page.getByRole("button", { name: /^Import/ }).first().click();
      await page.waitForTimeout(700);
    },
  },
  "import-map": { path: "/app/contacts", conversations: 40, customers: true, wait: "text=Asha Iyer", act: (page) => importTo(page, 2) },
  "import-confirm": { path: "/app/contacts", conversations: 40, customers: true, wait: "text=Asha Iyer", act: (page) => importTo(page, 3) },
  segments: { path: "/app/contacts?tab=segments", conversations: 40, customers: true, wait: "text=VIP customers" },
  receipts: { path: "/app/receipts", conversations: 40, customers: true, wait: "h1", fullPage: true },
};

const SAMPLE_IMPORT = "phone,name,tags,city\n+919876543210,Priya Sharma,\"vip,repeat-buyer\",Hyderabad\n+919812345678,Rahul Verma,new-customer,Mumbai\n+919898765432,Anjali Patel,vip,Delhi\n";
async function importTo(page, step) {
  await page.getByRole("button", { name: /^Import/ }).first().click();
  await page.waitForTimeout(600);
  await page.locator('input[type="file"]').setInputFiles({ name: "kesar-customers.csv", mimeType: "text/csv", buffer: Buffer.from(SAMPLE_IMPORT) });
  await page.waitForTimeout(700);
  if (step >= 3) {
    await page.getByRole("button", { name: /^Continue/ }).click();
    await page.waitForTimeout(600);
  }
}

/** Batch 51: the gaps closed (run with --design new; landing scenarios use ?site=new). */
const SCENARIOS_B51 = {
  "home-needs-you": { path: "/app", conversations: 40, aidenMode: "replying", wait: "text=Aiden is replying", settle: 4500 },
  "home-approve": {
    path: "/app",
    conversations: 40,
    aidenMode: "replying",
    wait: "text=Aiden is replying",
    settle: 1200,
    act: async (page) => {
      await page.waitForTimeout(3500);
      await page.getByRole("button", { name: "Approve" }).first().click();
      await page.waitForTimeout(500);
      await page.keyboard.type("Yes Asha, ₹2,000 off on both sets today. I've noted it on your order.", { delay: 8 });
    },
  },
  "inbox-decision": { path: `/app/inbox?c=${firstId}`, conversations: 40, wait: "text=Meenakari", settle: 1500 },
  "inbox-decline": {
    path: `/app/inbox?c=${firstId}`,
    conversations: 40,
    wait: "text=Meenakari",
    act: async (page) => {
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "Decline" }).filter({ visible: true }).first().click();
      await page.waitForTimeout(500);
      await page.keyboard.type("Sorry Asha, we can't take ₹2,000 off this week, but delivery by Friday is free.", { delay: 8 });
    },
  },
  "template-menu": {
    path: "/app/templates",
    conversations: 40,
    wait: "text=order_shipped",
    settle: 600,
    act: async (page) => {
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "More for diwali_preview" }).first().click();
      await page.waitForTimeout(400);
    },
  },
  "template-delete": {
    path: "/app/templates",
    conversations: 40,
    wait: "text=order_shipped",
    act: async (page) => {
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "More for diwali_preview" }).first().click();
      await page.getByRole("menuitem", { name: "Delete template" }).click();
      await page.waitForTimeout(500);
    },
  },
  "template-delete-blocked": {
    path: "/app/templates",
    conversations: 40,
    wait: "text=order_shipped",
    act: async (page) => {
      await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "More for order_shipped" }).first().click();
      await page.getByRole("menuitem", { name: "Delete template" }).click();
      await page.waitForTimeout(400);
      await page.getByRole("button", { name: "Delete template" }).click();
      await page.waitForTimeout(700);
    },
  },
  "contacts-send-campaign": { ...SCENARIOS_B48["contacts-selected"] },
  "campaign-hand-picked": { path: `/app/campaigns?segment=${HAND_PICKED}`, conversations: 40, wait: "text=Diwali preview", settle: 1800 },
  "contact-notes": {
    path: "/app/contacts",
    conversations: 40,
    customers: true,
    wait: "text=Asha Iyer",
    act: async (page) => {
      await firstContactRow(page);
      await page.waitForSelector('h3:text-is("Notes")', { timeout: 5000 }).catch(() => {});
      await page.evaluate(() => {
        const h = [...document.querySelectorAll("h3")].find((el) => el.textContent === "Notes");
        h?.closest("section")?.scrollIntoView({ block: "start" });
      });
      await page.waitForTimeout(500);
    },
  },
  "landing-proof": { path: "/?site=new#proof", conversations: 0, wait: "#proof", settle: 2500, crop: "#proof" },
  "landing-proof-classic": { path: "/#proof", conversations: 0, wait: "#proof", settle: 2500, crop: "#proof" },
};

/**
 * Batch 57: every Aiden Workspace screen in one set (run with --design new for
 * the polish pass, --design classic to prove Classic did not move).
 */
const AI_ASSISTANTS = {
  mcpOn: true,
  supportLocked: false,
  canManage: true,
  seesEveryone: true,
  apps: [
    { userId: "00000000-0000-4000-8000-0000000000b1", member: "You", mine: true, clientId: "c-claude", name: "Claude", site: "claude.ai", grantedAt: "2026-10-28T09:12:00Z", lastUsedAt: "2026-10-30T05:40:00Z" },
  ],
  timeline: [
    { id: "e1", action: "mcp_campaign_drafted", at: "2026-10-30T05:38:00Z", userId: "00000000-0000-4000-8000-0000000000b1", member: "You", app: "Claude", appId: "c-claude", name: "Diwali for VIPs", link: "/app/campaigns/k1" },
  ],
  usage: { callsThisMinute: 4, callsPerMinute: 60, sendsThisHour: 1, sendsPerHour: 5 },
};
const SCENARIOS_B57 = {
  "home-replying": SCENARIOS_B45["home-replying"],
  "home-draft": SCENARIOS_B45["home-draft"],
  "home-off": SCENARIOS_B45["home-off"],
  "home-empty": { path: "/app", conversations: 0, aidenMode: "replying", wait: "h1", settle: 3000 },
  "home-new": { path: "/app", conversations: 0, journey: true, aidenMode: "off", wait: "h1", settle: 3000 },
  "inbox-list": SCENARIOS_B46["inbox-list"],
  "inbox-chat": { ...SCENARIOS_B46["inbox-chat"], settle: 1500 },
  "inbox-empty": SCENARIOS_B46["inbox-empty"],
  campaigns: SCENARIOS_B47.campaigns,
  "campaigns-empty": { path: "/app/campaigns", conversations: 40, campaigns: 0, wait: "h1", settle: 1500 },
  "campaign-results": SCENARIOS_B47["campaign-results"],
  "campaign-wizard-review": SCENARIOS_B47["campaign-wizard-review"],
  templates: SCENARIOS_B47.templates,
  cards: { ...SCENARIOS_B47.cards, fullPage: false },
  contacts: SCENARIOS_B48.contacts,
  "contacts-empty": SCENARIOS_B48["contacts-empty"],
  "contact-drawer": SCENARIOS_B48["contact-drawer"],
  segments: SCENARIOS_B48.segments,
  receipts: { ...SCENARIOS_B48.receipts, fullPage: false },
  employee: { path: "/app/employee", conversations: 40, wait: "h1", settle: 2000 },
  flows: { path: "/app/flows", conversations: 40, wait: "h1", settle: 1500 },
  automations: { path: "/app/automations", conversations: 40, wait: "h1", settle: 1500 },
  catalog: { path: "/app/catalog", conversations: 40, wait: "h1", settle: 1500 },
  collections: { path: "/app/catalog/collections", conversations: 40, wait: "h1", settle: 1500 },
  settings: SCENARIOS_B50.settings,
  billing: { ...SCENARIOS_B50.billing, fullPage: false },
  "ai-assistants": { path: "/app/ai-assistants", conversations: 10, wait: "h1", settle: 1500, aiAssistants: true },
  "avatar-menu": SCENARIOS_B44["avatar-menu"],
  "more-sheet": SCENARIOS_B44["more-sheet"],
  palette: SCENARIOS.palette,
};

const SETS = { b57: SCENARIOS_B57, b39: SCENARIOS, b41: SCENARIOS_B41, b44: SCENARIOS_B44, b45: SCENARIOS_B45, b46: SCENARIOS_B46, b47: SCENARIOS_B47, b48: SCENARIOS_B48, b50: SCENARIOS_B50, b51: SCENARIOS_B51 };

const consoleErrors = [];

async function shoot(browser, name, scenario, viewportName, theme) {
  const fake = createBackend({
    conversations: scenario.conversations,
    campaigns: scenario.campaigns,
    templates: scenario.templates,
    lowCredits: scenario.lowCredits,
    journey: scenario.journey,
    newDesign: DESIGN === "new",
    aidenMode: scenario.aidenMode,
    planStatus: scenario.plan,
    richBilling: scenario.richBilling,
    journeyFull: scenario.journeyFull,
    customers: scenario.customers,
  });
  const context = await browser.newContext({
    viewport: VIEWPORTS[viewportName],
    deviceScaleFactor: viewportName === "mobile" ? 2 : 1,
    colorScheme: theme,
  });
  await context.addInitScript(
    ([key, value, theme]) => {
      localStorage.setItem(key, value);
      localStorage.setItem("aidwar.active_org", "00000000-0000-4000-8000-0000000000a1");
      localStorage.setItem("aidwar.theme", theme);
      // Batch 40's "Save & exit": Home shows the Continue setup card instead of redirecting.
      sessionStorage.setItem("aidwar.journey.exited.00000000-0000-4000-8000-0000000000a1", "1");
    },
    [STORAGE_KEY, JSON.stringify(session()), theme],
  );
  // Only the dev server and the fake backend; nothing else leaves the page.
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BACKEND)) return fake.backend(route);
    if (scenario.aiAssistants && url.startsWith(`${BASE}/api/ai-assistants`))
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(AI_ASSISTANTS) });
    if (url.startsWith(`${BASE}/api/`)) return fake.api(route);
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:")) return route.continue();
    if (url.startsWith("https://fonts.googleapis.com") || url.startsWith("https://fonts.gstatic.com")) return route.continue();
    return route.abort();
  });
  await context.routeWebSocket(/fake-backend\.test/, (ws) => fake.realtime(ws));
  await context.routeWebSocket(/127\.0\.0\.1/, (ws) => ws.connectToServer());

  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(`${name}/${viewportName}/${theme}: ${msg.text()}`);
  });
  page.on("pageerror", (err) => consoleErrors.push(`${name}/${viewportName}/${theme}: ${err.message}`));
  await page.goto(`${BASE}${scenario.path}`, { waitUntil: "networkidle" });
  if (scenario.wait) await page.waitForSelector(scenario.wait, { timeout: 15000 }).catch(() => {});
  if (scenario.act) await scenario.act(page);
  await page.waitForTimeout(scenario.settle ?? 800);
  if (scenario.fullPage) {
    // The app's work area scrolls, not the window: grow the window to fit it.
    const extra = await page.evaluate(() => {
      const main = document.querySelector("main");
      return main ? Math.max(0, main.scrollHeight - main.clientHeight) : 0;
    });
    if (extra > 0) {
      const vp = VIEWPORTS[viewportName];
      await page.setViewportSize({ width: vp.width, height: vp.height + extra });
      await page.waitForTimeout(400);
    }
  }
  const file = join(OUT, `${name}-${viewportName}${theme === "dark" ? "-dark" : ""}.png`);
  if (scenario.crop) {
    const el = await page.$(scenario.crop);
    if (el) await el.screenshot({ path: file });
    else await page.screenshot({ path: file });
  } else {
    await page.screenshot({ path: file, fullPage: Boolean(scenario.fullPage) });
  }
  console.log("wrote", file);
  await context.close();
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
for (const [name, scenario] of Object.entries(SETS[args.set ?? "b39"])) {
  if (ONLY && !ONLY.includes(name)) continue;
  for (const vp of Object.keys(VIEWPORTS)) {
    if (scenario.mobileOnly && vp !== "mobile") continue;
    for (const theme of THEMES) await shoot(browser, name, scenario, vp, theme);
  }
}
await browser.close();
if (consoleErrors.length) {
  console.log(`\n${consoleErrors.length} console error(s):`);
  for (const e of [...new Set(consoleErrors)]) console.log("  ", e);
}
