import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryDb } from "./test-support/memory-db";
import { latencyWorld } from "./test-support/latency-world";
import { fakeFetch, metaRoutes, ORG, PDF, publicApiWorld } from "./test-support/public-api-world";
import { clearSafeFetchDnsCache } from "./safe-fetch.server";
import { resetDialCodeCache } from "./public-api-send.server";

/**
 * Batch 63 (B): failed-send alerts. Zoori's billing software sends invoices
 * through POST /api/v1/messages/template; one customer number failed six
 * times in a day (Meta 131026, not on WhatsApp) and nobody at the shop knew —
 * the API answers 202 and the failure only arrives later. Fakes only.
 */

const h = vi.hoisted(() => ({ world: null as unknown as { db: { supabase: unknown } } | null }));
vi.mock("@/lib/whatsapp-webhook.server", async (orig) => ({
  ...(await orig<typeof import("./whatsapp-webhook.server")>()),
  getServiceClient: () => h.world!.db.supabase,
}));

import { processWebhookPayload } from "./whatsapp-webhook.server";
import {
  noteSendStatus,
  resetReachabilityCache,
  unreachableByPhone,
} from "./wa-reachability.server";
import {
  failureReason,
  parseErrorDetail,
  unreachableOf,
  warnsNow,
  UNREACHABLE_WARNING,
} from "./wa-reachability";
import { Route } from "../routes/api/v1/messages/template";

const CONTACT = "c0000000-0000-4000-8000-000000000001";
const ERR_131026 = [
  {
    code: 131026,
    title: "Message undeliverable",
    message: "Message undeliverable",
    error_data: { details: "Message Undeliverable." },
  },
];
const ERR_131049 = [
  {
    code: 131049,
    title: "This message was not delivered to maintain healthy ecosystem engagement.",
  },
];

const quiet = () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => resetReachabilityCache());

function contacts(mark: unknown = null) {
  return memoryDb({
    contacts: [{ id: CONTACT, organization_id: ORG, phone: "+919876543210", wa_unreachable: mark }],
    conversations: [{ id: "cv1", organization_id: ORG, contact_id: CONTACT }],
  });
}
const failed = (over: Record<string, unknown> = {}) => ({
  organizationId: ORG,
  messageId: "m-1",
  contactId: CONTACT,
  type: "template",
  templateName: "invoice_ready",
  status: "failed",
  errors: ERR_131026,
  at: "2026-11-02T05:00:00.000Z",
  ...over,
});

describe('the contact is marked "Not on WhatsApp" and cleared by a delivery', () => {
  it("a template that failed with 131026 marks the contact with the date and the error", async () => {
    const db = contacts();
    expect(await noteSendStatus(db.supabase, failed())).toBe("marked");
    const mark = unreachableOf(db.rows("contacts")[0]!["wa_unreachable"]);
    expect(mark).toEqual({
      since: "2026-11-02T05:00:00.000Z",
      last_at: "2026-11-02T05:00:00.000Z",
      code: "131026",
      reason: "Not on WhatsApp (or can't receive messages) (131026)",
      template: "invoice_ready",
      message_id: "m-1",
      failures: 1,
    });
  });

  it("Zoori's six failures in a day: one mark, first date kept, six counted; the same failure again counts once", async () => {
    const db = contacts();
    for (let i = 1; i <= 6; i += 1)
      await noteSendStatus(
        db.supabase,
        failed({ messageId: `m-${i}`, at: `2026-11-02T0${i}:00:00.000Z` }),
      );
    expect(
      await noteSendStatus(
        db.supabase,
        failed({ messageId: "m-6", at: "2026-11-02T06:00:00.000Z" }),
      ),
    ).toBe("none");
    const mark = unreachableOf(db.rows("contacts")[0]!["wa_unreachable"])!;
    expect([mark.since, mark.last_at, mark.failures, mark.message_id]).toEqual([
      "2026-11-02T01:00:00.000Z",
      "2026-11-02T06:00:00.000Z",
      6,
      "m-6",
    ]);
  });

  it("a later delivery (or read) clears it; an unmarked contact is left alone", async () => {
    const db = contacts();
    await noteSendStatus(db.supabase, failed());
    expect(
      await noteSendStatus(db.supabase, { ...failed(), status: "delivered", errors: [] }),
    ).toBe("cleared");
    expect(db.rows("contacts")[0]!["wa_unreachable"]).toBeNull();
    expect(await noteSendStatus(db.supabase, { ...failed(), status: "read", errors: [] })).toBe(
      "none",
    );
  });

  it("other failures never mark: 131049 (marketing cap), a non-template message, no contact", async () => {
    const db = contacts();
    expect(await noteSendStatus(db.supabase, failed({ errors: ERR_131049 }))).toBe("none");
    expect(await noteSendStatus(db.supabase, failed({ type: "text" }))).toBe("none");
    expect(
      await noteSendStatus(db.supabase, failed({ contactId: null, conversationId: null })),
    ).toBe("none");
    expect(db.rows("contacts")[0]!["wa_unreachable"]).toBeNull();
  });

  it("finds the contact through the conversation when the status row had no embed", async () => {
    const db = contacts();
    expect(
      await noteSendStatus(db.supabase, failed({ contactId: null, conversationId: "cv1" })),
    ).toBe("marked");
  });

  it("before 20261350 (no column) it does nothing and never throws", async () => {
    const base = contacts().supabase as unknown as { from: (t: string) => Record<string, unknown> };
    const noColumn = {
      from: (t: string) =>
        t === "contacts"
          ? {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: null,
                      error: {
                        code: "42703",
                        message: "column contacts.wa_unreachable does not exist",
                      },
                    }),
                  }),
                }),
              }),
            }
          : base.from(t),
    };
    expect(await noteSendStatus(noColumn as never, failed())).toBe("none");
    expect(await unreachableByPhone(noColumn as never, ORG, "+919876543210")).toBeNull();
  });
});

describe("the status webhook hooks it in, off the reply path", () => {
  beforeEach(quiet);
  const statusPayload = (status: string, extra: Record<string, unknown> = {}) => ({
    entry: [
      {
        id: "waba",
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: "pn" },
              statuses: [{ id: "wamid.api", status, timestamp: "1793000000", ...extra }],
            },
          },
        ],
      },
    ],
  });
  const row = (status: string) => ({
    id: "m-api",
    status,
    type: "template",
    template_name: "invoice_ready",
    conversation_id: "cv1",
    campaign_id: null,
    flow_id: null,
    created_at: new Date().toISOString(),
    metadata: { source: "api", api_key_id: "key-a", to: "+919876543210" },
    conversations: { contact_id: CONTACT, whatsapp_account_id: "acc" },
  });

  it("failed 131026 for an API invoice → the contact is marked; the event closes cleanly", async () => {
    const w = latencyWorld({
      org: ORG,
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) =>
        op.table === "messages" && op.kind === "update"
          ? { data: [row("failed")], error: null }
          : undefined,
    });
    await processWebhookPayload(
      w.supabase,
      "ev-f",
      statusPayload("failed", { errors: ERR_131026 }),
    );
    const mark = w.ops.find((o) => o.table === "contacts" && o.kind === "update");
    expect(mark?.payload).toMatchObject({
      wa_unreachable: { code: "131026", template: "invoice_ready", message_id: "m-api" },
    });
    const closed = w.ops.filter((o) => o.table === "webhook_events" && o.kind === "update").at(-1)!
      .payload as Record<string, unknown>;
    expect(closed["error"]).toBeNull();
  });

  it("delivered → one conditional clear (only a marked contact matches)", async () => {
    const w = latencyWorld({
      org: ORG,
      rttMs: 0,
      graphMs: 0,
      waitingRun: false,
      override: (op) =>
        op.table === "messages" && op.kind === "update"
          ? { data: [row("delivered")], error: null }
          : undefined,
    });
    await processWebhookPayload(w.supabase, "ev-d", statusPayload("delivered"));
    const clear = w.ops.find((o) => o.table === "contacts" && o.kind === "update");
    expect(clear?.payload).toEqual({ wa_unreachable: null });
    expect(clear?.filters).toContainEqual(["not", ["wa_unreachable", "is", null]]);
  });
});

describe("POST /api/v1/messages/template: still sends, the 202 warns", () => {
  type Handler = (a: { request: Request }) => Promise<Response>;
  const POST = (Route as unknown as { options: { server: { handlers: Record<string, Handler> } } })
    .options.server.handlers["POST"]!;
  let net: ReturnType<typeof fakeFetch>;
  beforeEach(() => {
    h.world = publicApiWorld() as never;
    clearSafeFetchDnsCache();
    resetDialCodeCache();
    net = fakeFetch([metaRoutes({ sendError: null, uploadError: false })]);
    vi.stubGlobal("fetch", net.impl);
  });
  const world = () => h.world as unknown as ReturnType<typeof publicApiWorld>;
  const send = async () => {
    const res = await POST({
      request: new Request("https://aidwar.in/api/v1/messages/template", {
        method: "POST",
        headers: { authorization: `Bearer ${world().keys.a}`, "content-type": "application/json" },
        body: JSON.stringify({
          to: "+919876543210",
          template_name: "invoice_ready",
          document: { base64: Buffer.from(PDF).toString("base64"), filename: "INV-1001.pdf" },
          body_params: ["Asha", "INV-1001", "INR 2,500"],
        }),
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  const metaSends = () =>
    net.calls.filter(
      (c) => c.url.startsWith("https://graph.facebook.com/") && c.url.endsWith("/messages"),
    );

  it("a number marked in the last 30 days: sent exactly as before, plus warning", async () => {
    world()
      .db.rows("contacts")
      .push({
        id: CONTACT,
        organization_id: ORG,
        phone: "+919876543210",
        wa_id: "919876543210",
        source: "api",
        wa_unreachable: {
          since: new Date(Date.now() - 864e5).toISOString(),
          last_at: new Date(Date.now() - 3600e3).toISOString(),
          code: "131026",
          reason: "x",
          failures: 6,
        },
      });
    const res = await send();
    expect(res.status).toBe(202);
    expect(res.body["warning"]).toBe(UNREACHABLE_WARNING);
    expect(res.body["status"]).toBe("queued");
    expect(metaSends()).toHaveLength(1);
  });

  it("no mark (or a mark older than 30 days): no warning field at all", async () => {
    expect((await send()).body).not.toHaveProperty("warning");
    expect(
      warnsNow(
        unreachableOf({
          since: "2026-01-01T00:00:00Z",
          last_at: "2026-01-01T00:00:00Z",
          code: "131026",
        }),
      ),
    ).toBe(false);
  });
});

describe("the daily summary (notify → the email drain)", () => {
  const NINE_THIRTY_IST = Date.parse("2026-11-03T04:00:00.000Z");
  const failedMsg = (org: string, id: string, over: Record<string, unknown> = {}) => ({
    id,
    organization_id: org,
    direction: "outbound",
    type: "template",
    status: "failed",
    template_name: "invoice_ready",
    error_detail: JSON.stringify(ERR_131026),
    metadata: { source: "api", to: "+919876543210", idempotency_key: id },
    campaign_id: null,
    flow_id: null,
    sent_by: null,
    created_at: new Date(NINE_THIRTY_IST - 3 * 3600e3).toISOString(),
    conversations: { contacts: { phone: "+919876543210", name: "Asha" } },
    ...over,
  });
  const OTHER = "00000000-0000-4000-8000-0000000000b2";
  const world = () =>
    memoryDb({
      messages: [
        failedMsg(ORG, "m1"),
        failedMsg(ORG, "m2", {
          metadata: { source: "api", copy: true, cc_of: "m1", to: "+918121310333" },
          conversations: { contacts: { phone: "+918121310333" } },
        }),
        failedMsg(ORG, "m3", {
          campaign_id: "camp-1",
          metadata: {},
          error_detail: JSON.stringify(ERR_131049),
        }),
        failedMsg(ORG, "m-old", {
          created_at: new Date(NINE_THIRTY_IST - 30 * 3600e3).toISOString(),
        }),
        failedMsg(ORG, "m-ok", { status: "delivered" }),
        failedMsg(OTHER, "o1"),
      ],
      organizations: [
        { id: ORG, name: "ZOORI Jewels INDIA", branding: {} },
        { id: OTHER, name: "Quiet shop", branding: { send_failure_summary: false } },
      ],
      organization_ai_settings: [{ organization_id: ORG, handoff_alert_email: "owner@zoori.test" }],
      organization_members: [],
      billing_notifications: [],
    });

  it("one email row per recipient, only for workspaces with failures and the summary on; once a day", async () => {
    const db = world();
    const { runSendFailureDigest } = await import("./send-failure-digest.server");
    const first = await runSendFailureDigest(db.supabase, NINE_THIRTY_IST);
    expect(first).toEqual({ workspaces: 2, queued: 1, skipped_off: 1, skipped_sent: 0 });
    const rows = db.rows("billing_notifications");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organization_id: ORG,
      kind: "send_failures",
      channel: "email",
      audience: "client",
      recipient: "owner@zoori.test",
      status: "queued",
    });
    const payload = rows[0]!["payload"] as {
      total: number;
      copies: number;
      lines: Array<Record<string, unknown>>;
    };
    expect([payload.total, payload.copies]).toEqual([3, 1]);
    expect(payload.lines.map((l) => [l["number"], l["source"], l["reason"]])).toEqual(
      expect.arrayContaining([
        ["+919876543210", "API", "Not on WhatsApp (or can't receive messages) (131026)"],
        ["+918121310333", "API", "Not on WhatsApp (or can't receive messages) (131026)"],
        [
          "+919876543210",
          "Campaign",
          "WhatsApp held back this marketing message for this customer (131049)",
        ],
      ]),
    );
    // A second sweep the same day queues nothing more.
    expect((await runSendFailureDigest(db.supabase, NINE_THIRTY_IST + 3600e3)).queued).toBe(0);
    expect(db.rows("billing_notifications")).toHaveLength(1);
  });

  it("nothing before 09:00 IST, and nothing on a day without failures", async () => {
    const { runSendFailureDigest } = await import("./send-failure-digest.server");
    expect(
      (await runSendFailureDigest(world().supabase, Date.parse("2026-11-03T03:00:00.000Z"))).queued,
    ).toBe(0);
    const empty = memoryDb({ messages: [], billing_notifications: [] });
    expect(await runSendFailureDigest(empty.supabase, NINE_THIRTY_IST)).toEqual({
      workspaces: 0,
      queued: 0,
      skipped_off: 0,
      skipped_sent: 0,
    });
  });

  it("without an alert email it goes to the owners and admins (owners first, at most 3)", async () => {
    const db = world();
    db.rows("organization_ai_settings").length = 0;
    db.rows("organization_members").push(
      { organization_id: ORG, user_id: "u-admin", role: "admin" },
      { organization_id: ORG, user_id: "u-owner", role: "owner" },
      { organization_id: ORG, user_id: "u-agent", role: "agent" },
    );
    db.rows("profiles").push(
      { id: "u-admin", email: "admin@zoori.test" },
      { id: "u-owner", email: "founder@zoori.test" },
      { id: "u-agent", email: "agent@zoori.test" },
    );
    const { runSendFailureDigest } = await import("./send-failure-digest.server");
    await runSendFailureDigest(db.supabase, NINE_THIRTY_IST);
    expect(db.rows("billing_notifications").map((r) => r["recipient"])).toEqual([
      "founder@zoori.test",
      "admin@zoori.test",
    ]);
  });

  it("the email drain has words for it (emailNoticeContent)", async () => {
    const { emailNoticeContent } = await import("./email-notices.server");
    const content = await emailNoticeContent(memoryDb().supabase, {
      kind: "send_failures",
      payload: {
        workspace: "ZOORI Jewels INDIA",
        total: 6,
        lines: [
          {
            at: "2026-11-02T05:00:00.000Z",
            number: "+919876543210",
            template: "invoice_ready",
            source: "API",
            reason: "Not on WhatsApp (131026)",
            copy: false,
          },
        ],
        link: "https://aidwar.in/app/templates",
      },
    });
    expect(content?.subject).toBe("6 WhatsApp messages couldn't be delivered — ZOORI Jewels INDIA");
    expect(content?.body).toContain(
      "+919876543210 — invoice_ready — API — Not on WhatsApp (131026)",
    );
    expect(content?.body).toContain("…and 5 more.");
    expect(content?.body).toContain("Settings → Notifications");
  });
});

describe("plain words for Meta's errors", () => {
  it("reads Meta's JSON, our own text, or nothing", () => {
    expect(parseErrorDetail(JSON.stringify(ERR_131026)).code).toBe("131026");
    expect(failureReason(JSON.stringify(ERR_131026))).toBe(
      "Not on WhatsApp (or can't receive messages) (131026)",
    );
    expect(failureReason(JSON.stringify([{ code: 999, title: "Something new" }]))).toBe(
      "Something new (999)",
    );
    expect(failureReason("unknown_error")).toBe("unknown_error");
    expect(failureReason(null)).toBe("Not delivered");
  });
});
