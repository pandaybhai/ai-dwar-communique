import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb, type MemoryDb, type Row } from "./test-support/memory-db";
import { fakeDb } from "./test-support/fake-db";
import { latencyWorld } from "./test-support/latency-world";

/**
 * Batch 81 (add): AiDwar's own invoice / receipt / welcome message that Meta
 * failed to deliver. Live case: invoice AD/2026-27/00031 (client_invoice_issued
 * from the platform number) got 131026 "Message undeliverable" while the
 * invoice still read whatsapp_at with no error. Fakes only: no Meta, no DB.
 */

const h = vi.hoisted(() => ({
  open: new Set<string>(),
  texts: [] as Array<{ to: string; body: string }>,
  templates: [] as Array<{ phone: string; name: string; variables: Record<string, string> }>,
}));
vi.mock("@/lib/lead-alerts.server", async (orig) => ({
  ...(await orig<typeof import("./lead-alerts.server")>()),
  openWindowChannel: async (_s: unknown, number: string) =>
    h.open.has(number)
      ? {
          organizationId: PLATFORM,
          phoneNumberId: "pn",
          accessToken: "t",
          conversationId: `cv-${number}`,
          to: number,
        }
      : null,
}));
vi.mock("@/lib/service-text.server", async (orig) => ({
  ...(await orig<typeof import("./service-text.server")>()),
  sendServiceText: async (_s: unknown, a: { to: string; body: string }) => {
    h.texts.push({ to: a.to, body: a.body });
    return { ok: true, messageId: "m-text", error: null };
  },
}));
vi.mock("@/lib/campaigns.server", async (orig) => ({
  ...(await orig<typeof import("./campaigns.server")>()),
  loadSenderContext: async () => ({ accountId: "acc" }),
  sendCampaignTemplate: async (
    _s: unknown,
    _o: string,
    _sender: unknown,
    r: { phone: string; variables: Record<string, string> },
    t: { name: string },
  ) => {
    h.templates.push({ phone: r.phone, name: t.name, variables: r.variables });
    return { messageId: "m-tpl", error: null };
  },
}));
vi.mock("@/lib/start-reminders.server", async (orig) => ({
  ...(await orig<typeof import("./start-reminders.server")>()),
  platformTemplateBudget: async () => ({ limit: 100, used: 0 }),
}));

import {
  CUSTOMER_NOTICE_TEMPLATES,
  customerNoticeKind,
  maskedPhone,
  metaErrorTitle,
  noticeTag,
  undeliveredAlertText,
} from "./notice-delivery";
import { noteNoticeStatus, undeliveredBadges } from "./notice-delivery.server";
import { BILLING_TEMPLATES } from "./platform-notice-templates";

const PLATFORM = "00000000-0000-4000-8000-00000000aaaa";
const ORG = "11111111-1111-4111-8111-111111111111";
const INVOICE = "6820716d-0000-4000-8000-000000000031";
const MSG = "m-invoice-31";
const CONTACT = "c0000000-0000-4000-8000-000000000001";
const ALERT_A = "+919000000001";
const ALERT_B = "+919000000002";
const ERR_131026 = [
  {
    code: 131026,
    title: "Message undeliverable",
    message: "Message undeliverable",
    error_data: { details: "Message Undeliverable." },
  },
];
const AT = "2026-11-16T05:03:24.000Z";

beforeEach(() => {
  vi.stubEnv("PLATFORM_ORG_ID", PLATFORM);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  h.open = new Set();
  h.texts = [];
  h.templates = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function world(extra: Record<string, Row[]> = {}): MemoryDb {
  return memoryDb(
    {
      organizations: [{ id: ORG, name: "Asha Jewellers" }],
      organization_members: [],
      contacts: [
        { id: CONTACT, organization_id: PLATFORM, name: "Asha Rao", phone: "+919812345670" },
      ],
      invoices: [
        {
          id: INVOICE,
          organization_id: ORG,
          invoice_number: "AD/2026-27/00031",
          sent: {
            whatsapp_at: "2026-11-16T05:03:10.000Z",
            message_id: MSG,
            whatsapp_to: "+919812345670",
            whatsapp_error: null,
          },
        },
      ],
      // The live case: sent before the tag existed — known by its template.
      messages: [
        {
          id: MSG,
          organization_id: PLATFORM,
          template_name: "client_invoice_issued",
          status: "failed",
          metadata: { template_params: { "1": "Asha Jewellers" } },
        },
      ],
      platform_settings: [
        { id: true, lead_alert_numbers: [ALERT_A, ALERT_B], onboarding_whatsapp_account_id: "acc" },
      ],
      message_templates: [
        {
          organization_id: PLATFORM,
          name: "admin_ai_provider_alert",
          language: "en",
          status: "APPROVED",
          components: [],
        },
      ],
      billing_notifications: [],
      activity_log: [],
      ...extra,
    },
    {},
  );
}

const failedInvoice = (db: MemoryDb, row: Row = {}) =>
  noteNoticeStatus(db.supabase as never, {
    organizationId: PLATFORM,
    row: {
      id: MSG,
      template_name: "client_invoice_issued",
      metadata: (db.rows("messages")[0]!["metadata"] as Row) ?? null,
      conversations: { contact_id: CONTACT },
      ...row,
    } as never,
    status: "failed",
    errors: ERR_131026,
    at: AT,
  });

/* ============================================================ the rules === */

describe("which messages count, and what the team is told", () => {
  it("every client_* billing template, the welcome/setup ones and the sign-up reminder; never a staff alert", () => {
    for (const t of BILLING_TEMPLATES) {
      expect(CUSTOMER_NOTICE_TEMPLATES.has(t.name)).toBe(t.name.startsWith("client_"));
    }
    expect(CUSTOMER_NOTICE_TEMPLATES.get("client_invoice_issued")).toBe("invoice");
    expect(CUSTOMER_NOTICE_TEMPLATES.get("client_credit_purchased")).toBe("receipt");
    expect(CUSTOMER_NOTICE_TEMPLATES.get("aidwar_onboarding_start")).toBe("welcome");
    expect(CUSTOMER_NOTICE_TEMPLATES.get("aidwar_onboarding_resume_link")).toBe("welcome");
    expect(CUSTOMER_NOTICE_TEMPLATES.get("aidwar_finish_signup")).toBe("signup");
    for (const staff of ["staff_handoff_alert", "aidwar_new_lead_alert", "admin_float_low"]) {
      expect(customerNoticeKind({ template_name: staff })).toBeNull();
    }
    // A free-text notice (inside the window) is known by its tag.
    expect(
      customerNoticeKind({
        template_name: null,
        metadata: noticeTag({ kind: "receipt", organization_id: ORG }),
      }),
    ).toBe("receipt");
  });

  it("the alert's words", () => {
    expect(metaErrorTitle(ERR_131026)).toEqual({
      title: "Message undeliverable (131026)",
      code: "131026",
    });
    expect(maskedPhone("+919812345670")).toBe("+91…5670");
    expect(maskedPhone("447700900123")).toBe("…0123");
    expect(
      undeliveredAlertText({
        kind: "invoice",
        name: "Asha Rao",
        phone: "+919812345670",
        org: "Asha Jewellers",
        error: "Message undeliverable (131026)",
      }),
    ).toBe(
      "⚠️ Invoice not delivered to Asha Rao +91…5670 (Asha Jewellers): Message undeliverable (131026). Call them.",
    );
  });
});

/* ======================================================= failed status === */

describe("a failed status on AiDwar's own customer message", () => {
  it("the 00031 case: the error lands on the invoice, Admin gets the record, both alert numbers are told", async () => {
    const db = world();
    h.open.add(ALERT_A); // A wrote to AiDwar in the last 24 h: a free text; B needs the template
    expect(await failedInvoice(db)).toBe("alerted");

    const sent = db.rows("invoices")[0]!["sent"] as Row;
    expect(sent).toMatchObject({
      whatsapp_at: "2026-11-16T05:03:10.000Z", // when it went is kept
      message_id: MSG,
      whatsapp_error: "Message undeliverable (131026)",
      delivery_status: "failed",
      whatsapp_failed_at: AT,
    });

    expect(db.rows("activity_log")).toEqual([
      expect.objectContaining({
        organization_id: ORG,
        action: "notice_undelivered",
        details: expect.objectContaining({
          message_id: MSG,
          kind: "invoice",
          error: "Message undeliverable (131026)",
          error_code: "131026",
          invoice_number: "AD/2026-27/00031",
          phone_last4: "+91…5670",
        }),
      }),
    ]);

    expect(h.texts).toEqual([
      {
        to: ALERT_A,
        body: "⚠️ Invoice not delivered to Asha Rao +91…5670 (Asha Jewellers): Message undeliverable (131026). Call them.",
      },
    ]);
    expect(h.templates).toEqual([
      {
        phone: ALERT_B,
        name: "admin_ai_provider_alert",
        variables: {
          "1": "Invoice not delivered to Asha Rao +91…5670 (Asha Jewellers)",
          "2": 'Meta says "Message undeliverable (131026)" — call them',
          "3": "https://aidwar.in/admin/customers",
        },
      },
    ]);
  });

  it("once per message: the same failed status again tells nobody and writes nothing more", async () => {
    const db = world();
    h.open.add(ALERT_A);
    h.open.add(ALERT_B);
    await failedInvoice(db);
    const again = await failedInvoice(db);
    expect(again).toBe("none");
    expect(h.texts).toHaveLength(2);
    expect(db.rows("activity_log")).toHaveLength(1);
  });

  it("only the platform number's messages; a delivered one or a staff alert is not a failure", async () => {
    const db = world();
    expect(
      await noteNoticeStatus(db.supabase as never, {
        organizationId: ORG, // a merchant's own template with the same name
        row: { id: MSG, template_name: "client_invoice_issued" },
        status: "failed",
        errors: ERR_131026,
        at: AT,
      }),
    ).toBe("none");
    expect(
      await noteNoticeStatus(db.supabase as never, {
        organizationId: PLATFORM,
        row: { id: MSG, template_name: "staff_handoff_alert" },
        status: "failed",
        errors: ERR_131026,
        at: AT,
      }),
    ).toBe("none");
    expect(h.texts).toEqual([]);
    expect(h.templates).toEqual([]);
    expect((db.rows("invoices")[0]!["sent"] as Row)["whatsapp_error"]).toBeNull();
  });

  it("a welcome/setup message: recorded on the sign-up's workspace, told as 'Welcome/setup message'", async () => {
    const db = world({
      messages: [
        {
          id: "m-welcome",
          organization_id: PLATFORM,
          template_name: "aidwar_onboarding_start",
          metadata: noticeTag({ kind: "welcome", organization_id: ORG, session_id: "s1" }),
        },
      ],
    });
    h.open.add(ALERT_A);
    h.open.add(ALERT_B);
    await noteNoticeStatus(db.supabase as never, {
      organizationId: PLATFORM,
      row: {
        id: "m-welcome",
        template_name: "aidwar_onboarding_start",
        metadata: db.rows("messages")[0]!["metadata"] as Row,
        conversations: { contact_id: CONTACT },
      },
      status: "failed",
      errors: ERR_131026,
      at: AT,
    });
    expect(h.texts[0]!.body).toBe(
      "⚠️ Welcome/setup message not delivered to Asha Rao +91…5670 (Asha Jewellers): Message undeliverable (131026). Call them.",
    );
    expect(db.rows("activity_log")[0]).toMatchObject({
      organization_id: ORG,
      action: "notice_undelivered",
    });
  });

  it("a billing notice (receipt): its notice row gets the error, its status stays 'sent' (never re-sent)", async () => {
    const db = world({
      billing_notifications: [{ id: "n1", status: "sent", error: null, kind: "credit_purchased" }],
      messages: [
        {
          id: "m-receipt",
          organization_id: PLATFORM,
          template_name: "client_credit_purchased",
          metadata: {
            ...noticeTag({ kind: "receipt", organization_id: ORG, notification_id: "n1" }),
            to: "+919812345670",
          },
        },
      ],
    });
    h.open.add(ALERT_A);
    h.open.add(ALERT_B);
    await noteNoticeStatus(db.supabase as never, {
      organizationId: PLATFORM,
      row: {
        id: "m-receipt",
        template_name: "client_credit_purchased",
        metadata: db.rows("messages")[0]!["metadata"] as Row,
        conversations: null,
      },
      status: "failed",
      errors: ERR_131026,
      at: AT,
    });
    expect(db.rows("billing_notifications")[0]).toMatchObject({
      status: "sent",
      error: "not delivered: Message undeliverable (131026)",
    });
    // No contact on the row: the number from the tag, the owner-less name fallback.
    expect(h.texts[0]!.body).toBe(
      "⚠️ Receipt not delivered to the customer +91…5670 (Asha Jewellers): Message undeliverable (131026). Call them.",
    );
  });
});

/* =============================================================== admin === */

describe("Admin's red 'Not delivered' badge", () => {
  it("shows after a failure, and goes once a later notice to them is delivered", async () => {
    const db = world();
    h.open.add(ALERT_A);
    h.open.add(ALERT_B);
    await failedInvoice(db);
    const badges = await undeliveredBadges(db.supabase as never, Date.parse(AT) + 1000);
    expect(badges.get(ORG)).toEqual({
      at: AT,
      kind: "invoice",
      error: "Message undeliverable (131026)",
      invoice_number: "AD/2026-27/00031",
    });

    // Later: the resent invoice reached them.
    const later = new Date(Date.parse(AT) + 3_600_000).toISOString();
    vi.useFakeTimers({ now: Date.parse(later), toFake: ["Date"] });
    try {
      expect(
        await noteNoticeStatus(db.supabase as never, {
          organizationId: PLATFORM,
          row: {
            id: "m-resend",
            template_name: "client_invoice_issued",
            metadata: noticeTag({ kind: "invoice", organization_id: ORG, invoice_id: INVOICE }),
          },
          status: "delivered",
          errors: [],
          at: later,
        }),
      ).toBe("delivered");
    } finally {
      vi.useRealTimers();
    }
    const after = await undeliveredBadges(db.supabase as never, Date.parse(later) + 1000);
    expect(after.has(ORG)).toBe(false);
  });

  it("decided by Meta's status time, not by when the row was written (statuses arrive out of order)", async () => {
    const at = (h: number) => new Date(Date.parse(AT) + h * 3_600_000).toISOString();
    const db = world({
      activity_log: [
        // written first, but it's the newer outcome: delivered at +2h
        {
          organization_id: ORG,
          action: "notice_delivered",
          details: { at: at(2) },
          created_at: at(5),
        },
        // a retry wrote the older failure (+1h) later
        {
          organization_id: ORG,
          action: "notice_undelivered",
          details: { at: at(1), kind: "invoice", error: "x" },
          created_at: at(6),
        },
      ],
    });
    expect((await undeliveredBadges(db.supabase as never, Date.parse(at(7)))).has(ORG)).toBe(false);
  });

  it("Customers and Billing both show it on the workspace's row", () => {
    const customers = readFileSync("src/routes/admin/customers.tsx", "utf8");
    const billing = readFileSync("src/routes/admin/billing.tsx", "utf8");
    expect(customers).toContain("<NotDeliveredBadge badge={r.undelivered} />");
    expect(billing).toContain("<NotDeliveredBadge badge={row.undelivered} />");
    expect(readFileSync("src/lib/admin-customers.server.ts", "utf8")).toContain(
      "undelivered: undelivered.get(id) ?? null,",
    );
    expect(readFileSync("src/lib/billing-admin.server.ts", "utf8")).toContain(
      "undelivered: undelivered.get(id) ?? null,",
    );
    const badge = readFileSync("src/components/admin/not-delivered-badge.tsx", "utf8");
    expect(badge).toContain("Not delivered");
    expect(badge).toContain("text-destructive");
  });
});

/* ======================================================= the plumbing === */

describe("the senders tag their messages, and the webhook hands failures over", () => {
  it("invoice, onboarding nudges, the sign-up reminder and the billing drain carry the tag", () => {
    expect(readFileSync("src/lib/invoices.server.ts", "utf8")).toMatch(
      /messageMetadata: \(await import\("@\/lib\/notice-delivery"\)\)\.noticeTag\(\{\s*kind: "invoice"/,
    );
    const nudges = readFileSync("src/lib/onboarding-nudges.server.ts", "utf8");
    expect(nudges.match(/messageMetadata: noticeTag\(\{\s*kind: "welcome"/g)).toHaveLength(3);
    expect(readFileSync("src/lib/start-reminders.server.ts", "utf8")).toMatch(
      /noticeTag\(\{\s*kind: "signup"/,
    );
    const drain = readFileSync("src/lib/billing-notify.server.ts", "utf8");
    expect(drain.match(/\.\.\.\(tag \? \{ metadata: tag \} : \{\}\)/g)).toHaveLength(2);
  });

  it("the drain's template notice to a customer now gets its messages row (Meta's id + the tag)", async () => {
    const notice: Row = {
      id: "n-trial",
      organization_id: ORG,
      audience: "client",
      kind: "trial_ending",
      channel: "whatsapp",
      recipient: "+919812345670",
      status: "queued",
      sent_at: null,
      payload: { days_left: 3 },
    };
    const inserted: Row[] = [];
    const db = fakeDb((op) => {
      if (op.table === "billing_notifications" && op.kind === "select")
        return { data: [{ ...notice }], error: null };
      if (op.table === "billing_notifications" && op.kind === "update") {
        const p = op.payload as Row;
        if (p["status"]) {
          Object.assign(notice, p);
          return { data: null, error: null };
        }
        notice["sent_at"] = p["sent_at"];
        return { data: [{ id: notice["id"] }], error: null };
      }
      if (op.table === "whatsapp_accounts")
        return {
          data: [
            {
              id: "acc",
              organization_id: PLATFORM,
              waba_id: "w",
              phone_number_id: "pn",
              display_phone_number: "91",
              status: "active",
              is_default: true,
            },
          ],
          error: null,
        };
      if (op.table === "whatsapp_credentials")
        return { data: { access_token: "tok" }, error: null };
      if (op.table === "contacts") return { data: [], error: null };
      if (op.table === "organizations") return { data: { name: "Asha Jewellers" }, error: null };
      if (op.table === "message_templates")
        return {
          data: { name: "client_trial_ending", language: "en", status: "APPROVED" },
          error: null,
        };
      if (op.table === "messages" && op.kind === "insert") {
        inserted.push(op.payload as Row);
        return { data: null, error: null };
      }
      return undefined;
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ messages: [{ id: "wamid.trial" }] }), { status: 200 }),
    );
    const { drainBillingNotifications } = await import("./billing-notify.server");
    const counts = await drainBillingNotifications(db.supabase);
    expect(counts.sent).toBe(1);
    expect(inserted).toEqual([
      expect.objectContaining({
        organization_id: PLATFORM,
        meta_message_id: "wamid.trial",
        direction: "outbound",
        type: "template",
        template_name: "client_trial_ending",
        status: "pending",
        metadata: expect.objectContaining({
          customer_notice: expect.objectContaining({
            kind: "billing",
            organization_id: ORG,
            notification_id: "n-trial",
          }),
          to: "+919812345670",
        }),
      }),
    ]);
  });

  it("the status webhook: a failed status on the platform's invoice message is handed over, off the reply path", async () => {
    vi.stubEnv("PLATFORM_ORG_ID", "org-latency");
    const row = {
      id: "m-inv",
      status: "failed",
      type: "template",
      template_name: "client_invoice_issued",
      conversation_id: "cv1",
      campaign_id: null,
      flow_id: null,
      created_at: new Date().toISOString(),
      metadata: noticeTag({ kind: "invoice", organization_id: ORG, invoice_id: INVOICE }),
      conversations: { contact_id: CONTACT, whatsapp_account_id: "acc" },
    };
    const w = latencyWorld({
      org: "org-latency",
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) =>
        op.table === "messages" && op.kind === "update" ? { data: [row], error: null } : undefined,
    });
    const { processWebhookPayload } = await import("./whatsapp-webhook.server");
    await processWebhookPayload(w.supabase, "ev-inv", {
      entry: [
        {
          id: "waba",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "pn" },
                statuses: [
                  {
                    id: "wamid.inv",
                    status: "failed",
                    timestamp: "1794900204",
                    errors: ERR_131026,
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    // The claim (once per message), then the invoice write.
    const claim = w.ops.find(
      (o) =>
        o.table === "messages" &&
        o.kind === "update" &&
        (o.payload as Row)["metadata"] !== undefined,
    );
    expect((claim!.payload as { metadata: Row }).metadata["undelivered_alert_at"]).toBeTruthy();
    expect(w.ops.some((o) => o.table === "invoices")).toBe(true);
    const closed = w.ops.filter((o) => o.table === "webhook_events" && o.kind === "update").at(-1)!
      .payload as Row;
    expect(closed["error"]).toBeNull();
  });

  it("checkout gets no number check (Vinay: no)", () => {
    for (const f of [
      "src/lib/checkout-999.server.ts",
      "src/routes/api/public/checkout-999.ts",
      "src/components/p999/checkout-999.tsx",
      "src/lib/checkout-999-flow.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/notice-delivery|wa-reachability|unreachableByPhone/);
    }
  });
});
