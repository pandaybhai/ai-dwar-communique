import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "./test-support/fake-db";

/**
 * Batch 21 item 3 — staff hand-off alerts outside WhatsApp's 24-hour window:
 * free text inside it (as before), the approved staff_handoff_alert UTILITY
 * template outside it, email only when neither reached anyone.
 */

const sent: Array<{ org: string; phone: string; variables: Record<string, string>; template: Record<string, unknown>; context: unknown }> = [];
vi.mock("@/lib/campaigns.server", () => ({
  loadSenderContext: async () => ({ accountId: "acc-platform", wabaId: "w", phoneNumberId: "pn", accessToken: "t" }),
  sendCampaignTemplate: async (_db: unknown, org: string, _sender: unknown, rcpt: { phone: string; variables: Record<string, string> }, template: Record<string, unknown>, context: unknown) => {
    sent.push({ org, phone: rcpt.phone, variables: rcpt.variables, template, context });
    return { messageId: "wamid.t1", error: null };
  },
}));
vi.mock("@/lib/billing-notify.server", () => ({ resolvePlatformOrg: async () => "platform-org" }));

afterEach(() => {
  sent.length = 0;
});

const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
const OWN = "+91 98000 00098";

function world(opts: { phones?: string[]; email?: string | null; template?: { status: string } | null; customer?: Record<string, unknown> }) {
  return fakeDb((op) => {
    if (op.table === "organization_ai_settings")
      return { data: { handoff_alert_phones: opts.phones ?? [], handoff_alert_email: opts.email ?? null, handoff_alert_hours: null }, error: null };
    if (op.table === "whatsapp_accounts") return { data: [{ display_phone_number: OWN }], error: null };
    if (op.table === "organizations") return { data: { name: "Zoori", timezone: "Asia/Kolkata" }, error: null };
    if (op.table === "organization_members") return { data: [{ user_id: "u1" }], error: null };
    if (op.table === "profiles") return { data: { phone: "+919800000098" }, error: null };
    if (op.table === "platform_settings") return { data: { onboarding_whatsapp_account_id: "acc-platform" }, error: null };
    if (op.table === "message_templates")
      return { data: opts.template ? [{ name: "staff_handoff_alert", language: "en", components: null, ...opts.template }] : [], error: null };
    if (op.table === "conversations" && op.kind === "select")
      return { data: { contacts: opts.customer ?? { name: "Asha", phone: "+919800000001" } }, error: null };
    return undefined;
  });
}

describe("the template definition (for Vinay to submit)", () => {
  it("UTILITY-shaped body: four variables in order, never starting or ending with one, examples for each", async () => {
    const { STAFF_HANDOFF_TEMPLATE } = await import("./handoff-alerts.server");
    expect(STAFF_HANDOFF_TEMPLATE.name).toBe("staff_handoff_alert");
    expect(STAFF_HANDOFF_TEMPLATE.body.match(/\{\{\d+\}\}/g)).toEqual(["{{1}}", "{{2}}", "{{3}}", "{{4}}"]);
    expect(STAFF_HANDOFF_TEMPLATE.body).not.toMatch(/^\s*\{\{|\}\}\s*$/);
    expect(STAFF_HANDOFF_TEMPLATE.examples).toHaveLength(4);
    expect(STAFF_HANDOFF_TEMPLATE.body.length).toBeLessThan(1024);
  });

  it("values: workspace, customer, short reason, inbox link — one line each, capped", async () => {
    const { staffAlertParams, INBOX_LINK } = await import("./handoff-alerts.server");
    expect(staffAlertParams({ business: "Zoori", customer: "Asha", why: "a customer asked to talk to a person" })).toEqual([
      "Zoori",
      "Asha",
      "a customer asked to talk to a person",
      INBOX_LINK,
    ]);
    const p = staffAlertParams({ business: "Z\n\tshop", customer: "A".repeat(200), why: "w", reminder: true });
    expect(p[0]).toBe("Z shop");
    expect(p[1]!.length).toBe(60);
    expect(p[2]).toBe("(reminder, still waiting) w");
  });
});

describe("sendHandoffAlert inside / outside the 24-hour window", () => {
  it("inside the window: free text as before, no template", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    const text: string[] = [];
    const tpl: string[] = [];
    const out = await sendHandoffAlert(
      world({ phones: ["+919876543210"], template: { status: "APPROVED" } }).supabase,
      { organizationId: ORG, conversationId: "c1", reason: "asked_for_person" },
      { channelFor: async (p) => ({ to: p }), sendWhatsApp: async (c) => (text.push((c as unknown as { to: string }).to), true), sendTemplate: async (p) => (tpl.push(p), true) },
    );
    expect(text).toEqual(["+919876543210"]);
    expect(tpl).toEqual([]);
    expect(out.templated).toBeUndefined();
  });

  it("outside it: the approved template from the platform number, with the four values", async () => {
    const { sendHandoffAlert, INBOX_LINK } = await import("./handoff-alerts.server");
    const out = await sendHandoffAlert(
      world({ phones: ["+919876543210"], email: "team@example.com", template: { status: "APPROVED" } }).supabase,
      { organizationId: ORG, conversationId: "c1", reason: "flow_assign" },
      { channelFor: async () => null, sendEmail: async () => true },
    );
    expect(out.whatsapp).toEqual(["+919876543210"]);
    expect(out.templated).toEqual(["+919876543210"]);
    expect(out.email).toBeNull(); // the template reached them: no email
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      org: "platform-org",
      phone: "+919876543210",
      variables: { "1": "Zoori", "2": "Asha", "3": "a flow handed a chat to you", "4": INBOX_LINK },
      template: { name: "staff_handoff_alert", variableOrder: [1, 2, 3, 4] },
      context: { campaignId: null, category: "utility" },
    });
  });

  it("template not approved yet (or missing): nothing sent on WhatsApp, the email goes as before", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    for (const template of [{ status: "PENDING" }, null]) {
      const emails: string[] = [];
      const out = await sendHandoffAlert(
        world({ phones: ["+919876543210"], email: "team@example.com", template }).supabase,
        { organizationId: ORG, conversationId: "c1", reason: "asked_for_person" },
        { channelFor: async () => null, sendEmail: async (to) => (emails.push(to), true) },
      );
      expect(sent).toHaveLength(0);
      expect(out.whatsapp).toEqual([]);
      expect(emails).toEqual(["team@example.com"]);
    }
  });

  it("the business's own number is still refused — never sent a template either", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    const out = await sendHandoffAlert(
      world({ template: { status: "APPROVED" } }).supabase,
      { organizationId: ORG, conversationId: "c1", reason: "asked_for_person" },
      { channelFor: async () => null },
    );
    expect(out.refused).toEqual(["+919800000098"]);
    expect(sent).toHaveLength(0);
  });

  it("two staff numbers: the template sender is resolved once, each number sent once", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    const db = world({ phones: ["+919876543210", "+919876543211"], template: { status: "APPROVED" } });
    const out = await sendHandoffAlert(db.supabase, { organizationId: ORG, conversationId: "c1", reason: "asked_for_person" }, { channelFor: async () => null });
    expect(out.templated).toEqual(["+919876543210", "+919876543211"]);
    expect(db.ops.filter((o) => o.table === "message_templates")).toHaveLength(1);
  });

  it("a reminder outside the window says it is a reminder", async () => {
    const { sendHandoffAlert } = await import("./handoff-alerts.server");
    await sendHandoffAlert(
      world({ phones: ["+919876543210"], template: { status: "APPROVED" } }).supabase,
      { organizationId: ORG, conversationId: "c1", reason: "asked_for_person", reminder: true },
      { channelFor: async () => null },
    );
    expect(sent[0]!.variables["3"]).toBe("(reminder, still waiting) a customer asked to talk to a person");
  });
});
