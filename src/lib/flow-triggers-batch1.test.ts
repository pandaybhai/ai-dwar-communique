import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type FakeOp } from "./test-support/fake-db";

const startRun = vi.fn(async (_db: unknown, _a: { contactId: string; flowId: string }) => ({ runId: "run-new", reason: null as string | null }));
vi.mock("@/lib/flow-engine.server", () => ({
  startRun: (db: unknown, a: { contactId: string; flowId: string }) => startRun(db, a),
  flowsV2Enabled: async () => true,
  readPublishedVersion: async () => null,
}));

import { dispatchInboundTriggers, dispatchNoReply, dispatchTagAdded, keywordMatches } from "./flow-triggers.server";

beforeEach(() => startRun.mockClear());
const started = () => startRun.mock.calls.map((c) => c[1].contactId);

describe("no reply for N days (item 3)", () => {
  const trigger = { id: "trig-1", organization_id: "org", flow_id: "flow-1", kind: "no_reply", config: { days: 3 } };
  function world(opts: { pages: string[][]; fired?: Set<string>; active?: Set<string> }) {
    return fakeDb((op: FakeOp) => {
      if (op.table === "flow_triggers") return { data: [trigger], error: null };
      if (op.table === "conversations" && op.filters.some(([f]) => f === "range")) {
        const [from] = op.filters.find(([f]) => f === "range")![1] as [number];
        const page = opts.pages[from / 200] ?? [];
        return { data: page.map((c) => ({ id: `conv-${c}`, contact_id: c, last_customer_message_at: "2026-01-01T00:00:00Z" })), error: null };
      }
      if (op.table === "conversations") return { data: [], error: null }; // nobody assigned
      const ids = (op.filters.find(([f, a]) => f === "in" && a[0] === "contact_id")?.[1][1] ?? []) as string[];
      if (op.table === "flow_trigger_fires") return { data: ids.filter((i) => opts.fired?.has(i)).map((contact_id) => ({ contact_id })), error: null };
      if (op.table === "flow_runs") return { data: ids.filter((i) => opts.active?.has(i)).map((contact_id) => ({ contact_id })), error: null };
      return undefined;
    });
  }
  const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => `c${a + i}`);

  it("pages past contacts that already fired instead of re-picking the same ones", async () => {
    const db = world({ pages: [range(0, 200), range(200, 230)], fired: new Set(range(0, 200)) });
    const out = await dispatchNoReply(db.supabase);
    expect(out.started).toBe(25);
    expect(started()).toEqual(range(200, 225));
  });

  it("only considers conversations where the customer has written at least once", async () => {
    const db = world({ pages: [range(0, 3)] });
    await dispatchNoReply(db.supabase);
    const q = db.ops.find((o) => o.table === "conversations" && o.filters.some(([f]) => f === "range"))!;
    expect(db.has(q, "not", "last_customer_message_at", "is", null)).toBe(true);
    expect(q.filters.some(([f]) => f === "or")).toBe(false);
  });

  it("unchanged: never fires twice for a contact, skips busy contacts, max 25 per tick", async () => {
    const db = world({ pages: [range(0, 60)], fired: new Set(["c0"]), active: new Set(["c1"]) });
    await dispatchNoReply(db.supabase);
    expect(started()).not.toContain("c0");
    expect(started()).not.toContain("c1");
    expect(started()).toHaveLength(25);
    expect(started()[0]).toBe("c2");
  });
});

describe("human takeover (item 8)", () => {
  const kw = { id: "t-kw", flow_id: "flow-kw", kind: "keyword", config: { keywords: ["menu"], match: "exact" }, flows: { whatsapp_account_id: null } };
  const inboundDb = (assigned: boolean) =>
    fakeDb((op) => {
      if (op.table === "flow_triggers") return { data: [kw], error: null };
      if (op.table === "conversations") return { data: assigned ? [{ id: "conv-1" }] : [], error: null };
      return undefined;
    });
  const args = { organizationId: "org", contactId: "c1", conversationId: "conv-1", body: "menu", isFirstMessageEver: false, isCtwa: false, campaignButton: null };

  it("a conversation a teammate has taken over never starts a flow", async () => {
    const db = inboundDb(true);
    expect(await dispatchInboundTriggers(db.supabase, args)).toEqual({ started: false });
    expect(startRun).not.toHaveBeenCalled();
    const q = db.ops.find((o) => o.table === "conversations")!;
    expect(db.has(q, "eq", "id", "conv-1")).toBe(true);
    expect(db.has(q, "not", "assigned_to", "is", null)).toBe(true);
  });

  it("unchanged: an unassigned conversation starts the keyword flow", async () => {
    expect(await dispatchInboundTriggers(inboundDb(false).supabase, args)).toEqual({ started: true, flowId: "flow-kw" });
  });

  it("tag triggers skip a contact whose open conversation a teammate owns", async () => {
    const tagTrig = { id: "t-tag", flow_id: "flow-tag", kind: "tag_added", config: { tag: "vip" } };
    const db = fakeDb((op) => {
      if (op.table === "flow_triggers") return { data: [tagTrig], error: null };
      if (op.table === "conversations") return { data: [{ id: "conv-9" }], error: null };
      return undefined;
    });
    await dispatchTagAdded(db.supabase, { organizationId: "org", contactId: "c1", tag: "vip" });
    expect(startRun).not.toHaveBeenCalled();
    const q = db.ops.find((o) => o.table === "conversations")!;
    expect(db.has(q, "eq", "contact_id", "c1") && db.has(q, "eq", "status", "open")).toBe(true);
  });
});

describe("keywords while a run is still active (item 11)", () => {
  const kw = { id: "t-kw", flow_id: "flow-other", kind: "keyword", config: { keywords: ["menu"], match: "exact" }, flows: { whatsapp_account_id: null } };
  const btn = { id: "t-btn", flow_id: "flow-btn", kind: "campaign_button", config: { campaign_id: null, button: "Yes" }, flows: { whatsapp_account_id: null } };
  const db = () => fakeDb((op) => (op.table === "flow_triggers" ? { data: [kw, btn], error: null } : op.table === "conversations" ? { data: [], error: null } : undefined));
  const base = { organizationId: "org", contactId: "c1", conversationId: "conv-1", isFirstMessageEver: false, isCtwa: false, campaignButton: null };

  it("skipKeywords: a keyword never starts a different flow", async () => {
    expect(await dispatchInboundTriggers(db().supabase, { ...base, body: "menu", skipKeywords: true })).toEqual({ started: false });
    expect(startRun).not.toHaveBeenCalled();
  });

  it("unchanged: without an active run the keyword starts its flow", async () => {
    expect(await dispatchInboundTriggers(db().supabase, { ...base, body: "menu" })).toEqual({ started: true, flowId: "flow-other" });
  });

  it("unchanged: campaign buttons are not affected by skipKeywords", async () => {
    const out = await dispatchInboundTriggers(db().supabase, { ...base, body: "Yes", skipKeywords: true, campaignButton: { campaignId: "camp", button: "Yes" } });
    expect(out).toEqual({ started: true, flowId: "flow-btn" });
  });
});

describe("keyword matching (item 9: existing triggers unchanged)", () => {
  it("a trigger saved without a match mode still matches 'contains'", () => {
    expect(keywordMatches({ keywords: ["menu"] }, "show me the menu")).toBe(true);
  });
});
