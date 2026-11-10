import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memoryDb } from "./test-support/memory-db";
import {
  NO_SEND_FILTERS,
  canDownloadSends,
  dateBounds,
  nestCopies,
  sendSourceOf,
  sendsCsv,
  totalsFrom,
  type SendRow,
} from "./template-sends";
import { loadAllTemplateSends, loadTemplateSends } from "./template-sends-data";

/**
 * Batch 63 (C): a template's "Sent" report — every send from any source
 * (API, campaign, flow, Inbox), API copies nested under the customer's send,
 * filters, totals and a CSV. Reads messages rows only.
 */

const ORG = "81c234b2-569f-40be-ad71-96c046de5d12";
const ERR = JSON.stringify([{ code: 131026, title: "Message undeliverable" }]);
const at = (h: number) =>
  new Date(Date.parse("2026-11-02T04:00:00.000Z") + h * 3600e3).toISOString();
const contact = (name: string | null, phone: string) => ({
  contact_id: `c-${phone}`,
  contacts: { id: `c-${phone}`, name, phone },
});

function msg(
  id: string,
  over: Partial<SendRow> & Record<string, unknown> = {},
): Record<string, unknown> {
  return {
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
    metadata: {},
    created_at: at(0),
    conversations: contact("Asha", "+919876543210"),
    ...over,
  };
}

const rows = [
  // API invoice with two copies (Batch 61)
  msg("api-1", {
    created_at: at(5),
    status: "read",
    metadata: {
      source: "api",
      idempotency_key: "INV-1001",
      document_filename: "INV-1001.pdf",
      to: "+919876543210",
    },
  }),
  msg("cc-1", {
    created_at: at(5.01),
    status: "delivered",
    metadata: { source: "api", copy: true, cc_of: "api-1", to: "+918121310333" },
    conversations: contact(null, "+918121310333"),
  }),
  msg("cc-2", {
    created_at: at(5.02),
    status: "failed",
    error_detail: ERR,
    metadata: { source: "api", copy: true, cc_of: "api-1", to: "+919121883067" },
    conversations: contact(null, "+919121883067"),
  }),
  // API send to a number not on WhatsApp
  msg("api-2", {
    created_at: at(4),
    status: "failed",
    error_detail: ERR,
    metadata: { source: "api", idempotency_key: "INV-1002" },
    conversations: contact("Ravi", "+919000000002"),
  }),
  msg("camp-1", {
    created_at: at(3),
    status: "sent",
    campaign_id: "cmp-1",
    conversations: contact("Meena", "+919000000003"),
  }),
  msg("flow-1", {
    created_at: at(2),
    status: "delivered",
    flow_id: "flow-1",
    metadata: { kind: "flow_v2", run_id: "r1" },
  }),
  msg("inbox-1", { created_at: at(1), status: "read", sent_by: "u-staff" }),
  msg("other-template", { template_name: "order_shipped" }),
  msg("inbound", { direction: "inbound" }),
];

const db = () =>
  memoryDb({
    messages: rows,
    campaigns: [{ id: "cmp-1", organization_id: ORG, name: "Diwali offer" }],
  });

describe("where a send came from", () => {
  it("API (incl. the console), campaign, flow, Inbox, else automation", () => {
    expect(
      sendSourceOf({
        metadata: { source: "api" },
        campaign_id: null,
        flow_id: null,
        sent_by: null,
      }),
    ).toBe("api");
    expect(
      sendSourceOf({
        metadata: { source: "api_console" },
        campaign_id: null,
        flow_id: null,
        sent_by: null,
      }),
    ).toBe("api");
    expect(sendSourceOf({ metadata: {}, campaign_id: "c", flow_id: null, sent_by: null })).toBe(
      "campaign",
    );
    expect(
      sendSourceOf({
        metadata: { kind: "flow_v2" },
        campaign_id: null,
        flow_id: null,
        sent_by: null,
      }),
    ).toBe("flow");
    expect(sendSourceOf({ metadata: {}, campaign_id: null, flow_id: null, sent_by: "u" })).toBe(
      "inbox",
    );
    expect(sendSourceOf({ metadata: null, campaign_id: null, flow_id: null, sent_by: null })).toBe(
      "other",
    );
  });
});

describe("the report", () => {
  it("lists every send of the template, newest first, copies under their customer send, with references and reasons", async () => {
    const r = await loadTemplateSends(db().supabase as never, {
      organizationId: ORG,
      templateName: "invoice_ready",
      filters: NO_SEND_FILTERS,
    });
    expect(r.error).toBeNull();
    expect(r.lines.map((l) => [l.id, l.source, l.status])).toEqual([
      ["api-1", "api", "read"],
      ["api-2", "api", "failed"],
      ["camp-1", "campaign", "sent"],
      ["flow-1", "flow", "delivered"],
      ["inbox-1", "inbox", "read"],
    ]);
    const api = r.lines[0]!;
    // The invoice file already carries the key: the key alone.
    expect(api.reference).toBe("INV-1001");
    expect(api.customer).toBe("Asha");
    expect(api.copies.map((c) => [c.id, c.phone, c.status, c.reason])).toEqual([
      ["cc-1", "+918121310333", "delivered", null],
      ["cc-2", "+919121883067", "failed", "Not on WhatsApp (or can't receive messages) (131026)"],
    ]);
    expect(r.lines[1]!.reason).toBe("Not on WhatsApp (or can't receive messages) (131026)");
    expect(r.lines[2]!.reference).toBe("Diwali offer");
  });

  it("totals: sent counts every accepted message (delivered and read too), delivered includes read; copies apart", async () => {
    const r = await loadTemplateSends(db().supabase as never, {
      organizationId: ORG,
      templateName: "invoice_ready",
      filters: NO_SEND_FILTERS,
    });
    // Batch 67: totals also count refused API sends (none here).
    expect(r.totals).toEqual({ sent: 4, delivered: 3, read: 2, failed: 1, copies: 2, refused: 0 });
    expect(totalsFrom({ sent: 1, delivered: 2, read: 3, failed: 4 }, 5)).toEqual({
      sent: 6,
      delivered: 5,
      read: 3,
      failed: 4,
      copies: 5,
      refused: 0,
    });
  });

  it("filters: source, status, failed only, dates (India days)", async () => {
    const load = (f: Partial<typeof NO_SEND_FILTERS>) =>
      loadTemplateSends(db().supabase as never, {
        organizationId: ORG,
        templateName: "invoice_ready",
        filters: { ...NO_SEND_FILTERS, ...f },
      }).then((r) => r.lines.map((l) => l.id));
    expect(await load({ source: "api" })).toEqual(["api-1", "api-2"]);
    expect(await load({ source: "campaign" })).toEqual(["camp-1"]);
    expect(await load({ source: "flow" })).toEqual(["flow-1"]);
    expect(await load({ source: "inbox" })).toEqual(["inbox-1"]);
    expect(await load({ status: "read" })).toEqual(["api-1", "inbox-1"]);
    expect(await load({ failedOnly: true, status: "read" })).toEqual(["api-2"]);
    expect(dateBounds({ from: "2026-11-02", to: "2026-11-02" })).toEqual({
      gte: "2026-11-01T18:30:00.000Z",
      lt: "2026-11-02T18:30:00.000Z",
    });
    expect(await load({ from: "2026-11-03" })).toEqual([]);
  });

  it("a copy whose customer send isn't on the page still shows (as a copy), never hidden", () => {
    const lines = nestCopies([], [rows[1] as unknown as SendRow]);
    expect(lines.map((l) => [l.id, l.copy])).toEqual([["cc-1", true]]);
  });

  it("CSV: one row per send, copies right under it with copy_of; formula-looking cells defused", async () => {
    const all = await loadAllTemplateSends(db().supabase as never, {
      organizationId: ORG,
      templateName: "invoice_ready",
      filters: NO_SEND_FILTERS,
    });
    const csv = sendsCsv("invoice_ready", all).trim().split("\n");
    expect(csv[0]).toBe(
      "sent_at,template,source,customer,phone,reference,status,failure_reason,copy_of",
    );
    expect(csv).toHaveLength(1 + 7);
    expect(csv[1]).toContain(",API,Asha,+919876543210,INV-1001,Read,,");
    expect(csv[2]).toMatch(/,API,\+918121310333,\+918121310333,,Delivered,,api-1$/);
    expect(sendsCsv("t", [{ ...all[0]!, customer: "=HYPERLINK(1)", copies: [] }])).toContain(
      ",'=HYPERLINK(1),",
    );
    expect(csv[3]).toContain("Failed,Not on WhatsApp (or can't receive messages) (131026),api-1");
    expect(canDownloadSends("owner")).toBe(true);
    expect(canDownloadSends("agent")).toBe(false);
  });
});

describe("both designs open the same report; it writes nothing", () => {
  const src = (p: string) => readFileSync(`src/${p}`, "utf8");
  it("Classic's list and Aiden Workspace's gallery each open TemplateSentReport", () => {
    expect(src("components/templates/templates-view.tsx")).toContain("<TemplateSentReport");
    expect(src("components/templates-v2/new-templates.tsx")).toContain("<TemplateSentReport");
  });
  it("the report and its reads never write a table (only the summary switch posts to /api/template-sends)", () => {
    const code =
      src("lib/template-sends-data.ts") + src("components/templates/template-sent-report.tsx");
    expect(code).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    expect(src("components/templates/send-failure-summary-switch.tsx")).toContain(
      '"/api/template-sends"',
    );
  });
  it("CSV is gated on contacts.export (owners and admins by default)", () => {
    expect(src("components/templates/template-sent-report.tsx")).toContain(
      'can("contacts.export")',
    );
  });
});
