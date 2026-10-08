import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

/**
 * Batch 27 — hand-off reminders and templates.
 *
 *  M6  a staff reply from the Inbox stops the 30-minute reminder; the chat
 *      stays with the person (needs_human untouched, Aiden stays off).
 *  Low a second hand-off on the same chat gets its own reminder.
 *  M12 the template sync reads every page; Meta's statuses map onto ours.
 */

const h = vi.hoisted(() => ({
  db: null as null | { supabase: unknown },
  graphFetch: vi.fn(async () => ({ ok: true, status: 200, body: { messages: [{ id: "wamid.1" }] } })),
}));
vi.mock("@/lib/whatsapp-api.server", () => ({
  requireOrgMember: async () => ({ supabase: h.db!.supabase, organizationId: "org", userId: "u1" }),
  requirePermission: async () => null,
  isResponse: (v: unknown) => v instanceof Response,
  jsonError: (message: string, status = 400) => Response.json({ error: message }, { status }),
  graphFetch: h.graphFetch,
  graphErrorMessage: () => "error",
  logServerActivity: async () => {},
  providerErrorDetail: () => null,
  providerErrorCode: () => null,
  normalizePhone: (p: string) => `+${String(p).replace(/\D/g, "")}`,
  toWaId: (p: string) => String(p ?? "").replace(/\D/g, ""),
  listWabaConnections: async () => [{ wabaId: "waba", accessToken: "t" }],
}));
vi.mock("@/lib/whatsapp-numbers.server", () => ({
  getWhatsAppConnection: async () => ({
    connection: { accountId: "acc", wabaId: "waba", phoneNumberId: "pn", accessToken: "t" },
    error: null,
  }),
  listWabaConnections: async () => [{ wabaId: "waba", accessToken: "t" }],
}));
vi.mock("@/lib/events.server", () => {
  const noop = async () => {};
  return { emitEvent: noop, recordUsage: noop };
});

import { Route as SendMessage } from "../routes/api/whatsapp/send-message";
import { remindWaitingHandoffs, sendHandoffAlert, staffReplied } from "./handoff-alerts.server";
import { fetchAllTemplatePages, metaTemplateStatus, TEMPLATE_SYNC_MAX_PAGES } from "./templates";

type Post = (a: { request: Request }) => Promise<Response>;
const postOf = (r: unknown) => (r as { options: { server: { handlers: { POST: Post } } } }).options.server.handlers.POST;

beforeEach(() => h.graphFetch.mockClear());

/** Reminders may go at any hour (so the tests don't depend on the clock). */
const ALWAYS_OPEN = { days: Object.fromEntries(["0", "1", "2", "3", "4", "5", "6"].map((d) => [d, ["00:00", "24:00"]])), holidays: [] };

/** One conversation row; conditional updates behave like the database's. */
function chat(row: Record<string, unknown>, hours: unknown = ALWAYS_OPEN) {
  const conv: Record<string, unknown> = { id: "cv1", contact_id: "c1", whatsapp_account_id: "acc", last_customer_message_at: new Date().toISOString(), ...row };
  const matches = (op: FakeOp) =>
    op.filters.every(([n, a]) => {
      if (n === "eq") return a[0] === "id" ? a[1] === conv["id"] : conv[a[0] as string] === a[1];
      if (n === "is") return (conv[a[0] as string] ?? null) === a[1];
      return true;
    });
  const db = fakeDb((op) => {
    if (op.table === "conversations" && op.kind === "update") {
      if (matches(op)) Object.assign(conv, op.payload as object);
      return { data: null, error: null };
    }
    if (op.table === "conversations" && op.kind === "select") {
      if (String(op.select?.[0] ?? "").includes("needs_human_reason"))
        return { data: conv["needs_human"] === true && !conv["handoff_reminded_at"] && conv["handoff_alert_at"] ? [conv] : [], error: null };
      return { data: conv, error: null };
    }
    if (op.table === "contacts") return { data: { phone: "+919800000001", wa_id: "919800000001" }, error: null };
    if (op.table === "messages") return { data: { id: "m1", status: "pending" }, error: null };
    if (op.table === "organization_ai_settings")
      return { data: { handoff_alert_phones: [], handoff_alert_email: "staff@shop.test", handoff_alert_hours: hours }, error: null };
    return undefined;
  });
  return { db, conv };
}

const deps = { sendEmail: vi.fn(async () => true), channelFor: async () => null, sendTemplate: async () => false };

describe("M6: a staff reply from the Inbox stops the reminder; the chat stays with the person", () => {
  const waiting = () => ({
    needs_human: true,
    needs_human_reason: "asked_for_person",
    assigned_to: null,
    handoff_alert_at: new Date(Date.now() - 31 * 60_000).toISOString(),
    handoff_reminded_at: null,
  });

  it("staff reply (send-message) → no reminder at 30 min; needs_human untouched", async () => {
    const { db, conv } = chat(waiting());
    h.db = db;
    const res = await postOf(SendMessage)({
      request: new Request("http://x", {
        method: "POST",
        body: JSON.stringify({ organization_id: "org", conversation_id: "cv1", message_type: "text", body: "Hi, Asha here from the shop" }),
      }),
    });
    expect(res.status).toBe(200);
    expect(conv["handoff_reminded_at"]).toBeTruthy();
    expect(conv["needs_human"]).toBe(true);

    deps.sendEmail.mockClear();
    const reminded = await remindWaitingHandoffs(db.supabase, new Date(), deps);
    expect(reminded).toBe(0);
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("without a staff reply the reminder still goes, once (unchanged)", async () => {
    const { db, conv } = chat(waiting());
    deps.sendEmail.mockClear();
    expect(await remindWaitingHandoffs(db.supabase, new Date(), deps)).toBe(1);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(conv["handoff_reminded_at"]).toBeTruthy();
    expect(await remindWaitingHandoffs(db.supabase, new Date(), deps)).toBe(0);
  });

  it("staffReplied only touches a chat that waits on a person with a reminder pending", async () => {
    const idle = chat({ needs_human: false, handoff_reminded_at: null });
    await staffReplied(idle.db.supabase, "cv1");
    expect(idle.conv["handoff_reminded_at"]).toBeNull();

    const write = idle.db.ops.find((o) => o.table === "conversations" && o.kind === "update")!;
    expect(idle.db.has(write, "eq", "needs_human", true)).toBe(true);
    expect(idle.db.has(write, "is", "handoff_reminded_at", null)).toBe(true);
    expect(Object.keys(write.payload as object)).toEqual(["handoff_reminded_at"]);

    await expect(staffReplied(fakeDb(() => { throw new Error("down"); }).supabase, "cv1")).resolves.toBeUndefined();
    await expect(staffReplied(idle.db.supabase, null)).resolves.toBeUndefined();
  });
});

describe("Low: each hand-off gets its own reminder", () => {
  it("a new alert clears the previous hand-off's reminder mark", async () => {
    const { db, conv } = chat({
      needs_human: true,
      handoff_alert_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
      handoff_reminded_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
    });
    await sendHandoffAlert(db.supabase, { organizationId: "org", conversationId: "cv1", reason: "asked_for_person" }, deps);
    expect(conv["handoff_reminded_at"]).toBeNull();
    expect(Date.parse(String(conv["handoff_alert_at"]))).toBeGreaterThan(Date.now() - 60_000);
  });

  it("a reminder itself still marks the reminder sent", async () => {
    const { db, conv } = chat({ needs_human: true, handoff_reminded_at: null, handoff_alert_at: new Date().toISOString() });
    await sendHandoffAlert(db.supabase, { organizationId: "org", conversationId: "cv1", reason: "", reminder: true }, deps);
    expect(conv["handoff_reminded_at"]).toBeTruthy();
  });
});

describe("M12: template statuses and the full listing", () => {
  it("Meta's statuses map onto the four the table holds", () => {
    expect(metaTemplateStatus("APPROVED")).toBe("APPROVED");
    expect(metaTemplateStatus("disabled")).toBe("PAUSED");
    expect(metaTemplateStatus("DELETED")).toBe("PAUSED");
    expect(metaTemplateStatus("PENDING_DELETION")).toBe("PAUSED");
    expect(metaTemplateStatus("REINSTATED")).toBe("APPROVED");
    expect(metaTemplateStatus("IN_APPEAL")).toBe("PENDING");
    expect(metaTemplateStatus("")).toBeNull();
    expect(metaTemplateStatus("WHATEVER")).toBeNull();
  });

  const page = (n: number, next: boolean) => ({
    ok: true,
    body: {
      data: Array.from({ length: 200 }, (_, i) => ({ id: `${n}-${i}`, name: `t_${n}_${i}`, status: "APPROVED" })),
      ...(next ? { paging: { cursors: { after: `cur${n}` }, next: `https://graph/next${n}` } } : { paging: { cursors: { after: `cur${n}` } } }),
    },
  });

  it("follows the cursor through every page (the sync used to stop at 200)", async () => {
    const afters: Array<string | null> = [];
    const all = await fetchAllTemplatePages(async (after) => {
      afters.push(after);
      const n = afters.length;
      return page(n, n < 3);
    });
    expect(all.rows).toHaveLength(600);
    expect(all.error).toBeNull();
    expect(afters).toEqual([null, "cur1", "cur2"]);
  });

  it("a failed later page keeps what was read and reports the error; it never loops forever", async () => {
    let n = 0;
    const partial = await fetchAllTemplatePages(async () => (++n === 1 ? page(1, true) : { ok: false, body: { error: { message: "rate" } } }));
    expect(partial.rows).toHaveLength(200);
    expect(partial.error).toEqual({ error: { message: "rate" } });

    let calls = 0;
    const endless = await fetchAllTemplatePages(async () => {
      calls += 1;
      return { ok: true, body: { data: [], paging: { cursors: { after: `c${calls}` }, next: "x" } } };
    });
    expect(calls).toBe(TEMPLATE_SYNC_MAX_PAGES);
    expect(endless.pages).toBe(TEMPLATE_SYNC_MAX_PAGES);
  });

  it("the sync route stores a DISABLED template as PAUSED and reads page two", async () => {
    const upserts: Array<Record<string, unknown>> = [];
    h.db = fakeDb((op) => {
      if (op.table === "message_templates" && op.kind === "upsert") {
        upserts.push(op.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      if (op.table === "message_templates") return { data: [], error: null };
      return undefined;
    });
    h.graphFetch.mockImplementation((async (_path: string, _t: string, init?: { query?: Record<string, string> }) =>
      init?.query?.["after"]
        ? { ok: true, status: 200, body: { data: [{ id: "2", name: "second_page", language: "en_US", status: "DISABLED" }] } }
        : {
            ok: true,
            status: 200,
            body: {
              data: [{ id: "1", name: "first_page", language: "en_US", status: "APPROVED" }],
              paging: { cursors: { after: "cur" }, next: "https://graph/next" },
            },
          }) as never);
    const { Route: Templates } = await import("../routes/api/whatsapp/templates");
    const res = await postOf(Templates)({
      request: new Request("http://x", { method: "POST", body: JSON.stringify({ organization_id: "org", action: "sync" }) }),
    });
    expect(res.status).toBe(200);
    expect(upserts.map((u) => [u["name"], u["status"]])).toEqual([
      ["first_page", "APPROVED"],
      ["second_page", "PAUSED"],
    ]);
  });
});
