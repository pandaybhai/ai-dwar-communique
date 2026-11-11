import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb } from "./test-support/memory-db";
import { NO_SEND_FILTERS, SEND_STATUSES, sendStatusLabel, sendsCsv } from "./template-sends";
import { loadAllTemplateSends, loadTemplateSends, SEND_PAGE } from "./template-sends-data";
import { indiaDayStart, refusedHeadline, refusedNoTemplateText } from "./api-refusals";
import { BILLING_TEMPLATES } from "./platform-notice-templates";
import { emptyDraft, startsOrEndsWithVariable, validateDraft } from "./templates";

/**
 * Batch 67 — refused API sends in the shop's views: Templates → Sent (rows
 * with status "Refused" and the reason, the Refused filter, totals, the CSV,
 * and "Refused (no template)"), Home's Needs attention words, and the daily
 * failure summary (email, plus the WhatsApp copy through the platform's
 * client_send_failures template only while it is APPROVED). Fakes only.
 */

vi.mock("@/integrations/aidwar/client", () => ({ aidwar: {} }));

const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
const at = (h: number) =>
  new Date(Date.parse("2026-11-02T04:00:00.000Z") + h * 3600e3).toISOString();

const sent = (id: string, h: number, over: Record<string, unknown> = {}) => ({
  id,
  organization_id: ORG,
  direction: "outbound",
  type: "template",
  template_name: "invoice_ready",
  status: "delivered",
  error_detail: null,
  campaign_id: null,
  flow_id: null,
  sent_by: null,
  metadata: { source: "api", idempotency_key: id, to: "+919876543210" },
  created_at: at(h),
  conversations: { contact_id: "c1", contacts: { id: "c1", name: "Asha", phone: "+919876543210" } },
  ...over,
});
const refused = (id: string, h: number, over: Record<string, unknown> = {}) => ({
  id,
  organization_id: ORG,
  endpoint: "template",
  http_status: 400,
  error_code: "invalid_phone",
  reason: "`to` isn't a WhatsApp number we can send to (too short).",
  template_name: "invoice_ready",
  to_received: "12345",
  idempotency_key: `inv-${id}`,
  field: "to",
  created_at: at(h),
  ...over,
});

const world = () =>
  memoryDb({
    messages: [sent("m1", 5), sent("m2", 3, { status: "failed" }), sent("m3", 1)],
    api_refusals: [
      refused("r1", 4),
      refused("r2", 2, {
        error_code: "template_not_approved",
        reason: "Not approved yet.",
        field: null,
      }),
      refused("r-other-template", 2, { template_name: "order_shipped" }),
      refused("r-none", 2, {
        template_name: null,
        endpoint: "session",
        error_code: "window_closed",
      }),
      refused("r-other-org", 2, { organization_id: "00000000-0000-4000-8000-000000000067" }),
    ],
    campaigns: [],
  });

describe("Templates → Sent", () => {
  it("refused rows sit among the sends, newest first, with status Refused and the reason", async () => {
    const r = await loadTemplateSends(world().supabase as never, {
      organizationId: ORG,
      templateName: "invoice_ready",
      filters: NO_SEND_FILTERS,
    });
    expect(r.error).toBeNull();
    expect(r.lines.map((l) => [l.id, l.status])).toEqual([
      ["m1", "delivered"],
      ["refusal:r1", "refused"],
      ["m2", "failed"],
      ["refusal:r2", "refused"],
      ["m3", "delivered"],
    ]);
    const line = r.lines[1]!;
    expect(line).toMatchObject({
      source: "api",
      customer: "12345",
      reference: "inv-r1",
      reason: "`to` isn't a WhatsApp number we can send to (too short).",
    });
    expect(sendStatusLabel("refused")).toBe("Refused");
    expect(SEND_STATUSES).toContain("refused");
  });

  it("totals add refused; the Refused filter shows only them; a campaign/flow/Inbox source never does", async () => {
    const load = (f: Partial<typeof NO_SEND_FILTERS>) =>
      loadTemplateSends(world().supabase as never, {
        organizationId: ORG,
        templateName: "invoice_ready",
        filters: { ...NO_SEND_FILTERS, ...f },
      });
    const all = await load({});
    expect(all.totals).toMatchObject({ sent: 2, delivered: 2, failed: 1, refused: 2 });
    const onlyRefused = await load({ status: "refused" });
    expect(onlyRefused.lines.map((l) => l.id)).toEqual(["refusal:r1", "refusal:r2"]);
    expect(onlyRefused.totals.refused).toBe(2);
    expect(onlyRefused.totals.delivered).toBe(2); // totals keep the template's whole picture
    const failedOnly = await load({ failedOnly: true });
    expect(failedOnly.lines.map((l) => l.id)).toEqual(["m2"]);
    const campaigns = await load({ source: "campaign" });
    expect(campaigns.lines).toEqual([]);
    expect(campaigns.totals.refused).toBe(0);
  });

  it("the CSV includes the refused rows with their reason", async () => {
    const lines = await loadAllTemplateSends(world().supabase as never, {
      organizationId: ORG,
      templateName: "invoice_ready",
      filters: NO_SEND_FILTERS,
    });
    const csv = sendsCsv("invoice_ready", lines);
    expect(csv).toContain(
      "invoice_ready,API,12345,12345,inv-r1,Refused,`to` isn't a WhatsApp number we can send to (too short).,",
    );
    expect(csv.trim().split("\n")).toHaveLength(1 + 5);
  });

  it("a field the reason doesn't name is added to it (cc[1])", async () => {
    const { refusalLine } = await import("./template-sends");
    const line = refusalLine({
      id: "x",
      created_at: at(1),
      endpoint: "template",
      http_status: 400,
      error_code: "invalid_phone",
      reason: "One copy number can't be read.",
      template_name: "invoice_ready",
      to_received: "+919876543210",
      idempotency_key: null,
      field: "cc[1]",
    });
    expect(line.reason).toBe("One copy number can't be read. (cc[1])");
  });

  it("Refused (no template): only the refusals that named none", async () => {
    const r = await loadTemplateSends(world().supabase as never, {
      organizationId: ORG,
      templateName: null,
      filters: NO_SEND_FILTERS,
    });
    expect(r.lines.map((l) => l.id)).toEqual(["refusal:r-none"]);
    expect(r.totals).toMatchObject({ sent: 0, refused: 1 });
    expect(refusedNoTemplateText(1)).toBe("Refused (no template): 1 API send in the last 30 days");
    expect(refusedNoTemplateText(4)).toBe("Refused (no template): 4 API sends in the last 30 days");
  });

  it("paging: each refusal appears once, on the page whose sends surround it", async () => {
    const messages = Array.from({ length: SEND_PAGE + 10 }, (_, i) => sent(`p${i}`, 100 - i));
    const db = memoryDb({
      messages,
      api_refusals: [
        refused("early", 100 - 5.5), // between p5 and p6: page 0
        refused("boundary", 100 - (SEND_PAGE - 0.5)), // between page 0's last and page 1's first
        refused("late", 100 - (SEND_PAGE + 20)), // older than every send: the last page
      ],
      campaigns: [],
    });
    const page = (n: number) =>
      loadTemplateSends(db.supabase as never, {
        organizationId: ORG,
        templateName: "invoice_ready",
        filters: NO_SEND_FILTERS,
        page: n,
      });
    const p0 = await page(0);
    const p1 = await page(1);
    expect(p0.hasMore).toBe(true);
    expect(p1.hasMore).toBe(false);
    const ids = [...p0.lines, ...p1.lines].map((l) => l.id);
    expect(ids.filter((id) => id.startsWith("refusal:"))).toEqual([
      "refusal:early",
      "refusal:boundary",
      "refusal:late",
    ]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(p0.lines.some((l) => l.id === "refusal:early")).toBe(true);
    expect(p1.lines.some((l) => l.id === "refusal:late")).toBe(true);
  });

  it("without the table (20261370 not applied) the report is what it was", async () => {
    const db = memoryDb({ messages: [sent("m1", 5)], campaigns: [] });
    const supabase = new Proxy(db.supabase as object, {
      get(t, p) {
        if (p === "from")
          return (table: string) => {
            const q = (t as { from: (x: string) => Record<string, unknown> }).from(table);
            if (table !== "api_refusals") return q;
            const failing: Record<string, unknown> = {};
            const self = () => failing;
            for (const k of ["select", "eq", "is", "gte", "lt", "order", "range", "limit"])
              failing[k] = self;
            failing["then"] = (ok: (v: unknown) => unknown) =>
              Promise.resolve({
                data: null,
                count: null,
                error: { code: "42P01", message: "relation does not exist" },
              }).then(ok);
            return failing;
          };
        return Reflect.get(t, p);
      },
    });
    const r = await loadTemplateSends(supabase as never, {
      organizationId: ORG,
      templateName: "invoice_ready",
      filters: NO_SEND_FILTERS,
    });
    expect(r.error).toBeNull();
    expect(r.lines.map((l) => l.id)).toEqual(["m1"]);
    expect(r.totals.refused).toBe(0);
  });
});

describe("Home → Needs attention", () => {
  it("the words, and 'today' is the India day", () => {
    expect(refusedHeadline(1)).toBe("1 API send was refused today");
    expect(refusedHeadline(3)).toBe("3 API sends were refused today");
    // 2 Nov 23:30 IST is still 2 Nov; 3 Nov 00:30 IST starts 3 Nov.
    expect(new Date(indiaDayStart(Date.parse("2026-11-02T18:00:00Z"))).toISOString()).toBe(
      "2026-11-01T18:30:00.000Z",
    );
    expect(new Date(indiaDayStart(Date.parse("2026-11-02T19:00:00Z"))).toISOString()).toBe(
      "2026-11-02T18:30:00.000Z",
    );
  });
});

// ------------------------------------------------------------ the daily summary

const NINE_THIRTY_IST = Date.parse("2026-11-03T04:00:00.000Z");
const PLATFORM = "00000000-0000-4000-8000-0000000000aa";
const ago = (h: number) => new Date(NINE_THIRTY_IST - h * 3600e3).toISOString();

function digestWorld(
  opts: {
    templateStatus?: string | null;
    ownerPhone?: string | null;
    branding?: Record<string, unknown>;
  } = {},
) {
  return memoryDb({
    messages: [],
    api_refusals: [
      refused("d1", 0, { created_at: ago(2) }),
      refused("d2", 0, {
        created_at: ago(1),
        template_name: null,
        endpoint: "session",
        error_code: "window_closed",
        reason: "The 24-hour window is closed.",
        to_received: "+919811111111",
      }),
      refused("d-old", 0, { created_at: ago(30) }),
    ],
    organizations: [{ id: ORG, name: "ZOORI Jewels INDIA", branding: opts.branding ?? {} }],
    organization_ai_settings: [{ organization_id: ORG, handoff_alert_email: "owner@zoori.test" }],
    organization_members: [
      { organization_id: ORG, user_id: "u-owner", role: "owner", created_at: ago(1000) },
    ],
    profiles: [
      { id: "u-owner", email: "founder@zoori.test", phone: opts.ownerPhone ?? "+919800000001" },
    ],
    message_templates:
      opts.templateStatus === null
        ? []
        : [
            {
              organization_id: PLATFORM,
              name: "client_send_failures",
              language: "en",
              status: opts.templateStatus ?? "APPROVED",
            },
          ],
    billing_notifications: [],
  });
}

describe("the daily summary", () => {
  beforeEach(() => {
    vi.stubEnv("PLATFORM_ORG_ID", PLATFORM);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("a day with only refusals has a summary: the email lists them; the WhatsApp copy goes to the owner with the count", async () => {
    const db = digestWorld();
    const { runSendFailureDigest } = await import("./send-failure-digest.server");
    const out = await runSendFailureDigest(db.supabase, NINE_THIRTY_IST);
    expect(out).toMatchObject({ workspaces: 1, queued: 2 });
    const rows = db.rows("billing_notifications");
    const email = rows.find((r) => r["channel"] === "email")!;
    const wa = rows.find((r) => r["channel"] === "whatsapp")!;
    expect(email).toMatchObject({ kind: "send_failures", recipient: "owner@zoori.test" });
    const payload = email["payload"] as Record<string, unknown>;
    expect(payload["total"]).toBe(0);
    expect(payload["refused_total"]).toBe(2);
    expect(payload["refused_lines"]).toEqual([
      expect.objectContaining({
        number: "+919811111111",
        template: "free-form message",
        reason: "The 24-hour window is closed.",
      }),
      expect.objectContaining({ number: "12345", template: "invoice_ready" }),
    ]);
    expect(wa).toMatchObject({
      kind: "send_failures",
      audience: "client",
      recipient: "+919800000001",
      status: "queued",
    });
    expect(wa["payload"]).toMatchObject({ count: 2, link: "https://aidwar.in/app/templates" });

    const { emailNoticeContent } = await import("./email-notices.server");
    const content = await emailNoticeContent(memoryDb().supabase, {
      kind: "send_failures",
      payload,
    });
    expect(content?.subject).toBe("2 API sends were refused — ZOORI Jewels INDIA");
    expect(content?.body).toContain("we refused 2 API sends from your software before sending");
    expect(content?.body).toContain(
      "+919811111111 — free-form message — The 24-hour window is closed.",
    );
    // Once a day.
    expect((await runSendFailureDigest(db.supabase, NINE_THIRTY_IST + 3600e3)).queued).toBe(0);
  });

  it("failures and refusals together: one subject with both", async () => {
    const { emailNoticeContent } = await import("./email-notices.server");
    const content = await emailNoticeContent(memoryDb().supabase, {
      kind: "send_failures",
      payload: {
        workspace: "ZOORI",
        total: 3,
        lines: [],
        refused_total: 1,
        refused_lines: [
          { at: ago(1), number: "12345", template: "invoice_ready", reason: "Too short." },
        ],
        link: "https://aidwar.in/app/templates",
      },
    });
    expect(content?.subject).toBe(
      "3 WhatsApp messages couldn't be delivered, 1 API send was refused — ZOORI",
    );
  });

  it("the WhatsApp copy waits for an APPROVED template, an owner phone and its switch; the email goes regardless", async () => {
    const { runSendFailureDigest } = await import("./send-failure-digest.server");
    for (const [name, db] of [
      ["pending template", digestWorld({ templateStatus: "PENDING" })],
      ["no template", digestWorld({ templateStatus: null })],
      ["no owner phone", digestWorld({ ownerPhone: "" })],
      ["switched off", digestWorld({ branding: { send_failure_summary_whatsapp: false } })],
    ] as const) {
      await runSendFailureDigest(db.supabase, NINE_THIRTY_IST);
      const channels = db.rows("billing_notifications").map((r) => r["channel"]);
      expect(channels, name).toEqual(["email"]);
    }
    // The summary switched off: neither goes.
    const off = digestWorld({ branding: { send_failure_summary: false } });
    expect((await runSendFailureDigest(off.supabase, NINE_THIRTY_IST)).skipped_off).toBe(1);
    expect(off.rows("billing_notifications")).toHaveLength(0);
  });

  it("nothing to report (refusals older than 24 hours only): no summary at all", async () => {
    const db = digestWorld();
    db.rows("api_refusals").splice(0, 2);
    const { runSendFailureDigest } = await import("./send-failure-digest.server");
    expect((await runSendFailureDigest(db.supabase, NINE_THIRTY_IST)).queued).toBe(0);
    expect(db.rows("billing_notifications")).toHaveLength(0);
  });
});

describe("the WhatsApp template", () => {
  it("client_send_failures is a UTILITY notice Meta can approve: three values, no dashes, a fixed link", () => {
    const spec = BILLING_TEMPLATES.find((t) => t.name === "client_send_failures")!;
    expect(spec.body).toBe(
      "Hello {{1}}, {{2}} WhatsApp messages from your account couldn't be sent or delivered yesterday. See them here: {{3}} Thank you.",
    );
    expect(spec.body).not.toMatch(/[—–]/);
    expect(startsOrEndsWithVariable(spec.body)).toBe(false);
    expect(spec.examples[2]).toBe("https://aidwar.in/app/templates");
    const draft = emptyDraft();
    draft.name = spec.name;
    draft.category = "UTILITY";
    draft.body = spec.body;
    draft.bodyExamples = { 1: spec.examples[0]!, 2: spec.examples[1]!, 3: spec.examples[2]! };
    expect(validateDraft(draft)).toEqual([]);
  });
});
