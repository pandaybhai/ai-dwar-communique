import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";

/**
 * Batch 76 — the new-lead WhatsApp alert to the sales numbers. Fakes only: the
 * in-memory database and recording senders (free text and template). Nothing
 * reaches a live database, WhatsApp or Meta; no template is submitted.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  templates: [] as Array<{
    phone: string;
    variables: Record<string, string>;
    button: unknown;
    name: string;
  }>,
  texts: [] as Array<{ to: string; body: string }>,
}));
vi.mock("@/lib/whatsapp-webhook.server", () => ({ getServiceClient: () => h.db!.supabase }));
vi.mock("@/lib/billing-notify.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./billing-notify.server")>()),
  resolvePlatformOrg: async () => "org-platform",
}));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({ connection: { accessToken: "token" } }),
}));
vi.mock("@/lib/campaigns.server", () => ({
  loadSenderContext: async () => ({ fake: "sender" }),
  sendCampaignTemplate: async (
    _s: unknown,
    _org: string,
    _sender: unknown,
    recipient: { phone: string; variables: Record<string, string> },
    template: { name: string },
    ctx: { buttonParams?: Record<number, string> },
  ) => {
    h.templates.push({
      phone: recipient.phone,
      variables: recipient.variables,
      button: ctx.buttonParams?.[0],
      name: template.name,
    });
    return { messageId: "wamid.t", error: null };
  },
}));
vi.mock("@/lib/service-text.server", () => ({
  sendServiceText: async (_s: unknown, args: { to: string; body: string }) => {
    h.texts.push({ to: args.to, body: args.body });
    return { ok: true, messageId: "wamid.x" };
  },
}));

import {
  ALERT_WAIT_MS,
  LEAD_ALERT_BODY,
  alertPhone,
  alertText,
  alertVariables,
  runLeadAlerts,
} from "./lead-alerts.server";
import { isPlatformNoticeTemplate } from "./platform-notice-templates";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const MIN = 60 * 1000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const A = "+917981223192";
const B = "+919121883067";

function lead(id: string, over: Row = {}): Row {
  return {
    id,
    source: "landing_start",
    is_test: false,
    name: "Asha Rao",
    phone: "+919812345670",
    business_type: null,
    created_at: ago(1 * MIN),
    alerted_at: null,
    qualification: { sells: "jewellery", customers: "500_5000", answered_at: ago(30 * 1000) },
    ...over,
  };
}

function world(
  opts: { leads?: Row[]; template?: string | null; sentToday?: number; windowFor?: string[] } = {},
): MemoryDb {
  const contacts: Row[] = [];
  const conversations: Row[] = [];
  for (const n of opts.windowFor ?? []) {
    contacts.push({ id: `c-${n}`, organization_id: "org-platform", phone: n });
    conversations.push({
      id: `conv-${n}`,
      organization_id: "org-platform",
      contact_id: `c-${n}`,
      whatsapp_account_id: "acct-aidwar",
      last_message_at: ago(10 * MIN),
      last_customer_message_at: ago(10 * MIN),
    });
  }
  const db = memoryDb({
    demo_leads: opts.leads ?? [lead("lead-1")],
    platform_settings: [
      { id: 1, onboarding_whatsapp_account_id: "acct-aidwar", lead_alert_numbers: [A, B] },
    ],
    whatsapp_accounts: [
      {
        id: "acct-aidwar",
        organization_id: "org-platform",
        phone_number_id: "pn-1",
        messaging_tier: "TIER_250",
      },
    ],
    message_templates:
      opts.template === null
        ? []
        : [
            {
              organization_id: "org-platform",
              name: "aidwar_new_lead_alert",
              language: "en",
              status: opts.template ?? "APPROVED",
              components: [],
            },
          ],
    messages: Array.from({ length: opts.sentToday ?? 0 }, (_, i) => ({
      id: `m${i}`,
      organization_id: "org-platform",
      direction: "outbound",
      type: "template",
      created_at: ago(60 * MIN),
    })),
    contacts,
    conversations,
    profiles: [],
    activity_log: [],
  });
  h.db = { supabase: db.supabase };
  return db;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  h.templates = [];
  h.texts = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the new-lead alert", () => {
  it("goes once per number as soon as the questions are answered", async () => {
    const w = world();
    expect(await runLeadAlerts(w.supabase as never, { now: NOW })).toEqual({
      alerted: 1,
      skipped: null,
    });
    expect(h.templates.map((t) => t.phone)).toEqual([A, B]);
    expect(h.templates[0]).toMatchObject({
      name: "aidwar_new_lead_alert",
      variables: {
        "1": "Asha Rao",
        "2": "+91 98123 45670",
        "3": "Jewellery",
        "4": "500–5,000",
        "5": "Website /start",
      },
      button: "lead-1",
    });
    expect(w.rows("demo_leads")[0]!["alerted_at"]).toBe(new Date(NOW).toISOString());
    // Never twice.
    expect(await runLeadAlerts(w.supabase as never, { now: NOW + MIN })).toEqual({
      alerted: 0,
      skipped: null,
    });
    expect(h.templates).toHaveLength(2);
  });

  it("waits up to 3 minutes for the answers, then goes with dashes", async () => {
    const w = world({
      leads: [lead("lead-2", { name: null, qualification: {}, created_at: ago(1 * MIN) })],
    });
    expect(await runLeadAlerts(w.supabase as never, { now: NOW })).toEqual({
      alerted: 0,
      skipped: null,
    });
    expect(h.templates).toHaveLength(0);
    expect(ALERT_WAIT_MS).toBe(3 * MIN);
    expect(await runLeadAlerts(w.supabase as never, { now: NOW + 2 * MIN + 1000 })).toEqual({
      alerted: 1,
      skipped: null,
    });
    expect(h.templates[0]!.variables).toEqual({
      "1": "—",
      "2": "+91 98123 45670",
      "3": "—",
      "4": "—",
      "5": "Website /start",
    });
  });

  it("a /demo lead goes at once, with its business type as 'Sells'", async () => {
    const w = world({
      leads: [
        lead("demo-1", {
          source: "landing",
          business_type: "services",
          qualification: {},
          created_at: ago(10 * 1000),
        }),
      ],
    });
    await runLeadAlerts(w.supabase as never, { now: NOW });
    expect(h.templates[0]!.variables).toMatchObject({
      "3": "Services / appointments",
      "4": "—",
      "5": "Demo form",
    });
  });

  it("a number inside its 24-hour window gets a free text instead of the template", async () => {
    const w = world({ windowFor: [A] });
    await runLeadAlerts(w.supabase as never, { now: NOW });
    expect(h.texts).toEqual([
      {
        to: "917981223192",
        body: "You have a new lead on AiDwar.\nName: Asha Rao\nWhatsApp: +91 98123 45670\nSells: Jewellery\nCustomers: 500–5,000\nSource: Website /start\nPlease follow up with them today.\nOpen lead: https://aidwar.in/admin/leads?lead=lead-1",
      },
    ]);
    expect(h.templates.map((t) => t.phone)).toEqual([B]);
  });

  it("while the template isn't approved nothing partial goes; the lead waits and goes once it is", async () => {
    let w = world({ template: null, windowFor: [A] });
    expect(await runLeadAlerts(w.supabase as never, { now: NOW })).toEqual({
      alerted: 0,
      skipped: "template_missing",
    });
    expect(h.texts).toHaveLength(0);
    expect(h.templates).toHaveLength(0);
    expect(w.rows("demo_leads")[0]!["alerted_at"]).toBeNull();
    w = world({ template: "PENDING" });
    expect((await runLeadAlerts(w.supabase as never, { now: NOW })).skipped).toBe(
      "template_pending",
    );
    (w.rows("message_templates")[0] as Row)["status"] = "APPROVED";
    expect(await runLeadAlerts(w.supabase as never, { now: NOW + MIN })).toEqual({
      alerted: 1,
      skipped: null,
    });
    // Both numbers in the window: free texts go even without the template.
    w = world({ template: null, windowFor: [A, B] });
    expect(await runLeadAlerts(w.supabase as never, { now: NOW })).toEqual({
      alerted: 1,
      skipped: null,
    });
    expect(h.texts.map((t) => t.to)).toEqual(["917981223192", "919121883067"]);
  });

  it("respects the AiDwar number's daily limit (TIER_250)", async () => {
    const w = world({ sentToday: 249, leads: [lead("x"), lead("y", { phone: "+919123456780" })] });
    expect(await runLeadAlerts(w.supabase as never, { now: NOW })).toEqual({
      alerted: 0,
      skipped: "daily_limit",
    });
    expect(h.templates).toHaveLength(0);
    expect(w.rows("demo_leads").every((r) => r["alerted_at"] === null)).toBe(true);
  });

  it("no alert numbers, a test lead or an old lead: nothing", async () => {
    let w = world({
      leads: [lead("t", { is_test: true }), lead("old", { created_at: ago(25 * 60 * MIN) })],
    });
    expect(await runLeadAlerts(w.supabase as never, { now: NOW })).toEqual({
      alerted: 0,
      skipped: null,
    });
    w = world();
    (w.rows("platform_settings")[0] as Row)["lead_alert_numbers"] = [];
    expect(await runLeadAlerts(w.supabase as never, { now: NOW })).toEqual({
      alerted: 0,
      skipped: null,
    });
    expect(h.templates).toHaveLength(0);
  });

  it("honeypot and repeated submissions never create a second lead, so never a second alert", async () => {
    const w = world({ leads: [] });
    const { submitLead } = await import("./leads.server");
    const meta = { ip: "203.0.113.5", referrer: null };
    // Batch 78: step 3 sends the answers and business name with the number.
    const full = {
      source: "landing_start",
      name: "Asha Rao",
      business_name: "Asha Jewels",
      sells: "jewellery",
      customers: "500_5000",
    };
    await submitLead(
      w.supabase as never,
      { ...full, phone: "9812345670", company_website_confirm: "spam" } as never,
      meta,
    );
    expect(w.rows("demo_leads")).toHaveLength(0);
    await submitLead(w.supabase as never, { ...full, phone: "9812345670" } as never, meta);
    await submitLead(w.supabase as never, { ...full, phone: "+91 98123 45670" } as never, meta);
    await submitLead(w.supabase as never, { ...full, phone: "9999999999" } as never, meta);
    expect(w.rows("demo_leads")).toHaveLength(1);
    (w.rows("demo_leads")[0] as Row)["created_at"] = ago(4 * MIN);
    (w.rows("demo_leads")[0] as Row)["is_test"] = false;
    expect(await runLeadAlerts(w.supabase as never, { now: NOW })).toEqual({
      alerted: 1,
      skipped: null,
    });
    expect(h.templates).toHaveLength(2);
  });

  it("runs from the existing minute worker; the template is hidden from campaigns", () => {
    const worker = readFileSync("src/routes/api/internal/knowledge-worker.ts", "utf8");
    expect(worker).toContain('await import("@/lib/lead-alerts.server")');
    expect(worker).toContain("lead_alerts: leadAlerts");
    expect(isPlatformNoticeTemplate("aidwar_new_lead_alert")).toBe(true);
    expect(alertVariables(lead("z") as never)["5"]).toBe("Website /start");
    expect(alertText(lead("z") as never)).toContain("https://aidwar.in/admin/leads?lead=z");
  });

  it("matches the template already submitted in the Ai Dwar workspace, word for word", async () => {
    expect(LEAD_ALERT_BODY).toBe(
      "You have a new lead on AiDwar.\nName: {{1}}\nWhatsApp: {{2}}\nSells: {{3}}\nCustomers: {{4}}\nSource: {{5}}\nPlease follow up with them today.",
    );
    expect(alertPhone("+919812345670")).toBe("+91 98123 45670");
    expect(alertPhone("+14155550123")).toBe("+14155550123");
    // The button's {{1}} is the lead's own id (a uuid), as /admin/leads?lead= reads it.
    const id = "3f2c9a1e-5b7d-4c11-9a2e-7d1f0c4b8e21";
    world({ leads: [lead(id)] });
    await runLeadAlerts(h.db!.supabase as never, { now: NOW });
    expect(h.templates[0]).toMatchObject({ name: "aidwar_new_lead_alert", button: id });
    expect(alertText(lead(id) as never)).toContain(`https://aidwar.in/admin/leads?lead=${id}`);
    const page = readFileSync("src/routes/admin/leads.tsx", "utf8");
    expect(page).toContain("validateSearch");
    expect(page).toContain("setOpenId(linkedLead)");
  });
});
